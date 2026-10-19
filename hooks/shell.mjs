// Parse a Bash command string into simple commands so a hook can look at what actually runs in command position.
// Arguments to echo/printf/jq and quoted heredoc bodies stay data. Command substitutions ($(…), `…`, <(…), >(…))
// are parsed recursively, also inside double quotes and unquoted heredoc bodies, because the shell runs them.
// An approximation for guard hooks, not a full shell parser. It never throws on malformed input. No dependencies.
//
// parse(src) returns the top-level commands. Each command:
//   words     words with quotes removed; a substitution keeps its source text, e.g. "$(pgrep node)"
//   info[i]   { vars, subs, redir } for words[i]: variables it references ($NAME, ${NAME…}), the substitutions in it
//             ({ kind: "cmd" | "proc" | "array", commands }), and whether it is a redirection operator or target
//   pipeline  id shared by the commands of one pipeline (a | b); stage is the position in it
//   heredocs  [{ text, expand, subs }] bodies of the heredocs the command reads
// flatten(commands) lists every command, substitutions first (they run before the command that contains them).

const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ANSI_ESCAPES = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"' };

const newAcc = () => ({ value: "", vars: [], subs: [] });

export function parse(src) {
  const st = { text: typeof src === "string" ? src : String(src ?? ""), counter: { n: 0 } };
  return parseList(st, 0, null).commands;
}

// Index of the ")" closing the "(" at text[i], counting nested parentheses (text.length if there is none)
function closeParen(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return j;
  }
  return text.length;
}

// $NAME, ${…}, $(…), $((…)) or `…` starting at text[i]. Appends to acc; returns the index of the last character used.
function expansion(st, i, acc) {
  const { text } = st;
  if (text[i] === "`") {
    const r = parseList(st, i + 1, "`");
    acc.subs.push({ kind: "cmd", commands: r.commands });
    acc.value += text.slice(i, r.end + 1);
    return r.end;
  }
  const next = text[i + 1];
  if (next === "(" && text[i + 2] === "(") {
    // arithmetic, not a command
    const end = closeParen(text, i + 1);
    acc.value += text.slice(i, end + 1);
    return end;
  }
  if (next === "(") {
    const r = parseList(st, i + 2, ")");
    acc.subs.push({ kind: "cmd", commands: r.commands });
    acc.value += text.slice(i, r.end + 1);
    return r.end;
  }
  if (next === "{") {
    // the rest of ${…} is read by the caller, so a $(…) inside it is still found
    const m = /^[#!]?([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + 2, i + 130));
    if (m) acc.vars.push(m[1]);
    acc.value += "${";
    return i + 1;
  }
  const m = VAR_NAME.exec(text.slice(i + 1, i + 130));
  if (m) {
    acc.vars.push(m[0]);
    acc.value += "$" + m[0];
    return i + m[0].length;
  }
  acc.value += "$";
  return i;
}

// The inside of "…" from index i up to the terminator (null: to the end, for heredoc bodies). Returns its index.
function doubleQuoted(st, i, acc, terminator) {
  const { text } = st;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === terminator) return i;
    if (ch === "\\" && i + 1 < text.length) {
      const n = text[i + 1];
      if (n !== "\n") acc.value += '$`"\\'.includes(n) ? n : ch + n;
      i++;
    } else if (ch === "$" || ch === "`") {
      i = expansion(st, i, acc);
    } else {
      acc.value += ch;
    }
  }
  return text.length;
}

