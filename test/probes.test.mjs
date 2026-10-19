// Every kill-guard probe from the 0.1.0 verification (plus its controls) with the exit code the hook must give,
// the npm port killer shapes added after it, and a corpus of ordinary agent commands that must keep passing. Each case runs the real hook process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("../hooks/kill-guard.mjs", import.meta.url));
const CLEAN = { KILL_GUARD: "", KILL_GUARD_PATTERN: "", KILL_GUARD_UNITS: "", KILL_GUARD_HINT: "" };
const runGuard = (input, env = {}) => spawnSync(process.execPath, [GUARD], { input, encoding: "utf8", env: { ...process.env, ...CLEAN, ...env } });
const tool = (tool_name, tool_input) => JSON.stringify({ tool_name, tool_input });

// [command, expected exit code, env]
const probes = {
  "direct exit codes (1d)": [
    ["pkill -f node", 2],
    ["killall node", 2],
    ["kill $(lsof -t -i:3000)", 2],
    ["kill 12345", 0],
    ["systemctl stop foo", 0],
    ["systemctl stop foo", 2, { KILL_GUARD_UNITS: "foo" }],
    ["systemctl stop foo.service", 2, { KILL_GUARD_UNITS: "foo" }],
    ["sudo systemctl --user restart foo", 2, { KILL_GUARD_UNITS: "foo" }],
    ["pkill -f node", 0, { KILL_GUARD: "off" }],
    ["pkill -x zzznonexistentzzz", 2],
    ["echo ok", 0],
  ],
  "README examples (1e)": [
    ['kill "$(cat server.pid)"', 0],
    ["echo 'pkill node'", 0],
    ["git log --grep pkill", 0],
    ["cat <<EOF > notes.txt\npkill node\nEOF", 0],
    ["kill `pidof node`", 2],
    ["kill $(pgrep -f vite)", 2],
    ["pgrep node | xargs kill", 2],
    ["ps aux | grep node | xargs kill", 2],
    ["lsof -ti:3000 | xargs kill", 2],
    ["fuser -k 3000/tcp", 2],
    ["launchctl bootout gui/501/com.foo", 2, { KILL_GUARD_UNITS: "com.foo" }],
    ["launchctl stop com.foo", 0],
    // 0.1.0 matched `kill $(pgrep …)` on the raw text and blocked this; it only runs pgrep, so it passes now
    ['echo "kill $(pgrep node)"', 0],
  ],
  "KILL_GUARD_PATTERN (1f)": [
    ["pkill -f node", 2, { KILL_GUARD_PATTERN: "node|server/index|myapp" }],
    ["pkill -x zzznonexistentzzz", 0, { KILL_GUARD_PATTERN: "node|server/index|myapp" }],
    ['pkill -f "node server/index.ts"', 2, { KILL_GUARD_PATTERN: "server/index" }],
    ["pkill -x zzz", 2, { KILL_GUARD_PATTERN: "(" }],
    ["kill $(pgrep zzz)", 2, { KILL_GUARD_PATTERN: "node" }],
  ],
  "shell reserved words": [
    ["{ pkill node; }", 2],
    ["if true; then pkill node; fi", 2],
    ["for p in a b; do pkill $p; done", 2],
    ["while false; do killall node; done", 2],
    ["! pkill node", 2],
    ["pkill node", 2],
    ["if true; then pkill -x zzznonexistentzzz; fi; echo rc=$?", 2],
    ["if pgrep -x foo >/dev/null; then pkill foo; fi", 2],
  ],
  "command substitution inside double quotes": [
    ['echo "$(pkill node)"', 2],
    ['x="$(killall node)"', 2],
    ['echo "`pkill node`"', 2],
    ['echo "done: $(fuser -k 3000/tcp)"', 2],
    ["echo $(pkill node)", 2],
  ],
  "wrappers and launchers": [
    ["sudo -u root pkill node", 2],
    ["env -u FOO pkill node", 2],
    ["nice -n 10 pkill node", 2],
    ["timeout 5 pkill node", 2],
    ["echo node | xargs pkill", 2],
    ['bash -c "pkill node"', 2],
    ["sh -c 'killall node'", 2],
    ['eval "pkill node"', 2],
    ["watch -n 1 pkill node", 2],
    ["xargs -a names.txt pkill", 2],
    ["bash <<'EOF'\npkill node\nEOF", 2],
    ["sh <<EOF\nkillall node\nEOF", 2],
    ["sudo pkill node", 2],
    ["sudo -n pkill node", 2],
  ],
  "kill -1 and kill 0": [
    ["kill -9 -1", 2],
    ["kill -- -1", 2],
    ["kill -TERM 0", 2],
  ],
  "fuser --kill and xargs options with values": [
    ["fuser --kill 3000/tcp", 2],
    ["pgrep node | xargs -n 1 kill", 2],
    ["pgrep node | xargs -I {} kill {}", 2],
    ["pgrep node | xargs -I{} kill {}", 2],
    ["pgrep node | xargs -r kill -9", 2],
  ],
  "false positives (1k)": [
    ["cat /tmp/ps.pids | xargs kill", 0],
    ["man pkill", 0],
    ["which pkill", 0],
    ["grep -rn pkill .", 0],
    ["command -v pkill", 0],
    ["command -V killall", 0],
    ["type pkill", 0],
  ],
  "PIDs passed through a variable or loop": [
    ["PID=$(lsof -ti:3000); kill $PID", 2],
    ["pids=$(pgrep -f vite) && kill $pids", 2],
    ["for pid in $(pgrep node); do kill $pid; done", 2],
    ["kill -9 $(lsof -ti:3000)", 2],
  ],
  "npm port killers, installed or through a package runner": [
    ["npx kill-port 3000", 2],
    ["npx -y kill-port 3000 5173", 2],
    ["pnpm dlx kill-port 3000", 2],
    ["bunx kill-port 3000", 2],
    ["yarn dlx kill-port 3000", 2],
    ["kill-port 3000", 2],
    ["npx --yes kill-port@2 3000", 2],
    ["npx -p kill-port kill-port 3000", 2],
    ["npx --package=kill-port -- kill-port 3000", 2],
    ["npx -c 'kill-port 3000'", 2],
    ["npm exec -- kill-port 3000", 2],
    ["npm x -y kill-port 3000", 2],
    ["pnpm exec kill-port 3000", 2],
    ["pnpm dlx -c 'kill-port 3000'", 2],
    ["pnpx kill-port 3000", 2],
    ["bun x kill-port 3000", 2],
    ["yarn exec kill-port 3000", 2],
    ["sudo npx kill-port 3000", 2],
    ["kill-port --port 3000", 2],
    ["./node_modules/.bin/kill-port 3000", 2],
    ["npx kill-port-process 3000", 2],
    ["echo 3000 | xargs npx kill-port", 2],
    ["fkill :3000", 2],
    ["npx fkill-cli :3000", 2],
    ["fkill -f node", 2],
    ["fkill $(pgrep node)", 2],
    ["npx kill-port 3000", 2, { KILL_GUARD_PATTERN: "node" }],
    ["fkill :3000", 2, { KILL_GUARD_PATTERN: "node" }],
    ["fkill node", 2, { KILL_GUARD_PATTERN: "node" }],
    ["fkill vite", 0, { KILL_GUARD_PATTERN: "node" }],
  ],
  // pre-merge review of #2: npm and pnpm read runner options before the subcommand, fkill passes a number to
  // `kill -- <n>`, and yarn 4 exec runs its argument as shell code
  "runner options before the subcommand, fkill -1 and 0, yarn exec strings": [
    ["pnpm -c exec 'kill-port 3000'", 2],
    ["pnpm --shell-mode exec 'kill-port 3000'", 2],
    ["pnpm -c dlx 'kill-port 3000'", 2],
    ["pnpm --package kill-port -c dlx 'kill-port 3000'", 2],
    ["pnpm --package kill-port dlx kill-port 3000", 2],
    ["pnpm -c exec 'pkill node'", 2],
    ["npm -c 'kill-port 3000' exec", 2],
    ["npm --call 'kill-port 3000' exec", 2],
    ["npm --call='kill-port 3000' x", 2],
    ["npm --package kill-port exec kill-port 3000", 2],
    ["fkill -1", 2],
    ["fkill 0", 2],
    ["fkill -f -1", 2],
    ["fkill -0", 2],
    ["yarn exec 'kill-port 3000'", 2],
    ["yarn exec 'npx kill-port 3000'", 2],
    ['yarn exec "pkill node"', 2],
    ["fkill -1234", 0],
  ],
  // re-check of #2 at 20728e4: yarn 4 exec runs only its first word as shell code and passes the rest as literal
  // arguments (yarn 1 runs it as a command), and npm reads -p as --parseable, which takes no value
  "yarn exec shell code and arguments, npm -p": [
    ["yarn exec bash -c 'kill-port 3000'", 2],
    ["yarn exec bash -c 'kill $(lsof -ti:3000)'", 2],
    ["yarn exec bash -c 'kill -9 -1'", 2],
    ["yarn exec sh -c 'fuser -k 3000/tcp'", 2],
    ["yarn exec sudo bash -c 'kill-port 3000'", 2],
    ["yarn exec su -c 'kill-port 3000'", 2],
    ["yarn exec timeout 5 bash -c 'kill $(pgrep node)'", 2],
    ["yarn exec -- bash -c 'kill-port 3000'", 2],
    ["yarn exec -- bash -c 'kill $(lsof -ti:3000)'", 2],
    ["yarn exec 'bash -c' 'kill-port 3000'", 2],
    ["yarn --cwd web exec 'kill-port 3000'", 2],
    ["yarn exec kill $(pgrep node)", 2],
    ["npm -p exec kill-port 3000", 2],
    ["npm -p x kill-port 3000", 2],
    ["npm exec -p kill-port 3000", 2],
    ["yarn exec echo 'a; pkill node'", 0],
    ["yarn exec echo '$(pkill node)'", 0],
  ],
  "protected units": [
    ["service foo restart", 2, { KILL_GUARD_UNITS: "foo,com.foo" }],
    ["sudo service foo stop", 2, { KILL_GUARD_UNITS: "foo,com.foo" }],
    ["launchctl kickstart -k gui/501/com.foo", 2, { KILL_GUARD_UNITS: "foo,com.foo" }],
    ["systemctl force-reload foo", 2, { KILL_GUARD_UNITS: "foo,com.foo" }],
    ["systemctl -s KILL kill foo", 2, { KILL_GUARD_UNITS: "foo" }],
    ["systemctl -H host stop foo", 2, { KILL_GUARD_UNITS: "foo" }],
    ["systemctl stop foo@1", 2, { KILL_GUARD_UNITS: "foo" }],
    ["systemctl --signal=KILL kill foo", 2, { KILL_GUARD_UNITS: "foo" }],
    ["systemctl restart foo", 2, { KILL_GUARD_UNITS: "foo" }],
    ["launchctl stop com.foo", 2, { KILL_GUARD_UNITS: "foo,com.foo" }],
  ],
};

