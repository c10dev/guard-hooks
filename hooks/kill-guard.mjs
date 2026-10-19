#!/usr/bin/env node
// kill-guard: PreToolUse(Bash, Monitor) hook that stops a session from killing processes by name or pattern.
// Such kills hit whatever matches, including processes the session did not start: another session's dev server,
// a production service, the user's own tools. Origin: a session stopped its test server with
// `pkill -f "node server/index.ts"` and took the production server running the same file down with it.
// Blocks: pkill and killall; kill with PIDs found by pgrep/pidof/ps/lsof/fuser (directly, through a variable or loop,
// or through xargs); kill -1 and kill 0; fuser -k; stop/restart-type actions on protected systemd units or launchd labels.
// It follows wrappers (sudo, env, nice, timeout, xargs, watch, …), shell keywords (if/then/do/{/!), bash -c, eval,
// heredocs fed to a shell, and command substitutions, also inside double quotes.
// Allows: `kill <pid>`, `kill "$(cat <file>.pid)"`, and everything that only mentions these words (echo, grep, git log).
// Options (env vars, e.g. in the "env" block of .claude/settings.json):
//   KILL_GUARD=off         do nothing
//   KILL_GUARD_PATTERN     regex; block pkill/killall only when a pattern argument matches it (default: block all)
//   KILL_GUARD_UNITS       comma-separated systemd units / launchd labels to protect, e.g. "myapp,postgresql"
//   KILL_GUARD_HINT        extra text appended to the block message (e.g. how to deploy or restart properly)
// Fail-closed: if the input cannot be read or parsed, the command is blocked (exit 2).
// A guard rail for an agent that means well, not a sandbox: see "What stays out of reach" in the README.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flatten, parse } from "./shell.mjs";

const PATTERN_KILLERS = new Set(["pkill", "killall"]);
const PID_SOURCES = new Set(["pgrep", "pidof", "ps", "lsof", "fuser"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/;
const UNIT_ACTIONS = new Set(["stop", "restart", "try-restart", "reload-or-restart", "try-reload-or-restart", "reload-or-try-restart", "force-reload", "kill", "disable", "mask", "isolate"]);
const SERVICE_ACTIONS = new Set(["stop", "restart", "try-restart", "force-reload", "condrestart", "--full-restart"]);
const LAUNCHD_ACTIONS = new Set(["stop", "kill", "bootout", "unload", "remove", "disable"]);
// systemctl options that take a separate value
const SYSTEMCTL_VALUES = new Set(["-s", "--signal", "-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property", "-P", "-n", "--lines", "-o", "--output", "--kill-whom", "--kill-value", "--job-mode", "--root", "--image", "--state", "--what", "--timestamp", "--preset-mode", "--message", "--when", "--drop-in"]);
const MAX_DEPTH = 8; // bash -c / eval / heredoc nesting

// Commands that run the rest of their words as a command.
//   short: option letters that take a value; long: long options that take a value (unless written --opt=value);
//   positional: words between the options and the command (1, or "number" for an optional numeric one);
//   pidMode: options that make it act on existing PIDs instead of running a command
const WRAPPERS = {
  sudo: { short: "ugpChDrtUTR", long: ["--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--role", "--type", "--other-user", "--command-timeout", "--chroot"] },
  doas: { short: "uC" },
  env: { short: "uCS", long: ["--unset", "--chdir", "--split-string"] },
  nice: { short: "n", long: ["--adjustment"] },
  ionice: { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"], pidMode: ["p", "P", "u", "--pid", "--pgid", "--uid"] },
  chrt: { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"], positional: "number", pidMode: ["p", "--pid"] },
  taskset: { positional: 1, pidMode: ["p", "--pid"] },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], positional: 1 },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  nohup: {},
  setsid: {},
  builtin: {},
  command: {},
  exec: { short: "a" },
  time: { short: "fo", long: ["--format", "--output"] },
  caffeinate: { short: "tw" },
  xargs: { short: "adEILnPs", long: ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"] },
  watch: { short: "nq", long: ["--interval", "--equexit"] },
  runuser: { short: "ugGsw", long: ["--user", "--group", "--supp-group", "--shell", "--whitelist-environment"] },
};

const base = (w) => w.split("/").pop();

export function configFromEnv(env = process.env) {
  let pattern = null;
  if (env.KILL_GUARD_PATTERN) {
    try {
      pattern = new RegExp(env.KILL_GUARD_PATTERN, "i");
    } catch {
      pattern = null; // invalid regex: fall back to blocking every pattern kill
    }
  }
  const units = (env.KILL_GUARD_UNITS || "").split(",").map((u) => u.trim().replace(/\.service$/, "")).filter(Boolean);
  return { pattern, units };
}

// Skip a wrapper's options from words[i]. Returns the index after them, the options seen and env -S's string.
function skipOptions(words, i, spec) {
  const seen = new Set();
  let split = null;
  while (i < words.length) {
    const w = words[i];
    if (w === "--") return { i: i + 1, seen, split };
    if (!w.startsWith("-") || w === "-") break;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      seen.add(name);
      const takesValue = eq < 0 && spec.long?.includes(name);
      if (name === "--split-string") split = eq < 0 ? words[i + 1] ?? "" : w.slice(eq + 1);
      i += takesValue ? 2 : 1;
      continue;
    }
    let step = 1;
    for (let j = 1; j < w.length; j++) {
      seen.add(w[j]);
      if (spec.short?.includes(w[j])) {
        // -u root, -uroot, -n10
        const attached = w.slice(j + 1);
        if (!attached) step = 2;
        if (w[j] === "S") split = attached || (words[i + 1] ?? "");
        break;
      }
    }
    i += step;
  }
  return { i, seen, split };
}

// bash/sh/zsh/… invocation: { script } for -c, { stdin: true } when it reads commands from stdin, {} for a script file
function shellInvocation(words, i) {
  let c = false;
  let s = false;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === "--" || w === "-") {
      i++;
      break;
    }
    if (w.startsWith("--")) {
      if (w === "--rcfile" || w === "--init-file") i++;
      continue;
    }
    if (!/^[-+]./.test(w)) break;
    if (w.includes("c")) c = true;
    if (w.includes("s")) s = true;
    if (/[oO]$/.test(w)) i++; // -o option, +O shopt
  }
  if (c) return { script: words[i] ?? "" };
  if (i >= words.length || s) return { stdin: true };
  return {};
}

