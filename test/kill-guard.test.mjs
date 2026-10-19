import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { blockReason, configFromEnv } from "../hooks/kill-guard.mjs";

const GUARD = fileURLToPath(new URL("../hooks/kill-guard.mjs", import.meta.url));

// Blocked with the default config (no KILL_GUARD_PATTERN, no protected units)
const blocked = [
  'pkill -f "node server/index.ts"',
  "pkill -f server/index.ts",
  "pkill node",
  "pkill vite",
  "pkill -9 -f 'node server/index'",
  "killall node",
  "killall firefox",
  "sudo pkill -f myapp",
  "FOO=1 pkill -f node",
  "/usr/bin/pkill -f 'node server'",
  "cd /tmp && pkill -f 'node server/index.ts' ; echo done",
  "kill $(pgrep -f 'node server/index.ts')",
  "kill -9 $(pgrep node)",
  "kill `pidof node`",
  "kill $(lsof -t -i:3000)",
  "kill -9 $(lsof -ti tcp:5173)",
  "pgrep -f server/index.ts | xargs kill",
  "ps aux | grep node | xargs -r kill -9",
  "lsof -ti:3000 | xargs kill -9",
  "fuser -k 3000/tcp",
  // wrappers and launchers
  "setsid pkill node",
  "stdbuf -oL pkill node",
  "ionice -c3 pkill node",
  "chrt -f 10 pkill node",
  "taskset -c 0 pkill node",
  "time -p pkill node",
  "exec pkill node",
  "doas -u root killall node",
  "runuser -u app -- pkill node",
  "/usr/bin/env pkill node",
  "su -c 'pkill node' root",
  "trap 'pkill -f vite' EXIT",
  "env -S 'pkill node'",
  "zsh -lc 'pkill node'",
  "bash -o pipefail -c 'pkill node'",
  'echo "pkill node" | sh',
  "bash <<< 'pkill node'",
  "cat <<EOF | bash\npkill node\nEOF",
  "f() { pkill node; }",
  "( pkill node )",
  "cat <<EOF > notes.txt\nstopped: $(pkill node)\nEOF",
  // PIDs found by name, pattern or port, through variables, arrays, loops and read
  "pids=($(pgrep x)); kill ${pids[@]}",
  "local pid=$(pgrep x); kill $pid",
  "pgrep node | while read p; do kill $p; done",
  "while read p; do kill $p; done < <(pgrep node)",
  'read -r pid <<< "$(pgrep node)"; kill $pid',
  'PID=$(pgrep node); bash -c "kill $PID"',
  "pgrep node | xargs -I{} sh -c 'kill {}'",
  "lsof -i :3000 | awk 'NR>1{print $2}' | xargs kill",
  "kill -9 $(ps aux | grep '[n]ode' | awk '{print $2}')",
  "kill $(fuser 3000/tcp 2>/dev/null)",
  // kill -1 / kill 0
  "kill -s KILL -1",
  "kill -9 -- -1",
  "kill 0",
];
const allowed = [
  "kill 12345",
  "kill -9 12345",
  'kill "$(cat /tmp/x/server.pid)"',
  "node server/index.ts & echo $! > /tmp/x/server.pid",
  "pgrep -f vite",
  "lsof -i :3000",
  "systemctl --user stop myapp",
  "systemctl --user status myapp",
  "launchctl stop com.example.myapp",
  "journalctl --user -u myapp -f",
  "echo 'pkill -f node server/index.ts'",
  "git log --grep pkill",
  "grep -rn 'systemctl --user restart myapp' docs",
  "npm test",
  "",
];

test("blocks kills by name, pattern or port", () => {
  for (const c of blocked) assert.ok(blockReason(c), `should block: ${c}`);
});

test("allows kill <pid>, PID files, reads, and text that only mentions kill commands", () => {
  for (const c of allowed) assert.equal(blockReason(c), null, `should allow: ${c}`);
});

test("KILL_GUARD_PATTERN narrows pkill/killall to matching patterns", () => {
  const cfg = configFromEnv({ KILL_GUARD_PATTERN: "server/index|myapp|node" });
  for (const c of ["pkill node", 'pkill -f "node server/index.ts"', "killall -9 myapp", "sudo pkill -f myapp"]) assert.ok(blockReason(c, cfg), `should block: ${c}`);
  for (const c of ["pkill vite", "killall firefox"]) assert.equal(blockReason(c, cfg), null, `should allow: ${c}`);
  // pattern-independent rules still apply
  for (const c of ["kill $(pgrep vite)", "fuser -k 5173/tcp"]) assert.ok(blockReason(c, cfg), `should block: ${c}`);
  // an invalid regex falls back to blocking every pattern kill
  assert.ok(blockReason("pkill vite", configFromEnv({ KILL_GUARD_PATTERN: "(" })));
  // a pattern only known when the command runs cannot be checked, so it is blocked
  for (const c of ['pkill -f "$NAME"', "for p in vite web; do pkill $p; done", "echo vite | xargs pkill", "pkill $(cat name.txt)"]) assert.ok(blockReason(c, cfg), `should block: ${c}`);
});