// Ordinary commands an agent writes; none of them may be blocked
const ordinary = [
  "kill $!",
  "kill %1",
  "kill -- -$PGID",
  "kill -- -12345",
  "kill -1 1234",
  "kill -l",
  "kill -0 $SERVER_PID",
  "kill -9 12345",
  'kill "$(cat /tmp/x.pid)"; sleep 1; ps aux | grep node',
  "kill $(jobs -p)",
  "node server.js & echo $! > /tmp/dev.pid",
  "trap 'kill $PID' EXIT",
  'for f in *.md; do wc -l "$f"; done',
  'while read -r l; do echo "$l"; done < file.txt',
  'echo "$(date)"',
  'eval "$(ssh-agent -s)"',
  "timeout 30 npm test",
  "watch -n1 git status",
  "sudo -u postgres psql -c 'select 1'",
  "env -u FOO node x.js",
  "nice -n 10 npm run build",
  'bash -c "echo hi"',
  "sh -c 'npm test && echo ok'",
  "bash <<'EOF'\necho hi\nEOF",
  "jq '.kill' data.json",
  "./scripts/kill-dev.sh",
  "case $x in kill) echo k;; esac",
  "xargs -n 1 echo < list.txt",
  "find . -name '*.pid' | xargs cat",
  "pgrep -f vite",
  "pgrep -f vite && echo running",
  "if pgrep -x foo >/dev/null; then echo up; fi",
  "lsof -i :3000",
  "ps aux | grep node | head",
  "x=$((1 + 2)); echo $x",
  'git commit -m "kill-guard: block pkill $(pgrep) shapes"',
  "python3 - <<EOF\nimport os\nprint(os.getpid())\nEOF",
  "systemctl --user status myapp",
  "journalctl --user -u myapp -f",
  "npx vite",
  "npx kill-port --help",
  "npx kill-port",
  "npm run kill",
  "npm run kill-port",
  "npx -y create-vite@latest app",
  "npx -p typescript tsc --noEmit",
  "npx tsx scripts/kill.ts",
  "npx -c 'npm test'",
  "npm exec -- vitest run",
  "pnpm dlx shadcn@latest add button",
  "pnpm exec eslint .",
  "bunx prettier --write .",
  "yarn dlx create-next-app app",
  "npm i -D kill-port fkill-cli",
  "fkill 1234",
  "fkill --help",
  "pnpm -c exec 'echo hi'",
  "pnpm -r exec eslint .",
  "pnpm --package typescript dlx tsc",
  "npm --package typescript exec tsc",
  "npm -c 'npm test' exec",
  "yarn exec tsc",
  "yarn exec 'echo hi; ls'",
  "yarn exec 'echo A; echo B' extra",
  'yarn exec node -e "console.log(1)"',
  "yarn exec jest -t 'kills port (3000)'",
  "yarn exec git commit -m 'fix: stop using pkill node'",
  'yarn exec vitest run -t "fkill node"',
  "yarn exec echo \"it's fine\"",
  "npm -p ls",
  "npm -C /tmp exec tsc",
  "npm --call 'tsc -p .' exec",
  "echo 'npx kill-port 3000'",
];

