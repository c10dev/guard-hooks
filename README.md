# guard-hooks

Two small Claude Code hooks for people who run several sessions at once. Plain Node.js, no dependencies.

- **rules-drift** tells running sessions when `CLAUDE.md` or `AGENTS.md` changes, and gives them the diff.
- **kill-guard** blocks Bash and Monitor commands that kill processes by name or pattern (`pkill`, `killall`, `kill $(pgrep …)`, `fuser -k`, `npx kill-port`, …).

Both started in [atc](https://github.com/c10dev/atc), a local control panel for many parallel Claude Code sessions, and were made general for this plugin.

## rules-drift

Claude Code reads `CLAUDE.md` when a session starts. If you edit the rules while a long session is running (or another session merges a rules change), that session can keep working from the old version. rules-drift closes that gap:

| Event | What happens |
| --- | --- |
| `SessionStart` | Records a hash of each watched file for this session (resume keeps the existing record). |
| `UserPromptSubmit` | If a watched file changed since the last check, adds a unified diff to the turn as `additionalContext`, then marks it as seen. |
| `PostToolUse` | Same check, at most once every 30 seconds, so a change also lands in the middle of a long autonomous run. |

What the session sees:

```
[rules-drift] Rules files changed since this session started: CLAUDE.md. Follow the changes below from now on.
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,1 +1,2 @@
 # rules v1
+- Always answer in French.
```

Each change is reported once. Diffs longer than 150 lines are cut, and the session is told to re-read the file. A file that appears or disappears counts as a change.

**Where it adds something.** Claude Code itself re-attaches a changed `CLAUDE.md` when a session is resumed (seen with 2.1.302), so on `--resume` the rules-drift diff repeats what the session already has. What Claude Code does not do is tell a session about a change that lands while it is running. rules-drift does that on the next prompt, or within 30 seconds during a long run of tool calls. It also covers files Claude Code does not load (whatever you add to `RULES_DRIFT_FILES`) and rules on another branch (`RULES_DRIFT_REF`).

**Watching a branch instead of the working tree.** Set `RULES_DRIFT_REF=origin/main` and the hook reads the files at that ref (`git show origin/main:CLAUDE.md`). This suits worktree setups: sessions on feature branches learn about rules that landed on `main` as soon as anyone runs `git fetch`, without merging. The hook never fetches by itself.

- Files not under version control are read from the working tree. A tracked file that the ref doesn't have counts as deleted, even if the working tree still has it.
- When a cut or unknown diff comes from the ref, the session is told to run `git -C <root> show <ref>:<file>`, because the working-tree copy doesn't have the change.
- While the ref doesn't resolve (not a git repository, not fetched yet, a typo), rules-drift checks and records nothing in that project. The first check after it resolves records a baseline without reporting anything.

**Never blocks.** On any error (bad input, unwritable state directory, `node` missing) it prints nothing and exits 0.

**Privacy.** It reads only the watched files inside the project root. It never reads the conversation transcript and makes no network calls. Absolute paths and paths outside the root are ignored.

## kill-guard

A `PreToolUse` hook on `Bash` and `Monitor` (Monitor runs a shell command too; a Monitor call without one, such as a WebSocket source, passes). `pkill -f "node server/index.ts"` stops your test server, and also every other process whose command line matches: another session's dev server, or the production instance running the same file. That happened to the author, which is why this hook exists.

Blocked by default:

- `pkill …`, `killall …`
- `kill` with PIDs found by name, pattern or port: `kill $(pgrep …)`, `` kill `pidof …` ``, `kill $(lsof -t -i:3000)`, also when the PIDs go through a variable, array or loop first (`PID=$(lsof -ti:3000); kill $PID`, `for p in $(pgrep node); do kill $p; done`, `pgrep node | while read p; do kill $p; done`)
- `pgrep … | xargs kill`, `ps … | xargs kill`, `lsof -ti:3000 | xargs -n 1 kill` (`pgrep`, `pidof`, `ps`, `lsof` and `fuser` count as PID sources)
- `kill -1` (every process you may signal) and `kill 0` (your whole process group)
- `fuser -k …`, `fuser --kill …`
- npm port killers, installed or run through a package runner (`npx`, `npm exec`, `pnpm dlx`, `pnpm exec`, `pnpx`, `bunx`, `bun x`, `yarn dlx`, `yarn exec`), also with a version (`kill-port@2`) or `--package`:
  - `kill-port …` and `kill-port-process …`: `npx kill-port 3000`, `npx -y kill-port 3000 5173`, `pnpm dlx kill-port 3000`, `kill-port --port 3000`. `kill-port` alone or with only `--help`, `--version` or `--verbose` passes.
  - `fkill`/`fkill-cli` with a port (`fkill :3000`), a name (`fkill node`, which kills like `pkill`), `-1` or `0` (as with `kill`). `fkill <pid>` passes.
- Only for units you list in `KILL_GUARD_UNITS`:
  - `systemctl stop|restart|try-restart|reload-or-restart|try-reload-or-restart|reload-or-try-restart|force-reload|kill|disable|mask|isolate …`
  - `service <unit> stop|restart|try-restart|force-reload|condrestart|--full-restart`
  - `launchctl stop|kill|bootout|unload|remove|disable …` and `launchctl kickstart -k …`

How it reads a command: a small shell parser finds what runs in command position. It looks past shell keywords (`if … then`, `for … do`, `{ …; }`, `!`), variable assignments, redirections and wrappers (`sudo -u USER`, `doas`, `env`, `nice`, `ionice`, `chrt`, `taskset`, `timeout`, `stdbuf`, `nohup`, `setsid`, `time`, `exec`, `command`, `runuser`, `xargs`, `watch`, and the package runners above). Runner options also count where npm and pnpm read them, before the subcommand (`npm --package <pkg> exec`, `pnpm -c exec`). It checks the command strings given to `bash -c`/`sh -c`/`zsh -c`, `eval`, `su -c`, `trap`, `watch`, `env -S`, `npx -c`/`npm -c … exec`, `pnpm -c exec`/`pnpm dlx -c` and `yarn exec` (yarn 4 runs its argument as shell code), heredocs, here-strings and `echo … |` fed to a shell, and command substitutions, including those inside double quotes and unquoted heredocs (the shell runs them).

Allowed: `kill <pid>`, `kill "$(cat server.pid)"`, `fkill <pid>`, `kill $!`, `kill %1`, `kill -1 <pid>` (SIGHUP to one process), `kill -- -<pgid>` (a process group you name, like a PID you name), and commands that only mention these words: `echo 'pkill node'`, `echo "kill $(pgrep node)"` (it only runs `pgrep`), `git log --grep pkill`, `command -v pkill`, a quoted heredoc written to a file.

When it blocks, Claude sees why and what to do instead:

```
KILL GUARD: blocked because pkill kills every process matching a name or pattern. … When you start a process,
save its PID (`… & echo $! > /tmp/<name>.pid`) and stop it only with `kill "$(cat /tmp/<name>.pid)"`.
Do not touch processes you did not start; if one has to stop, ask the user.
```

**Fails closed.** If the hook input can't be read or parsed, or `node` is not on `PATH`, the call is blocked (exit 2) with a message that says so. Set `KILL_GUARD=off` to turn it off.

### What stays out of reach

kill-guard is a guard rail for an agent that means well, not a sandbox. It covers the shapes such an agent writes, and a determined command can still get past it. It does not see:

- code in another language or file: `python -c "os.kill(…)"`, `node -e …`, a script (`./stop.sh`, `bash stop.sh`), a package script (`npm run kill`, or `yarn kill-port` when `kill-port` is a script or bin of the project)
- port killers under other names, and runner options not listed in the hook that take a value (`npx --foo bar kill-port 3000`)
- other machines and containers: `ssh host pkill …`, `docker exec … kill …`
- state from earlier calls: a variable or shell function set in a previous Bash call, or PIDs that `pgrep` wrote to a file and a later `kill $(cat …)` reads back
- commands built at run time: `$CMD node` with `CMD=pkill`, `$(which pkill) node`, aliases
- less common shapes: PIDs parsed out of `ss -p` or `netstat -p`, `mapfile`/`readarray`, launchers not listed above (`systemd-run`, `find -exec`, `parallel`), `/etc/init.d/<unit> stop`, unit globs (`systemctl stop 'my*'`)
- other tools that run commands, such as PowerShell on Windows (`Stop-Process`, `taskkill`)

## Install

From GitHub:

```
/plugin marketplace add c10dev/guard-hooks
/plugin install guard-hooks@guard-hooks
```

From a local clone:

```
/plugin marketplace add /path/to/guard-hooks
/plugin install guard-hooks@guard-hooks
```

Or try it for one session without installing:

```bash
claude --plugin-dir /path/to/guard-hooks
```

Requires Node.js 18 or newer on `PATH` (20+ to run the tests).

## Configuration

Everything is set with environment variables. Put them in the `env` block of `.claude/settings.json` (per project) or `~/.claude/settings.json` (everywhere); hooks inherit them.

```json
{
  "env": {
    "RULES_DRIFT_FILES": "CLAUDE.md,AGENTS.md,docs/style-guide.md",
    "RULES_DRIFT_REF": "origin/main",
    "KILL_GUARD_UNITS": "myapp,postgresql",
    "KILL_GUARD_HINT": "To redeploy, run ./deploy.sh."
  }
}
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RULES_DRIFT` | on | `off` disables rules-drift. |
| `RULES_DRIFT_FILES` | `CLAUDE.md,AGENTS.md` | Comma-separated paths relative to the project root. |
| `RULES_DRIFT_REF` | unset (working tree) | Git ref to read the files from, e.g. `origin/main`. Nothing is checked while it doesn't resolve. |
| `GUARD_HOOKS_STATE_DIR` | see below | Where rules-drift keeps its per-session records. |
| `KILL_GUARD` | on | `off` disables kill-guard. |
| `KILL_GUARD_PATTERN` | unset (block all) | Regex (case-insensitive). If set, `pkill`/`killall` and `fkill <name>` are blocked only when a pattern argument matches it, e.g. `node\|server/index\|myapp`. A pattern only known at run time (`pkill "$NAME"`, `xargs pkill`) is blocked. The other rules still apply. An invalid regex blocks all. |
| `KILL_GUARD_UNITS` | unset | Comma-separated systemd units or launchd labels that must not be stopped or restarted (`systemctl`, `service`, `launchctl`). A template name such as `worker` also covers its instances (`worker@1`). |
| `KILL_GUARD_HINT` | unset | Text appended to the block message, e.g. how to restart a service properly. |

The project root is `$CLAUDE_PROJECT_DIR`, or the session's working directory.

### State

rules-drift stores one small JSON record per session, plus the watched files' contents (to build diffs), in `<state dir>/rules-drift/`. The state dir is the first of: `$GUARD_HOOKS_STATE_DIR`, the plugin data directory Claude Code provides (`$CLAUDE_PLUGIN_DATA`), `$XDG_STATE_HOME/guard-hooks`, `~/.local/state/guard-hooks`. Records not checked for 7 days are deleted, along with contents no record refers to.

## Using the scripts without the plugin

The hooks are standalone scripts, so you can wire them into `settings.json` yourself (the CLI flags `--files`, `--ref` and `--root` override the env vars):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/hooks/rules-drift.mjs start --ref origin/main; exit 0" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/hooks/rules-drift.mjs check --ref origin/main; exit 0" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/hooks/rules-drift.mjs check --ref origin/main; exit 0" }] }],
    "PreToolUse": [{ "matcher": "Bash|Monitor", "hooks": [{ "type": "command", "command": "node /path/to/hooks/kill-guard.mjs || exit 2" }] }]
  }
}
```

## Development

```bash
npm test
```

Tests use `node:test` only. `test/plugin.test.mjs` runs the commands from `hooks/hooks.json` through bash exactly as Claude Code does. `test/probes.test.mjs` runs every probe from the independent verification of 0.1.0 against the real hook process, plus the npm port killer shapes and a list of ordinary agent commands that must keep passing.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
