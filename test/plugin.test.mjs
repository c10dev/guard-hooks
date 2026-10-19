import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The commands in hooks/hooks.json run exactly as Claude Code runs them: through bash with CLAUDE_PLUGIN_ROOT set.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const hooks = json("hooks/hooks.json").hooks;
const commandOf = (event) => hooks[event][0].hooks[0].command;

test("manifests: plugin.json, marketplace.json and package.json agree", () => {
  const plugin = json(".claude-plugin/plugin.json");
  const market = json(".claude-plugin/marketplace.json");
  const pkg = json("package.json");
  assert.equal(plugin.name, "guard-hooks");
  assert.equal(plugin.license, "Apache-2.0");
  assert.ok(plugin.author?.name);
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, "./");
  assert.equal(market.plugins[0].version, plugin.version);
  assert.equal(pkg.version, plugin.version);
});

test("hooks.json: events, matchers, timeouts; only ${CLAUDE_PLUGIN_ROOT} paths and plain node", () => {
  for (const [event, mode] of [["SessionStart", "start"], ["UserPromptSubmit", "check"], ["PostToolUse", "check"]]) {
    const cmd = commandOf(event);
    assert.ok(cmd.includes(`"\${CLAUDE_PLUGIN_ROOT}/hooks/rules-drift.mjs" ${mode}`), event);
    assert.match(cmd, /; exit 0$/, `${event} must never block`);
    assert.equal(hooks[event][0].hooks[0].timeout, 5);
  }
  assert.equal(hooks.PostToolUse[0].matcher, "*");
  assert.equal(hooks.PreToolUse[0].matcher, "Bash|Monitor");
  // Claude Code puts the hook command in front of the block message, so it stays short and says nothing misleading
  assert.equal(commandOf("PreToolUse"), '/bin/sh "${CLAUDE_PLUGIN_ROOT}/hooks/kill-guard.sh" || exit 2');
  const all = JSON.stringify(hooks);
  assert.ok(!/\/home\/|\/Users\/|\.nvm/.test(all), "no machine-specific paths");
});

const runHook = (event, { stdin = "", env = {}, path } = {}) =>
  spawnSync("/bin/bash", ["-c", commandOf(event)], {
    input: stdin,
    encoding: "utf8",
    timeout: 8000,
    env: { PATH: path ?? process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
  });

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "cgh-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("rules-drift commands never block: broken stdin, unwritable state dir, no node → exit 0, no output", () =>
  withDir((dir) => {
    const bad = runHook("UserPromptSubmit", { stdin: "not json", env: { GUARD_HOOKS_STATE_DIR: dir } });
    assert.deepEqual([bad.status, bad.stdout], [0, ""]);
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    const unwritable = runHook("SessionStart", { stdin: JSON.stringify({ session_id: "s1", source: "startup", cwd: dir }), env: { GUARD_HOOKS_STATE_DIR: file, CLAUDE_PROJECT_DIR: dir } });
    assert.deepEqual([unwritable.status, unwritable.stdout], [0, ""]);
    const noNode = runHook("PostToolUse", { stdin: "{}", path: dir });
    assert.deepEqual([noNode.status, noNode.stdout], [0, ""]);
  }));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("end to end: RULES_DRIFT_REF=origin/main and RULES_DRIFT_FILES from env; a pushed change reaches the next turn once", () =>
  withDir((dir) => {
    const remote = join(dir, "remote.git");
    const repo = join(dir, "repo");
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    git(dir, "init", "-q", "-b", "main", repo);
    mkdirSync(join(repo, "docs"), { recursive: true });
    const doc = (n) => Array.from({ length: n }, (_, i) => `rule ${i}`).join("\n") + "\n";
    writeFileSync(join(repo, "CLAUDE.md"), "root rules\n");
    writeFileSync(join(repo, "docs/style.md"), doc(10));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    const push = (msg) => (git(repo, "commit", "-q", "-am", msg), git(repo, "push", "-q", "origin", "main"), git(repo, "fetch", "-q", "origin"));
    git(repo, "fetch", "-q", "origin");

    const env = { CLAUDE_PROJECT_DIR: repo, CLAUDE_PLUGIN_DATA: join(dir, "data"), RULES_DRIFT_REF: "origin/main", RULES_DRIFT_FILES: "CLAUDE.md,AGENTS.md,docs/style.md" };
    const session = { session_id: "scratch-1", cwd: repo };
    const turn = () => runHook("UserPromptSubmit", { stdin: JSON.stringify({ ...session, hook_event_name: "UserPromptSubmit" }), env });
    const start = runHook("SessionStart", { stdin: JSON.stringify({ ...session, hook_event_name: "SessionStart", source: "startup" }), env });
    assert.deepEqual([start.status, start.stdout], [0, ""]);
    assert.deepEqual([turn().status, turn().stdout], [0, ""], "quiet while nothing changed");

    // working-tree edits are ignored while RULES_DRIFT_REF is set
    writeFileSync(join(repo, "docs/style.md"), doc(10).replace("rule 3\n", "rule 3 changed\n"));
    assert.equal(turn().stdout, "");
    push("edit one line");
    const out = turn();
    assert.equal(out.status, 0);
    const ctx = JSON.parse(out.stdout).hookSpecificOutput;
    assert.equal(ctx.hookEventName, "UserPromptSubmit");
    assert.match(ctx.additionalContext, /^\[rules-drift\] Rules files changed since this session started: docs\/style\.md\./);
    assert.match(ctx.additionalContext, /^-rule 3$/m);
    assert.match(ctx.additionalContext, /^\+rule 3 changed$/m);
    assert.equal(turn().stdout, "", "reported once");

    // a big rewrite is cut at 150 lines with an instruction to read the file at the ref (the working tree lacks it)
    writeFileSync(join(repo, "docs/style.md"), doc(400).replace(/rule/g, "new rule"));
    push("rewrite");
    const big = turn();
    assert.equal(big.status, 0);
    const text = JSON.parse(big.stdout).hookSpecificOutput.additionalContext;
    assert.ok(text.split("\n").length <= 160, `diff not cut: ${text.split("\n").length} lines`);
    assert.ok(text.endsWith(`- docs/style.md: the diff is too long and was cut. Run \`git -C ${repo} show origin/main:docs/style.md\` to read it.`), text.slice(-200));
  }));

