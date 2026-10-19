# Changelog

## 0.1.2 (2026-10-19)

### kill-guard

Added:

- npm port killers are blocked, like `fuser -k`: they kill whatever listens on a port without naming it. This covers `kill-port` and `kill-port-process`, run directly (`kill-port 3000`, `./node_modules/.bin/kill-port 3000`) or through a package runner: `npx`, `npm exec`/`npm x`, `pnpm dlx`, `pnpm exec`, `pnpx`, `bunx`, `bun x`, `yarn dlx`, `yarn exec`. Runner options are followed, also where npm and pnpm read them before the subcommand: `npx -y`, `-p <pkg>`, `--package=<pkg>`, `npm --package <pkg> exec`, `pnpm --package <pkg> dlx`. So are versions (`kill-port@2`) and the command strings that runners run in a shell: `npx -c '<cmd>'`, `npm -c '<cmd>' exec`, `pnpm -c exec '<cmd>'`, `pnpm dlx -c '<cmd>'`, and `yarn exec '<cmd>'` (yarn 4). `kill-port` with no port (`npx kill-port --help`) passes.
- `fkill`/`fkill-cli` with a port (`fkill :3000`) or a name (`fkill node`) is blocked. A name kills like `pkill`, so `KILL_GUARD_PATTERN` narrows it the same way. `fkill -1` and `fkill 0` are blocked like `kill -1` and `kill 0`, because fkill passes a number to `kill -- <n>`. `fkill <pid>` and `fkill -<pgid>` pass.

Changed:

- The block message says "by name, pattern or port", since `fuser -k` and the port killers name no process.
- README: npm port killers moved from "What stays out of reach" to the blocked list.

## 0.1.1 (2026-10-19)

An independent verification of 0.1.0 installed the plugin from GitHub and probed kill-guard with common shell shapes. Several got past it. Every probe from that report is now a test in `test/probes.test.mjs`, with the exit code it must give.

### kill-guard

Fixed:

- Shell keywords hid a kill: `{ pkill node; }`, `if …; then pkill …; fi`, `for/while …; do …; done` and `! pkill …` passed.
- The Monitor tool, which also runs shell commands, was not checked. The matcher is now `Bash|Monitor`. A Monitor call without a command (for example a WebSocket source) passes.
- Command substitutions inside double quotes run, but were treated as data: `echo "$(pkill node)"`, `x="$(killall node)"`.
- Wrappers with an option value and launchers passed: `sudo -u USER`, `env -u VAR`, `nice -n N`, `timeout`, `xargs`, `watch`, `bash -c`/`sh -c`, `eval`, and a heredoc fed to a shell (`bash <<EOF`). Now also followed: `su -c`, `trap`, `env -S`, here-strings and `echo … |` fed to a shell, and more wrappers (see the README).
- `kill -9 -1`, `kill -- -1` and `kill -TERM 0` passed as "kill <pid>". `kill -1` and `kill 0` targets are now blocked. `kill -1 <pid>` (SIGHUP) and `kill -- -<pgid>` still pass.
- PIDs from pgrep/pidof/ps/lsof/fuser that go through a variable, array, `for` loop or `read` were not caught: `PID=$(lsof -ti:3000); kill $PID`, `for pid in $(pgrep node); do kill $pid; done`, `pgrep node | while read p; do kill $p; done`.
- `fuser --kill` and xargs options with a separate value (`xargs -n 1 kill`, `xargs -I {} kill {}`) passed.
- Protected units could be stopped with `service <unit> stop|restart`, `systemctl force-reload`, a systemctl option with a value (`-s KILL`, `-H host`), a template instance (`foo@1` when `foo` is listed), `launchctl kickstart -k`, or `launchctl unload <label>.plist`.
- False positives: `cat /tmp/ps.pids | xargs kill` (`ps` inside a path) and `command -v pkill` were blocked.
- The message Claude sees on a block started with the whole inline hook command, including a "node was not found on PATH" sentence that did not apply. The wrapper moved to `hooks/kill-guard.sh`, so the message now starts with a short command.

Changed:

- The `kill $(pgrep …)` and `… | xargs kill` rules work on the parsed command instead of the raw text. `echo "kill $(pgrep node)"` or a commit message that mentions it only runs `pgrep`, so it now passes.
- With `KILL_GUARD_PATTERN` set, a pkill/killall pattern only known at run time (`pkill "$NAME"`, `xargs pkill`) is blocked, because it cannot be checked.

### rules-drift

- With `RULES_DRIFT_REF`, the "diff too long", "previous content unknown" and "deleted" messages pointed at the working-tree file, which doesn't have the change. They now say `git -C <root> show <ref>:<file>`.
- A ref that doesn't resolve silently fell back to the working tree, and a false diff followed once the ref appeared. Now nothing is checked or recorded until the ref resolves, and the first check after that records a quiet baseline.
- A tracked file deleted on the ref was never reported while the working tree still had it. It now counts as deleted.
- `statusOf` lists `unknown` files when the record's ref doesn't resolve.

### Docs

- README: Bash and Monitor coverage, every systemctl action, `service` and `kickstart -k`, a "What stays out of reach" list, the `RULES_DRIFT_REF` rules above, and that Claude Code re-attaches a changed `CLAUDE.md` on `--resume`, so rules-drift's value is mid-session.

## 0.1.0 (2026-10-18)

First release: rules-drift and kill-guard as a Claude Code plugin.