// Commands from index start until stop (")" or "`", unmatched) or the end. Returns { commands, end: index of stop }.
function parseList(st, start, stop) {
  const { text } = st;
  const commands = [];
  const pending = []; // heredocs whose bodies start after the next newline
  let depth = 0; // ( … ) groups opened in this list
  let cmd = { words: [], info: [], heredocs: [], pipeline: st.counter.n++, stage: 0 };
  let acc = newAcc();
  let inWord = false;
  let redirTarget = false;

  const endWord = () => {
    if (inWord) {
      cmd.words.push(acc.value);
      cmd.info.push({ vars: acc.vars, subs: acc.subs, redir: redirTarget });
      redirTarget = false;
    }
    acc = newAcc();
    inWord = false;
  };
  const pushOperator = (op, takesTarget) => {
    endWord();
    cmd.words.push(op);
    cmd.info.push({ vars: [], subs: [], redir: true });
    redirTarget = takesTarget;
  };
  // "list": ; & && || newline start a new pipeline. "pipe": | moves to the next stage. "group": ( ) keep both
  const endCommand = (kind) => {
    endWord();
    redirTarget = false;
    if (cmd.words.length) commands.push(cmd);
    const pipeline = kind === "list" ? st.counter.n++ : cmd.pipeline;
    const stage = kind === "pipe" ? cmd.stage + 1 : kind === "list" ? 0 : cmd.stage;
    cmd = { words: [], info: [], heredocs: [], pipeline, stage };
  };
  const readHeredocs = (pos) => {
    while (pending.length) {
      const h = pending.shift();
      let body = "";
      while (pos < text.length) {
        let nl = text.indexOf("\n", pos);
        if (nl < 0) nl = text.length;
        const line = text.slice(pos, nl);
        pos = nl + 1;
        if ((h.dash ? line.replace(/^\t+/, "") : line) === h.tag) break;
        body += line + "\n";
      }
      const doc = { text: body, expand: h.expand, subs: [] };
      if (h.expand) {
        const bodyAcc = newAcc();
        doubleQuoted({ text: body, counter: st.counter }, 0, bodyAcc, null);
        doc.subs = bodyAcc.subs;
      }
      h.cmd.heredocs.push(doc);
    }
    return pos;
  };

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "`" && stop === "`") {
      endCommand("group");
      return { commands, end: i };
    }
    if (ch === "\\") {
      if (next !== undefined && next !== "\n") (acc.value += next), (inWord = true);
      i++;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stopAt = end < 0 ? text.length : end;
      acc.value += text.slice(i + 1, stopAt);
      inWord = true;
      i = stopAt;
    } else if (ch === '"') {
      i = doubleQuoted(st, i + 1, acc, '"');
      inWord = true;
    } else if (ch === "$" && next === "'") {
      // $'…' with backslash escapes
      let j = i + 2;
      for (; j < text.length && text[j] !== "'"; j++) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const e = text[++j];
          acc.value += ANSI_ESCAPES[e] ?? "\\" + e;
        } else acc.value += text[j];
      }
      inWord = true;
      i = j;
    } else if (ch === "$" || ch === "`") {
      i = expansion(st, i, acc);
      inWord = true;
    } else if (ch === "#" && !inWord) {
      const nl = text.indexOf("\n", i);
      i = (nl < 0 ? text.length : nl) - 1;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === "\n") {
      endCommand("list");
      if (pending.length) i = readHeredocs(i + 1) - 1;
    } else if (ch === ";") {
      endCommand("list");
    } else if (ch === "&") {
      if (next === ">") {
        const op = text[i + 2] === ">" ? "&>>" : "&>";
        pushOperator(op, true);
        i += op.length - 1;
      } else {
        endCommand("list");
        if (next === "&") i++;
      }
    } else if (ch === "|") {
      if (next === "|") {
        endCommand("list");
        i++;
      } else {
        endCommand("pipe");
        if (next === "&") i++;
      }
    } else if ((ch === "<" || ch === ">") && next === "(") {
      const r = parseList(st, i + 2, ")");
      acc.subs.push({ kind: "proc", commands: r.commands });
      acc.value += text.slice(i, r.end + 1);
      inWord = true;
      i = r.end;
    } else if (ch === "<" || ch === ">") {
      let fd = "";
      if (inWord && /^\d+$/.test(acc.value)) (fd = acc.value), (acc = newAcc()), (inWord = false);
      const ops = ch === "<" ? ["<<<", "<<-", "<<", "<>", "<&", "<"] : [">>", ">&", ">|", ">"];
      const op = ops.find((o) => text.startsWith(o, i));
      i += op.length - 1;
      if (op === "<<" || op === "<<-") {
        let j = i + 1;
        while (text[j] === " " || text[j] === "\t") j++;
        let raw = "";
        while (j < text.length && !/[\s;&|<>()]/.test(text[j])) {
          if (text[j] === "'" || text[j] === '"') {
            const end = text.indexOf(text[j], j + 1);
            const stopAt = end < 0 ? text.length : end;
            raw += text.slice(j, stopAt + 1);
            j = stopAt + 1;
          } else raw += text[j++];
        }
        const tag = raw.replace(/['"\\]/g, "");
        pending.push({ tag, dash: op === "<<-", expand: !/['"\\]/.test(raw), cmd });
        pushOperator(fd + op + tag, false);
        i = j - 1;
      } else {
        pushOperator(fd + op, true);
      }
    } else if (ch === "(") {
      if (next === "(" && !inWord && !cmd.words.length) {
        // (( … )) arithmetic command: its << is a shift, not a heredoc
        i = closeParen(text, i);
      } else if (inWord && ARRAY_ASSIGNMENT.test(acc.value)) {
        const r = parseList(st, i + 1, ")");
        acc.subs.push({ kind: "array", commands: r.commands });
        acc.value += text.slice(i, r.end + 1);
        i = r.end;
      } else {
        endCommand("group");
        depth++;
      }
    } else if (ch === ")") {
      if (depth === 0 && stop === ")") {
        endCommand("group");
        return { commands, end: i };
      }
      if (depth > 0) depth--;
      endCommand("group");
    } else {
      acc.value += ch;
      inWord = true;
    }
  }
  endCommand("list");
  return { commands, end: text.length };
}

// Every command, including those inside substitutions and unquoted heredoc bodies. The elements of an array
// assignment, a=(…), are words, not commands; substitutions inside them are included.
export function flatten(commands, out = []) {
  const walk = (sub) => {
    if (sub.kind !== "array") return flatten(sub.commands, out);
    for (const c of sub.commands) for (const inf of c.info) inf.subs.forEach(walk);
  };
  for (const c of commands) {
    for (const inf of c.info) inf.subs.forEach(walk);
    for (const h of c.heredocs) h.subs.forEach(walk);
    out.push(c);
  }
  return out;
}

// Just the words of every command
export const simpleCommands = (src) => flatten(parse(src)).map((c) => c.words);
