# kill-guard launcher, run by hooks.json as `/bin/sh <this file>`, so a block message starts with a short command.
# KILL_GUARD=off turns the guard off. Without node on PATH every call is blocked (fail-closed), and so is any
# other failure of the check: only exit 0 lets the tool call run.
[ "$KILL_GUARD" = off ] && exit 0
command -v node >/dev/null 2>&1 || {
  echo 'KILL GUARD: node was not found on PATH, so Bash and Monitor commands cannot be checked and are blocked. Install Node.js 18+, or set KILL_GUARD=off to turn the guard off.' >&2
  exit 2
}
case $0 in */*) dir=${0%/*} ;; *) dir=. ;; esac
node "$dir/kill-guard.mjs" || exit 2