for (const [group, cases] of Object.entries(probes)) {
  test(`probes: ${group}`, () => {
    for (const [command, expected, env] of cases) {
      const r = runGuard(tool("Bash", { command }), env);
      assert.equal(r.status, expected, `${JSON.stringify(command)} ${env ? JSON.stringify(env) : ""} → exit ${r.status}: ${r.stderr}`);
      if (expected === 2) assert.match(r.stderr, /^KILL GUARD: blocked because /);
    }
  });
}

test("ordinary agent commands pass", () => {
  for (const command of ordinary) {
    const r = runGuard(tool("Bash", { command }));
    assert.equal(r.status, 0, `${JSON.stringify(command)} → exit ${r.status}: ${r.stderr}`);
  }
});

test("Monitor: a command is checked like Bash; a call without one (e.g. a ws source) passes", () => {
  assert.equal(runGuard(tool("Monitor", { command: "pkill node", description: "x", timeout_ms: 30000 })).status, 2);
  assert.equal(runGuard(tool("Monitor", { command: "pkill -x zzznonexistentzzz; echo pkill_exit=$?", description: "x", timeout_ms: 30000 })).status, 2);
  assert.equal(runGuard(tool("Monitor", { command: "tail -f /tmp/build.log", description: "x" })).status, 0);
  assert.equal(runGuard(tool("Monitor", { ws: { url: "wss://events.example.com/stream" }, description: "deploy events", timeout_ms: 30000 })).status, 0);
  // still fail-closed for Bash, and for input that names no tool
  assert.equal(runGuard(tool("Bash", {})).status, 2);
  assert.equal(runGuard("{}").status, 2);
  assert.equal(runGuard("null").status, 2);
});
