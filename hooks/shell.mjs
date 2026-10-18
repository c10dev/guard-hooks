// Split a Bash command string into simple commands (arrays of unquoted words) so a hook can look at
// what actually runs in command position. Arguments to echo/printf/jq and heredoc bodies stay data.
// An approximation for guard hooks, not a full shell parser. No dependencies.

// Remove heredoc bodies (<<EOF … EOF, <<'EOF', <<-EOF). Here-strings (<<<) are left alone.
function stripHeredocs(src) {
  const out = [];
  const pending = [];
  for (const line of src.split("\n")) {
    if (pending.length) {
      const { tag, dash } = pending[0];
      if ((dash ? line.replace(/^\t+/, "") : line) === tag) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g)) {
      pending.push({ dash: m[1] === "-", tag: m[3] });
    }
  }
  return out.join("\n");
}

// List of word arrays with quotes removed. Commands split at ; & | newline ( ) ` and $(.
export function simpleCommands(src) {
  const text = stripHeredocs(src);
  const commands = [];
  let words = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      if (text[i + 1] !== "\n") (word += text[i + 1] ?? ""), (inWord = true);
      i++;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) j++;
        word += text[j++];
      }
      inWord = true;
      i = j;
    } else if (ch === "#" && !inWord) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl - 1;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === "$" && text[i + 1] === "(") {
      endCommand();
      i++;
    } else if ("\n;&|()`".includes(ch)) {
      endCommand();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}