const cache = new WeakMap();

// What a simple command runs, with keywords, assignments, redirections and wrappers taken off.
//   words/info  the command that actually runs (empty if none, e.g. `command -v pkill`)
//   viaXargs    it runs through xargs (its arguments come from stdin)
//   scripts     command strings it runs: bash -c, eval, watch, env -S, su -c, trap
//   stdin       it is a shell reading commands from stdin (heredoc, here-string, pipe)
export function unwrap(c) {
  if (cache.has(c)) return cache.get(c);
  const keep = c.words.map((_, k) => k).filter((k) => !c.info[k].redir);
  const words = keep.map((k) => c.words[k]);
  const info = keep.map((k) => c.info[k]);
  const out = { words: [], info: [], viaXargs: false, scripts: [], stdin: false };
  cache.set(c, out);
  let i = 0;
  for (let guard = 0; guard < 64 && i < words.length; guard++) {
    while (i < words.length && (KEYWORDS.has(words[i]) || ASSIGNMENT.test(words[i]) || words[i] === "function")) i += words[i] === "function" ? 2 : 1;
    if (i >= words.length) return out;
    const name = base(words[i]);
    const rest = words.slice(i + 1);
    if (name === "command" && /^-[A-Za-z]*[vV]/.test(rest[0] ?? "")) return out; // a lookup, not a run
    if (SHELLS.has(name)) {
      const sh = shellInvocation(words, i + 1);
      if (sh.script !== undefined) out.scripts.push(sh.script);
      out.stdin = Boolean(sh.stdin);
      return out;
    }
    if (name === "eval") {
      out.scripts.push(rest.join(" "));
      return out;
    }
    if (name === "trap") {
      const k = rest[0] === "--" ? 1 : 0;
      if (rest[k] !== undefined && !/^(-[lp]?|\d+)$/.test(rest[k])) out.scripts.push(rest[k]);
      return out;
    }
    if (name === "su" || (name === "runuser" && rest.some((w) => /^(-c|--command|--session-command)(=|$)|^-c./.test(w)))) {
      rest.forEach((w, k) => {
        if (w === "-c" || w === "--command" || w === "--session-command") out.scripts.push(rest[k + 1] ?? "");
        else if (/^--(session-)?command=/.test(w)) out.scripts.push(w.slice(w.indexOf("=") + 1));
        else if (/^-c./.test(w)) out.scripts.push(w.slice(2));
      });
      return out;
    }
    const spec = WRAPPERS[name];
    if (!spec) break;
    const r = skipOptions(words, i + 1, spec);
    if (spec.pidMode?.some((o) => r.seen.has(o))) return out;
    i = r.i;
    if (name === "env" && r.split !== null) {
      out.scripts.push([r.split, ...words.slice(i)].join(" "));
      return out;
    }
    if (spec.positional === 1) i++;
    else if (spec.positional === "number" && /^\d+$/.test(words[i] ?? "")) i++;
    if (name === "xargs") out.viaXargs = true;
    if (name === "watch" && !r.seen.has("x") && !r.seen.has("--exec")) {
      out.scripts.push(words.slice(i).join(" ")); // watch runs its arguments with sh -c
      return out;
    }
  }
  out.words = words.slice(i);
  out.info = info.slice(i);
  return out;
}