test("KILL_GUARD_UNITS protects systemd units and launchd labels", () => {
  const cfg = configFromEnv({ KILL_GUARD_UNITS: "myapp, com.example.api.service" });
  const blockedUnits = [
    "systemctl --user stop myapp",
    "systemctl --user restart myapp.service",
    "systemctl --user kill myapp",
    "systemctl --user disable --now myapp",
    "systemctl stop myapp",
    "sudo systemctl --user restart myapp",
    "systemctl --user try-restart myapp",
    "systemctl stop com.example.api",
    "launchctl stop myapp",
    "launchctl bootout gui/501/myapp",
    "launchctl kill SIGTERM gui/501/myapp",
    "launchctl unload -w ~/Library/LaunchAgents/myapp.plist",
    "launchctl kickstart -kp gui/501/myapp",
    "systemctl --user reload-or-restart myapp",
    "systemctl restart myapp@worker-1",
    "service myapp --full-restart",
    "/usr/sbin/service myapp condrestart",
  ];
  const allowedUnits = [
    "systemctl --user status myapp",
    "systemctl --user start myapp",
    "systemctl --user stop myapp-worker",
    "systemctl --user restart other",
    "launchctl list myapp",
    "launchctl stop other",
    "launchctl kickstart gui/501/myapp",
    "service myapp status",
    "service other stop",
    "systemctl -H myapp stop other",
  ];
  for (const c of blockedUnits) assert.ok(blockReason(c, cfg), `should block: ${c}`);
  for (const c of allowedUnits) assert.equal(blockReason(c, cfg), null, `should allow: ${c}`);
});

test("a listed template instance protects only itself; a listed template protects every instance", () => {
  const one = configFromEnv({ KILL_GUARD_UNITS: "worker@1" });
  assert.ok(blockReason("systemctl stop worker@1.service", one));
  assert.equal(blockReason("systemctl stop worker@2", one), null);
  assert.ok(blockReason("systemctl stop worker@2", configFromEnv({ KILL_GUARD_UNITS: "worker" })));
});

test("fail closed: a command that is not a string is blocked; nesting is capped", () => {
  assert.ok(blockReason(undefined));
  assert.ok(blockReason(42));
  let deep = "ls";
  for (let n = 0; n < 12; n++) deep = `bash -c ${JSON.stringify(deep)}`;
  assert.match(blockReason(deep), /nests shells too deeply/);
  let ok = "ls";
  for (let n = 0; n < 4; n++) ok = `bash -c ${JSON.stringify(ok)}`;
  assert.equal(blockReason(ok), null);
});

test("never throws: odd and malformed commands get a verdict", () => {
  const chars = ["pkill ", "kill ", "$(", ")", "`", '"', "'", "|", "xargs ", "for p in ", "; do ", "; done", "<<EOF\n", "\nEOF\n", "$p ", "-1 ", "bash -c ", "sudo -u ", "{ ", " }", "&", "<(", "pgrep x"];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 3000; n++) {
    const c = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => chars[Math.floor(rand() * chars.length)]).join("");
    assert.doesNotThrow(() => blockReason(c), JSON.stringify(c));
  }
});

const runGuard = (input, env = {}) => spawnSync(process.execPath, [GUARD], { input, encoding: "utf8", env: { ...process.env, KILL_GUARD: "", KILL_GUARD_PATTERN: "", KILL_GUARD_UNITS: "", KILL_GUARD_HINT: "", ...env } });
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

test("process: block → exit 2 with the reason on stderr; allow → exit 0; broken input → exit 2", () => {
  const bad = runGuard(bash('pkill -f "node server/index.ts"'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^KILL GUARD: blocked because pkill/);
  assert.match(bad.stderr, /\.pid/);
  assert.equal(runGuard(bash("kill 123")).status, 0);
  assert.equal(runGuard("not json").status, 2);
  assert.equal(runGuard("").status, 2);
  assert.equal(runGuard(JSON.stringify({ tool_name: "Bash", tool_input: {} })).status, 2);
});

test("process: env config — KILL_GUARD=off, KILL_GUARD_PATTERN, KILL_GUARD_UNITS, KILL_GUARD_HINT", () => {
  assert.equal(runGuard(bash("pkill node"), { KILL_GUARD: "off" }).status, 0);
  assert.equal(runGuard(bash("pkill vite"), { KILL_GUARD_PATTERN: "node" }).status, 0);
  assert.equal(runGuard(bash("pkill node"), { KILL_GUARD_PATTERN: "node" }).status, 2);
  assert.equal(runGuard(bash("systemctl --user restart myapp"), { KILL_GUARD_UNITS: "myapp" }).status, 2);
  const hinted = runGuard(bash("pkill node"), { KILL_GUARD_HINT: "Deploy with ./deploy.sh instead." });
  assert.match(hinted.stderr, /Deploy with \.\/deploy\.sh instead\.$/m);
});
