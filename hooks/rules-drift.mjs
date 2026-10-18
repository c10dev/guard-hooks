#!/usr/bin/env node
// rules-drift: when a rules file (default CLAUDE.md, AGENTS.md) changes after a Claude Code session started,
// give the running session the diff on its next turn.
//   start (SessionStart)                  record the session's baseline hashes. On resume, keep the existing record
//   check (UserPromptSubmit, PostToolUse) if something changed, emit the diff as hookSpecificOutput.additionalContext
//                                         and mark the new hashes as acknowledged
// Options (CLI flag, else env var, else default):
//   --root <repo>       project root (default $CLAUDE_PROJECT_DIR, else the hook input's cwd)
//   --ref <git ref>     RULES_DRIFT_REF    read files from this ref, e.g. origin/main. Files the ref does not have
//                                          (untracked files) are read from the working tree. Default: working tree
//   --files a,b         RULES_DRIFT_FILES  comma-separated paths relative to the root. Default CLAUDE.md,AGENTS.md
//   RULES_DRIFT=off     do nothing
// Reads only the watched files, never the conversation transcript. No network.
// On any error it prints nothing and exits 0, so it never blocks a prompt or tool call.
// State: <state dir>/rules-drift/<sessionId>.json, file contents for diffs in rules-drift/blobs/<sha256>.
// State dir: $GUARD_HOOKS_STATE_DIR, else $CLAUDE_PLUGIN_DATA, else $XDG_STATE_HOME/guard-hooks,
// else ~/.local/state/guard-hooks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FILES = ["CLAUDE.md", "AGENTS.md"];
export const MAX_DIFF_LINES = 150; // longer diffs are cut and the session is told to re-read the file
const MAX_DIFF_CELLS = 4_000_000; // skip the diff when old lines x new lines exceeds this (too slow)
const CONTEXT = 3;
export const CHECK_EVERY_MS = 30_000; // PostToolUse checks at most this often (keeps tool calls fast)
export const STALE_MS = 7 * 86_400_000; // session records not checked for this long are deleted
const SESSION_RE = /^[\w-]{1,128}$/;

export function stateDir(env = process.env) {
  const base = env.GUARD_HOOKS_STATE_DIR || env.CLAUDE_PLUGIN_DATA || join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "guard-hooks");
  return join(base, "rules-drift");
}

const splitList = (v) => v.split(",").map((f) => f.trim()).filter(Boolean);

// ---- arguments ----
export function parseArgs(argv, env = process.env) {
  const out = { mode: argv[0], root: null, ref: env.RULES_DRIFT_REF || null, files: env.RULES_DRIFT_FILES ? splitList(env.RULES_DRIFT_FILES) : DEFAULT_FILES };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === "--root" && v) (out.root = v), i++;
    else if (argv[i] === "--ref" && v) (out.ref = v), i++;
    else if (argv[i] === "--files" && v) (out.files = splitList(v)), i++;
  }
  // never watch absolute paths or paths outside the root
  out.files = out.files.filter((f) => !isAbsolute(f) && !normalize(f).startsWith(".."));
  return out;
}

// ---- reading ----
export const sha = (text) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

// Current content of a watched file, or null when it does not exist (a missing file is a state too).
// With a ref, the file at that ref; if the ref does not have it (untracked file), the working tree copy
export function readSource(root, ref, file) {
  if (ref) {
    try {
      return execFileSync("git", ["-C", root, "show", `${ref}:${file}`], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {}
  }
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}

// ---- diff (dependency-free line LCS, unified format) ----
export function unifiedDiff(oldText, newText, file, max = MAX_DIFF_LINES) {
  const a = oldText === null ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === null ? [] : newText.replace(/\n$/, "").split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) return { text: null, truncated: true };
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = []; // [kind, text, aLine, bLine]
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([" ", a[i], i++, j++]);
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(["-", a[i], i++, j]); // deletions first, like git
    else ops.push(["+", b[j], i, j++]);
  }
  const hunks = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === " ") continue;
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    // changes within twice the context of each other share a hunk
    for (let x = k; x < ops.length; x++) {
      if (ops[x][0] !== " ") end = x;
      else if (x - end > CONTEXT * 2) break;
    }
    end = Math.min(ops.length - 1, end + CONTEXT);
    if (hunks.length && start <= hunks[hunks.length - 1].end + 1) hunks[hunks.length - 1].end = end;
    else hunks.push({ start, end });
    k = end;
  }
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const h of hunks) {
    const seg = ops.slice(h.start, h.end + 1);
    const aStart = seg[0][2] + 1;
    const bStart = seg[0][3] + 1;
    const aLen = seg.filter((o) => o[0] !== "+").length;
    const bLen = seg.filter((o) => o[0] !== "-").length;
    lines.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of seg) lines.push(`${o[0]}${o[1]}`);
  }
  if (lines.length > max) return { text: lines.slice(0, max).join("\n"), truncated: true };
  return { text: lines.join("\n"), truncated: false };
}

// ---- the message given to the session ----
// changes: [{file, before, after}] contents; before null = file did not exist, undefined = previous content unknown
export function contextOf(changes, root, max = MAX_DIFF_LINES) {
  const out = [`[rules-drift] Rules files changed since this session started: ${changes.map((c) => c.file).join(", ")}. Follow the changes below from now on.`];
  let budget = max;
  for (const c of changes) {
    const path = join(root, c.file);
    if (c.after === null) {
      out.push(`- ${c.file}: the file was deleted (${path}).`);
      continue;
    }
    if (c.before === undefined) {
      out.push(`- ${c.file}: no diff because the previous content is unknown. Re-read ${path} with the Read tool.`);
      continue;
    }
    const d = budget > 2 ? unifiedDiff(c.before, c.after, c.file, budget) : { text: null, truncated: true };
    if (d.text) {
      out.push(d.text);
      budget -= d.text.split("\n").length;
    }
    if (d.truncated) out.push(`- ${c.file}: the diff is too long and was ${d.text ? "cut" : "left out"}. Re-read ${path} with the Read tool.`);
  }
  return out.join("\n");
}