const runs = (c, names) => {
  const u = unwrap(c);
  return u.words.length > 0 && names.has(base(u.words[0]));
};

// Which words carry PIDs found by name, pattern or port: a substitution running pgrep/pidof/ps/lsof/fuser, or a
// variable assigned from one (NAME=$(…), for NAME in $(…), read NAME fed by a pipe, here-string or <(…)).
function pidFlow(cmds, inherited) {
  const tainted = new Set(inherited);
  const bears = (inf) => inf.vars.some((v) => tainted.has(v)) || inf.subs.some(subBears);
  const listBears = (list) => list.some((c) => runs(c, PID_SOURCES) || c.info.some(bears));
  const subBears = (s) => (s.kind === "array" ? s.commands.some((c) => c.info.some(bears)) : listBears(s.commands));
  // an earlier stage of c's pipeline produces PIDs
  const fed = (c) => cmds.some((d) => d.pipeline === c.pipeline && d.stage < c.stage && (runs(d, PID_SOURCES) || d.info.some(bears)));
  const stdinBears = () => cmds.some((c) => c.info.some((inf, k) => inf.subs.some((s) => s.kind === "proc" && listBears(s.commands)) || (c.words[k - 1] === "<<<" && bears(inf))));
  for (let changed = true; changed; ) {
    changed = false;
    const add = (name) => {
      if (!tainted.has(name)) (changed = true), tainted.add(name);
    };
    for (const c of cmds) {
      c.words.forEach((w, k) => {
        const m = ASSIGNMENT.exec(w);
        if (m && bears(c.info[k])) add(m[1]);
        if (w === "for" && c.words[k + 2] === "in" && c.info.slice(k + 3).some(bears)) add(c.words[k + 1]);
      });
      const u = unwrap(c);
      if (u.words[0] === "read" && (c.info.some(bears) || fed(c) || stdinBears())) {
        for (const w of u.words.slice(1)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) add(w);
      }
    }
  }
  return { tainted, bears, fed, stdinBears };
}

// What a shell reading stdin gets: its heredocs and here-strings, and what echo/printf/heredocs pipe into it
function stdinScripts(c, cmds) {
  const out = c.heredocs.map((h) => h.text);
  c.words.forEach((w, k) => w === "<<<" && k + 1 < c.words.length && out.push(c.words[k + 1]));
  for (const d of cmds) {
    if (d.pipeline !== c.pipeline || d.stage !== c.stage - 1) continue;
    out.push(...d.heredocs.map((h) => h.text));
    const u = unwrap(d);
    if (u.words.length && (u.words[0] === "echo" || u.words[0] === "printf")) out.push(u.words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" "));
  }
  return out;
}

// Positional words, skipping options and the values of options listed in valueOptions
function positionals(args, valueOptions = new Set()) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return out.concat(args.slice(i + 1));
    if (a.startsWith("-") && a.length > 1) {
      if (valueOptions.has(a)) i++;
    } else out.push(a);
  }
  return out;
}

// kill's targets: what follows the signal (-9, -KILL, -s SIG, -n N) and options, or `--`
function killTargets(args) {
  let signal = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return args.slice(i + 1);
    if (!a.startsWith("-") || a === "-") break;
    if (signal && /^-\d+$/.test(a)) break; // after the signal, -N is a process group (-1: every process)
    if (a === "-s" || a === "-n" || a === "--signal") (signal = true), i++;
    else if (!/^-[ap]$/.test(a)) signal = true;
  }
  return args.slice(i);
}

