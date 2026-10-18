# guard-hooks

Two small Claude Code hooks for people who run several sessions at once. Plain Node.js, no dependencies.

- **rules-drift** tells running sessions when `CLAUDE.md` or `AGENTS.md` changes, and gives them the diff.
- **kill-guard** blocks Bash commands that kill processes by name or pattern (`pkill`, `killall`, `kill $(pgrep …)`, `fuser -k`, …).

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

**Watching a branch instead of the working tree.** Set `RULES_DRIFT_REF=origin/main` and the hook reads the files at that ref (`git show origin/main:CLAUDE.md`). This suits worktree setups: sessions on feature branches learn about rules that landed on `main` as soon as anyone runs `git fetch`, without merging. The hook never fetches by itself. Files that the ref doesn't have (untracked files) are read from the working tree.

**Never blocks.** On any error (bad input, unwritable state directory, `node` missing) it prints nothing and exits 0.

**Privacy.** It reads only the watched files inside the project root. It never reads the conversation transcript and makes no network calls. Absolute paths and paths outside the root are ignored.

## kill-guard

A `PreToolUse` hook on `Bash`. `pkill -f "node server/index.ts"` stops your test server, and also every other process whose command line matches: another session's dev server, or the production instance running the same file. That happened to the author, which is why this hook exists.

Blocked by default:

- `pkill …`, `killall …`
- `kill $(pgrep …)`, `` kill `pidof …` ``, `kill $(lsof -t -i:3000)`
- `pgrep … | xargs kill`, `ps … | xargs kill`, `lsof -ti:3000 | xargs kill`
- `fuser -k …`
- `systemctl stop|restart|kill|disable|mask …` and `launchctl stop|kill|bootout|unload|remove|disable …`, but only for units you list in `KILL_GUARD_UNITS`

Allowed: `kill <pid>`, `kill "$(cat server.pid)"`, and commands that only mention `pkill`, `killall`, `fuser` or `systemctl` (`echo 'pkill node'`, `git log --grep pkill`, heredoc bodies): those are checked per command word with a small shell tokenizer. The `kill $(pgrep …)` and `… | xargs kill` shapes are matched on the raw text, so they are blocked even inside quotes.

When it blocks, Claude sees why and what to do instead:

```
KILL GUARD: blocked because pkill kills every process matching a name or pattern. … When you start a process,
save its PID (`… & echo $! > /tmp/<name>.pid`) and stop it only with `kill "$(cat /tmp/<name>.pid)"`.
Do not touch processes you did not start; if one has to stop, ask the user.
```

**Fails closed.** If the hook input can't be read or parsed, or `node` is not on `PATH`, the Bash call is blocked (exit 2) with a message that says so. Set `KILL_GUARD=off` to turn it off.

It is a guard rail for an agent that means well, not a sandbox. A determined command (`python -c "os.kill(…)"`, a script file) can get past it.

## Install

From GitHub (replace `<owner>/<repo>` with where this repository lives):

```
/plugin marketplace add <owner>/<repo>
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
| `RULES_DRIFT_REF` | unset (working tree) | Git ref to read the files from, e.g. `origin/main`. |
| `GUARD_HOOKS_STATE_DIR` | see below | Where rules-drift keeps its per-session records. |
| `KILL_GUARD` | on | `off` disables kill-guard. |
| `KILL_GUARD_PATTERN` | unset (block all) | Regex (case-insensitive). If set, `pkill`/`killall` are blocked only when a pattern argument matches it, e.g. `node\|server/index\|myapp`. The other rules still apply. An invalid regex blocks all. |
| `KILL_GUARD_UNITS` | unset | Comma-separated systemd units or launchd labels that must not be stopped or restarted. |
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
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /path/to/hooks/kill-guard.mjs || exit 2" }] }]
  }
}
```

## Development

```bash
npm test
```

Tests use `node:test` only. `test/plugin.test.mjs` runs the commands from `hooks/hooks.json` through bash exactly as Claude Code does.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