const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const monitor = (tool_input) => JSON.stringify({ tool_name: "Monitor", tool_input });

test("kill-guard command: blocks pkill (exit 2), allows ls, fails closed on broken input", () => {
  assert.equal(runHook("PreToolUse", { stdin: bash("ls") }).status, 0);
  const bad = runHook("PreToolUse", { stdin: bash('pkill -f "node server/index.ts"') });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^KILL GUARD: blocked because pkill/);
  assert.ok(!/node was not found/.test(bad.stderr));
  assert.equal(runHook("PreToolUse", { stdin: "not json" }).status, 2);
});

test("kill-guard command: Monitor commands are checked; a Monitor call without a command passes", () => {
  assert.equal(runHook("PreToolUse", { stdin: monitor({ command: "pkill -x zzznonexistentzzz; echo pkill_exit=$?", description: "x" }) }).status, 2);
  assert.equal(runHook("PreToolUse", { stdin: monitor({ command: "tail -f /tmp/build.log", description: "x" }) }).status, 0);
  assert.equal(runHook("PreToolUse", { stdin: monitor({ ws: { url: "wss://events.example.com/stream" }, description: "deploy events" }) }).status, 0);
});

test("kill-guard command: any failure of the check itself blocks (exit 2)", () =>
  withDir((dir) => {
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks/kill-guard.sh"), readFileSync(join(ROOT, "hooks/kill-guard.sh")));
    writeFileSync(join(dir, "hooks/kill-guard.mjs"), "process.exit(1);\n");
    const crashed = runHook("PreToolUse", { stdin: bash("ls"), env: { CLAUDE_PLUGIN_ROOT: dir } });
    assert.equal(crashed.status, 2);
    const missing = runHook("PreToolUse", { stdin: bash("ls"), env: { CLAUDE_PLUGIN_ROOT: join(dir, "nowhere") } });
    assert.equal(missing.status, 2);
  }));

test("kill-guard command: node found via PATH works; no node → exit 2 with a clear message; KILL_GUARD=off → exit 0", () =>
  withDir((dir) => {
    const bin = join(dir, "bin");
    const empty = join(dir, "empty");
    mkdirSync(bin);
    mkdirSync(empty);
    symlinkSync(process.execPath, join(bin, "node"));
    assert.equal(runHook("PreToolUse", { stdin: bash("ls"), path: bin }).status, 0);
    assert.equal(runHook("PreToolUse", { stdin: bash("pkill node"), path: bin }).status, 2);
    const noNode = runHook("PreToolUse", { stdin: bash("ls"), path: empty });
    assert.equal(noNode.status, 2);
    assert.match(noNode.stderr, /node was not found on PATH/);
    assert.equal(runHook("PreToolUse", { stdin: bash("pkill node"), path: empty, env: { KILL_GUARD: "off" } }).status, 0);
  }));