function checkCommand(c, flow, cfg, ctx, depth, cmds) {
  const u = unwrap(c);
  // inside `… | xargs sh -c 'kill …'` every kill gets PIDs from the pipe
  const inner = { tainted: flow.tainted, fedPids: ctx.fedPids || (u.viaXargs && (flow.fed(c) || flow.stdinBears())) };
  const scripts = u.stdin ? [...u.scripts, ...stdinScripts(c, cmds)] : u.scripts;
  for (const s of scripts) {
    const why = analyze(s, cfg, inner, depth + 1);
    if (why) return why;
  }
  if (!u.words.length) return null;
  const name = base(u.words[0]);
  const args = u.words.slice(1);
  const argInfo = u.info.slice(1);

  if (PATTERN_KILLERS.has(name)) {
    if (!cfg.pattern) return `${name} kills every process matching a name or pattern`;
    if (u.viaXargs) return `${name} gets its patterns from xargs, so KILL_GUARD_PATTERN cannot check them`;
    const targets = args.map((a, k) => [a, argInfo[k]]).filter(([a]) => !/^-[A-Za-z0-9]+$/.test(a));
    const dynamic = targets.find(([, inf]) => inf.vars.length || inf.subs.length);
    if (dynamic) return `${name} with the pattern "${dynamic[0]}", which is only known when it runs`;
    const hit = targets.find(([a]) => cfg.pattern.test(a));
    if (hit) return `${name} with the protected pattern "${hit[0]}"`;
  }
  if (name === "kill") {
    if (inner.fedPids || argInfo.some(flow.bears)) return "it kills PIDs found by name, pattern or port";
    const wide = killTargets(args).find((t) => t === "-1" || t === "0" || t === "-0");
    if (wide === "-1") return "kill -1 signals every process you are allowed to signal";
    if (wide) return "kill 0 signals every process in the current process group";
  }
  if (name === "fuser" && args.some((a) => a === "--kill" || /^-[A-Za-z0-9]*k/.test(a))) return "fuser -k kills whatever uses a port or file, unnamed";

  const unitOf = (t) => base(t).replace(/\.(service|plist)$/, "");
  const isProtected = (t) => cfg.units.some((unit) => unitOf(t) === unit || (!unit.includes("@") && unitOf(t).startsWith(`${unit}@`)));
  if (name === "systemctl") {
    const [action, ...targets] = positionals(args, SYSTEMCTL_VALUES);
    const hit = UNIT_ACTIONS.has(action) && targets.find(isProtected);
    if (hit) return `systemctl ${action} ${hit} (protected unit)`;
  }
  if (name === "service") {
    const [unit, action] = positionals(args);
    const act = args.includes("--full-restart") ? "--full-restart" : action;
    if (unit && SERVICE_ACTIONS.has(act) && isProtected(unit)) return `service ${unit} ${act} (protected unit)`;
  }
  if (name === "launchctl") {
    const [action, ...targets] = positionals(args);
    const stops = LAUNCHD_ACTIONS.has(action) || (action === "kickstart" && args.some((a) => /^-[a-z]*k/.test(a)));
    const hit = stops && targets.find(isProtected);
    if (hit) return `launchctl ${action} ${hit} (protected service)`;
  }
  return null;
}

function analyze(command, cfg, ctx, depth) {
  if (depth > MAX_DEPTH) return "it nests shells too deeply to check";
  const cmds = flatten(parse(command));
  const flow = pidFlow(cmds, ctx.tainted);
  for (const c of cmds) {
    const why = checkCommand(c, flow, cfg, ctx, depth, cmds);
    if (why) return why;
  }
  return null;
}

// The reason to block (a string) or null. Pure function.
export function blockReason(command, { pattern = null, units = [] } = {}) {
  if (typeof command !== "string") return "the command could not be read";
  return analyze(command, { pattern, units }, { tainted: [], fedPids: false }, 0);
}

export const BLOCK_MESSAGE = (why, hint = "") =>
  `KILL GUARD: blocked because ${why}. Killing processes by name or pattern can take down processes this session did not start ` +
  `(another session's dev server, a production service, the user's own tools). ` +
  `When you start a process, save its PID (\`… & echo $! > /tmp/<name>.pid\`) and stop it only with \`kill "$(cat /tmp/<name>.pid)"\`. ` +
  `Do not touch processes you did not start; if one has to stop, ask the user.` +
  (hint ? ` ${hint}` : "");

function main() {
  if (process.env.KILL_GUARD === "off") return;
  const hint = process.env.KILL_GUARD_HINT || "";
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error(BLOCK_MESSAGE("the hook input could not be read", hint));
    process.exit(2);
  }
  const tool = input?.tool_name;
  const command = input?.tool_input?.command;
  // Monitor can watch something other than a command (e.g. a WebSocket); only Bash must always have one
  if (command === undefined && typeof tool === "string" && tool !== "Bash") return;
  let why;
  try {
    why = blockReason(command, configFromEnv());
  } catch (e) {
    why = `the command could not be parsed (${e?.message ?? e})`;
  }
  if (why) {
    console.error(BLOCK_MESSAGE(why, hint));
    process.exit(2);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) main();