// ---- state ----
const recordPath = (dir, sessionId) => join(dir, `${sessionId}.json`);
const blobPath = (dir, h) => join(dir, "blobs", h);

export function readRecord(dir, sessionId) {
  try {
    const r = JSON.parse(readFileSync(recordPath(dir, sessionId), "utf8"));
    return r && typeof r === "object" && r.acked && typeof r.acked === "object" ? r : null;
  } catch {
    return null; // missing or corrupt: start over
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function saveBlob(dir, text) {
  if (text === null) return;
  const h = sha(text);
  const p = blobPath(dir, h);
  try {
    statSync(p);
  } catch {
    mkdirSync(join(dir, "blobs"), { recursive: true });
    writeAtomic(p, text);
  }
}

function readBlob(dir, h) {
  if (!h) return null;
  try {
    return readFileSync(blobPath(dir, h), "utf8");
  } catch {
    return undefined; // previous content unknown
  }
}

function writeRecord(dir, rec) {
  mkdirSync(dir, { recursive: true });
  writeAtomic(recordPath(dir, rec.sessionId), JSON.stringify(rec) + "\n");
}

// Delete stale session records and blobs no record points to
export function cleanup(dir, now = Date.now()) {
  const keep = new Set();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (now - Date.parse(r.checkedAt) > STALE_MS) rmSync(join(dir, f), { force: true });
      else for (const h of Object.values(r.acked ?? {})) if (h) keep.add(h);
    } catch {
      rmSync(join(dir, f), { force: true });
    }
  }
  try {
    for (const h of readdirSync(join(dir, "blobs"))) if (!keep.has(h) && !h.endsWith(".tmp")) rmSync(join(dir, "blobs", h), { force: true });
  } catch {}
}

// ---- one run: the string to print, or null ----
export function run(args, input, { dir = stateDir(), now = Date.now(), env = process.env } = {}) {
  if (env.RULES_DRIFT === "off") return null;
  const sessionId = input?.session_id;
  if (!sessionId || !SESSION_RE.test(sessionId)) return null;
  const root = args.root || env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!root || !args.files.length) return null;
  const at = new Date(now).toISOString();
  const current = Object.fromEntries(args.files.map((f) => [f, readSource(root, args.ref, f)]));
  const baseline = () => ({ v: 1, sessionId, root, ref: args.ref, files: args.files, startedAt: at, checkedAt: at, acked: Object.fromEntries(args.files.map((f) => [f, sha(current[f])])) });

  if (args.mode === "start") {
    const prev = readRecord(dir, sessionId);
    // resume continues the same conversation, so keep its baseline. startup, clear and compact load the rules afresh
    if (!(input.source === "resume" && prev)) {
      for (const f of args.files) saveBlob(dir, current[f]);
      writeRecord(dir, baseline());
    }
    cleanup(dir, now);
    return null;
  }
  if (args.mode !== "check") return null;

  const rec = readRecord(dir, sessionId);
  if (!rec || rec.root !== root || (rec.ref ?? null) !== (args.ref ?? null)) {
    // first time we see this session without a start (hook installed mid-session) or its config changed:
    // take the current state as the baseline and say nothing
    for (const f of args.files) saveBlob(dir, current[f]);
    writeRecord(dir, baseline());
    return null;
  }
  if (input.hook_event_name === "PostToolUse" && now - Date.parse(rec.checkedAt) < CHECK_EVERY_MS) return null;
  const changes = args.files
    .filter((f) => f in rec.acked && rec.acked[f] !== sha(current[f]))
    .map((f) => ({ file: f, before: readBlob(dir, rec.acked[f]), after: current[f] }));
  const acked = { ...rec.acked };
  for (const f of args.files) {
    if (!(f in acked)) {
      acked[f] = sha(current[f]); // newly watched file: track from now on (keep its content for the next diff)
      saveBlob(dir, current[f]);
    }
    for (const c of changes) if (c.file === f) acked[f] = sha(current[f]);
  }
  for (const c of changes) saveBlob(dir, c.after);
  writeRecord(dir, { ...rec, files: args.files, checkedAt: at, acked, ...(changes.length ? { changedAt: at } : {}) });
  if (!changes.length) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || "UserPromptSubmit", additionalContext: contextOf(changes, root) } });
}

// ---- status helpers for external tools (e.g. a dashboard listing sessions) ----
// Compare a session record's acknowledged hashes with the current files. behind = files that changed since
export function statusOf(rec, read = readSource) {
  const behind = [];
  for (const f of rec.files ?? Object.keys(rec.acked ?? {})) {
    const now = sha(read(rec.root, rec.ref ?? null, f));
    if ((rec.acked ?? {})[f] !== now) behind.push(f);
  }
  return { current: behind.length === 0, behind };
}

export function readRecords(dir = stateDir()) {
  const out = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (r && r.sessionId && r.root && r.acked) out.push(r);
      } catch {}
    }
  } catch {}
  return out;
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = JSON.parse(readFileSync(0, "utf8"));
    const out = run(args, input);
    if (out) process.stdout.write(out);
  } catch {}
  process.exit(0);
}
