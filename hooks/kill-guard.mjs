#!/usr/bin/env node
// kill-guard: PreToolUse(Bash) hook that stops a session from killing processes by name or pattern.
// Such kills hit whatever matches, including processes the session did not start: another session's dev server,
// a production service, the user's own tools. Origin: a session stopped its test server with
// `pkill -f "node server/index.ts"` and took the production server running the same file down with it.
// Blocks: pkill and killall, `kill $(pgrep|pidof|ps|lsof …)`, `pgrep|pidof|ps|lsof … | xargs kill`, `fuser -k`,
// and stop/restart/kill-type actions on protected systemd units or launchd labels.
// Allows: `kill <pid>`, `kill "$(cat <file>.pid)"`, and everything that only mentions these words (echo, grep, git log).
// Options (env vars, e.g. in the "env" block of .claude/settings.json):
//   KILL_GUARD=off         do nothing
//   KILL_GUARD_PATTERN     regex; block pkill/killall only when a pattern argument matches it (default: block all)
//   KILL_GUARD_UNITS       comma-separated systemd units / launchd labels to protect, e.g. "myapp,postgresql"
//   KILL_GUARD_HINT        extra text appended to the block message (e.g. how to deploy or restart properly)
// Fail-closed: if the input cannot be read or parsed, the command is blocked (exit 2).
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { simpleCommands } from "./shell.mjs";

const PATTERN_KILLERS = new Set(["pkill", "killall"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "exec", "time", "builtin", "nice", "setsid", "doas"]);
const UNIT_ACTIONS = new Set(["stop", "restart", "try-restart", "reload-or-restart", "try-reload-or-restart", "kill", "disable", "mask", "isolate"]);
const LAUNCHD_ACTIONS = new Set(["stop", "kill", "bootout", "unload", "remove", "disable"]);

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

// Strip VAR=x assignments and wrappers such as sudo/env so the real command word comes first
function coreOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w.split("/").pop())) i++;
    else if (i > 0 && /^-/.test(w) && WRAPPERS.has(words[0].split("/").pop())) i++; // options like sudo -u x
    else break;
  }
  return words.slice(i);
}

// The reason to block (a string) or null. Pure function.
export function blockReason(command, { pattern = null, units = [] } = {}) {
  if (typeof command !== "string") return "the command could not be read";
  // PIDs found by pattern, then killed: `kill $(pgrep -f …)`, `kill \`pidof …\``, `pgrep … | xargs kill`
  if (/\bkill\b[^\n;&|]*(\$\(|`)\s*(sudo\s+)?(pgrep|pidof|ps|lsof)\b/.test(command) || /\b(pgrep|pidof|lsof|ps)\b[^\n]*\|\s*(sudo\s+)?xargs\s+(-\S+\s+)*(sudo\s+)?kill\b/.test(command)) {
    return "it kills PIDs found by name, pattern or port";
  }
  const isProtected = (target) => units.includes(target.split("/").pop().replace(/\.service$/, ""));
  for (const raw of simpleCommands(command)) {
    const words = coreOf(raw);
    if (!words.length) continue;
    const name = words[0].split("/").pop();
    const args = words.slice(1);
    if (PATTERN_KILLERS.has(name)) {
      const targets = args.filter((a) => !/^-[A-Za-z0-9]+$/.test(a));
      if (!pattern) return `${name} kills every process matching a name or pattern`;
      const hit = targets.find((a) => pattern.test(a));
      if (hit !== undefined) return `${name} with the protected pattern "${hit}"`;
    }
    if (name === "fuser" && args.some((a) => /^-\w*k/.test(a))) return "fuser -k kills whatever uses a port or file, unnamed";
    if (name === "systemctl") {
      const [action, ...targets] = args.filter((a) => !a.startsWith("-"));
      const hit = UNIT_ACTIONS.has(action) && targets.find(isProtected);
      if (hit) return `systemctl ${action} ${hit} (protected unit)`;
    }
    if (name === "launchctl") {
      const [action, ...targets] = args.filter((a) => !a.startsWith("-"));
      const hit = LAUNCHD_ACTIONS.has(action) && targets.find(isProtected);
      if (hit) return `launchctl ${action} ${hit} (protected service)`;
    }
  }
  return null;
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
  let command;
  try {
    command = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command;
  } catch {
    console.error(BLOCK_MESSAGE("the hook input could not be read", hint));
    process.exit(2);
  }
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
