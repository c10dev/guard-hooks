import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, contextOf, MAX_DIFF_LINES, parseArgs, readRecord, run, stateDir, statusOf, unifiedDiff } from "../hooks/rules-drift.mjs";

const SCRIPT = fileURLToPath(new URL("../hooks/rules-drift.mjs", import.meta.url));

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "rules-drift-"));
  const root = join(base, "repo");
  const dir = join(base, "state", "rules-drift");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "# Rules\n\n- one\n- two\n");
  writeFileSync(join(root, "AGENTS.md"), "# agents\n");
  return { base, root, dir, done: () => rmSync(base, { recursive: true, force: true }) };
}
const args = (mode, root, extra = []) => parseArgs([mode, "--root", root, ...extra], {});
const input = (event, extra = {}) => ({ session_id: "sess-1", cwd: "/nowhere", hook_event_name: event, transcript_path: "/must/not/read", ...extra });

test("no change: no output", () => {
  const s = sandbox();
  try {
    assert.equal(run(args("start", s.root), input("SessionStart", { source: "startup" }), { dir: s.dir }), null);
    assert.equal(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir }), null);
    assert.equal(run(args("check", s.root), input("PostToolUse"), { dir: s.dir, now: Date.now() + 60_000 }), null);
  } finally {
    s.done();
  }
});

test("change: the diff is given once and acknowledged; the next check is quiet", () => {
  const s = sandbox();
  try {
    run(args("start", s.root), input("SessionStart", { source: "startup" }), { dir: s.dir });
    writeFileSync(join(s.root, "CLAUDE.md"), "# Rules\n\n- one\n- two (fixed)\n- three\n");
    const out = JSON.parse(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir }));
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Rules files changed since this session started: CLAUDE\.md\./);
    assert.match(ctx, /--- a\/CLAUDE\.md\n\+\+\+ b\/CLAUDE\.md\n@@ -1,4 \+1,5 @@/);
    assert.match(ctx, /\n-- two\n\+- two \(fixed\)\n\+- three/);
    assert.ok(!/AGENTS/.test(ctx));
    assert.equal(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir }), null);
    // PostToolUse gets the same shape (only the event name differs) and is throttled to once per 30 s
    writeFileSync(join(s.root, "AGENTS.md"), "# agents\n- new rule\n");
    assert.equal(run(args("check", s.root), input("PostToolUse"), { dir: s.dir }), null);
    const later = JSON.parse(run(args("check", s.root), input("PostToolUse"), { dir: s.dir, now: Date.now() + 31_000 }));
    assert.equal(later.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(later.hookSpecificOutput.additionalContext, /\+- new rule/);
  } finally {
    s.done();
  }
});

test("a new session starts from the current hashes (earlier changes are not reported); resume keeps its baseline", () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "CLAUDE.md"), "# Rules v2\n");
    run(args("start", s.root), input("SessionStart", { session_id: "sess-2", source: "startup" }), { dir: s.dir });
    assert.equal(run(args("check", s.root), input("UserPromptSubmit", { session_id: "sess-2" }), { dir: s.dir }), null);
    // resume: changes made in between are reported on the next check
    writeFileSync(join(s.root, "CLAUDE.md"), "# Rules v3\n");
    run(args("start", s.root), input("SessionStart", { session_id: "sess-2", source: "resume" }), { dir: s.dir });
    assert.match(run(args("check", s.root), input("UserPromptSubmit", { session_id: "sess-2" }), { dir: s.dir }), /v3/);
    // a session seen for the first time without start (hook installed mid-session): baseline now, say nothing
    assert.equal(run(args("check", s.root), input("UserPromptSubmit", { session_id: "sess-3" }), { dir: s.dir }), null);
    assert.ok(readRecord(s.dir, "sess-3"));
  } finally {
    s.done();
  }
});

test("fail open: missing files, corrupt state and bad input never block", () => {
  const s = sandbox();
  try {
    // a watched file may be missing (missing is a state too)
    rmSync(join(s.root, "AGENTS.md"));
    run(args("start", s.root), input("SessionStart", { source: "startup" }), { dir: s.dir });
    assert.equal(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir }), null);
    writeFileSync(join(s.root, "AGENTS.md"), "# created\n");
    assert.match(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir }), /\+# created/);
    // corrupt state file: start over from now
    writeFileSync(join(s.dir, "sess-1.json"), "{not json");
    assert.equal(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir }), null);
    assert.ok(readRecord(s.dir, "sess-1"));
    // odd session ids are ignored
    assert.equal(run(args("check", s.root), input("UserPromptSubmit", { session_id: "../x" }), { dir: s.dir }), null);
    // real process: unwritable state dir, broken stdin → no output, exit 0
    const notDir = join(s.base, "a-file");
    writeFileSync(notDir, "x"); // a file where the state dir should be → ENOTDIR
    for (const stdin of ["{broken", JSON.stringify(input("UserPromptSubmit"))]) {
      const r = spawnSync(process.execPath, [SCRIPT, "check", "--root", s.root], { input: stdin, env: { ...process.env, GUARD_HOOKS_STATE_DIR: notDir }, encoding: "utf8", timeout: 5000 });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
  } finally {
    s.done();
  }
});

test("diff limit: long diffs are cut with an instruction to re-read the file", () => {
  const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const after = Array.from({ length: 400 }, (_, i) => `line ${i} fixed`).join("\n");
  const d = unifiedDiff(before, after, "CLAUDE.md");
  assert.equal(d.truncated, true);
  assert.equal(d.text.split("\n").length, MAX_DIFF_LINES);
  const ctx = contextOf([{ file: "CLAUDE.md", before, after }], "/repo");
  assert.match(ctx, /the diff is too long and was cut\. Re-read \/repo\/CLAUDE\.md with the Read tool/);
  assert.ok(ctx.split("\n").length <= MAX_DIFF_LINES + 3);
  // unknown previous content: no diff, just the instruction
  assert.match(contextOf([{ file: "AGENTS.md", before: undefined, after: "x" }], "/repo"), /previous content is unknown/);
});

test("unified diff shape: 3 lines of context, distant changes get separate hunks", () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const b = [...a];
  b[2] = "L2";
  b[25] = "L25";
  const d = unifiedDiff(a.join("\n"), b.join("\n"), "f.md").text.split("\n");
  assert.deepEqual(d.filter((l) => l.startsWith("@@")), ["@@ -1,6 +1,6 @@", "@@ -23,7 +23,7 @@"]);
});

test("never reads the transcript; never watches files outside the root", () => {
  assert.deepEqual(parseArgs(["check", "--files", "CLAUDE.md,../secret,/etc/passwd,docs/RULES.md"], {}).files, ["CLAUDE.md", "docs/RULES.md"]);
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/transcript_path\s*[)\]]|readFileSync\([^)]*transcript/.test(src));
});

test("--ref: reads files at the git ref, not the working tree", () => {
  const s = sandbox();
  try {
    const git = (...a) => execFileSync("git", ["-C", s.root, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "one");
    run(args("start", s.root, ["--ref", "main"]), input("SessionStart", { source: "startup" }), { dir: s.dir });
    writeFileSync(join(s.root, "CLAUDE.md"), "# only the working tree changed\n");
    assert.equal(run(args("check", s.root, ["--ref", "main"]), input("UserPromptSubmit"), { dir: s.dir }), null);
    git("commit", "-qam", "two");
    assert.match(run(args("check", s.root, ["--ref", "main"]), input("UserPromptSubmit"), { dir: s.dir }), /only the working tree changed/);
    // files the ref does not have (untracked) are read from the working tree
    writeFileSync(join(s.root, "LOCAL.md"), "local v1\n");
    const extra = ["--ref", "main", "--files", "CLAUDE.md,LOCAL.md"];
    assert.equal(run(args("check", s.root, extra), input("UserPromptSubmit"), { dir: s.dir }), null); // a newly watched file is tracked from now on
    writeFileSync(join(s.root, "LOCAL.md"), "local v2\n");
    assert.match(run(args("check", s.root, extra), input("UserPromptSubmit"), { dir: s.dir }), /\+local v2/);
  } finally {
    s.done();
  }
});

const gitIn = (root) => (...a) =>
  execFileSync("git", ["-C", root, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("--ref: hints for a change on the ref point at the ref, not at the working tree", () => {
  const s = sandbox();
  try {
    const git = gitIn(s.root);
    writeFileSync(join(s.root, "CLAUDE.md"), "# committed on main\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "one");
    git("branch", "other");
    const ref = ["--ref", "other"];
    run(args("start", s.root, ref), input("SessionStart", { source: "startup" }), { dir: s.dir });
    git("checkout", "-q", "other");
    writeFileSync(join(s.root, "CLAUDE.md"), "# committed on main\n" + Array.from({ length: 300 }, (_, i) => `- rule ${i}`).join("\n") + "\n");
    git("commit", "-qam", "300 lines on other");
    git("checkout", "-q", "main");
    const ctx = JSON.parse(run(args("check", s.root, ref), input("UserPromptSubmit"), { dir: s.dir })).hookSpecificOutput.additionalContext;
    assert.ok(ctx.split("\n").length <= MAX_DIFF_LINES + 3);
    assert.match(ctx, new RegExp(`- CLAUDE\\.md: the diff is too long and was cut\\. Run \`git -C ${s.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} show other:CLAUDE\\.md\` to read it\\.`));
    assert.ok(!/Read tool/.test(ctx));
    // the same for a file whose previous content is unknown, and for one deleted on the ref
    assert.match(contextOf([{ file: "AGENTS.md", before: undefined, after: "x", at: "ref" }], "/r", MAX_DIFF_LINES, "origin/main"), /Run `git -C \/r show origin\/main:AGENTS\.md` to read it/);
    assert.match(contextOf([{ file: "AGENTS.md", before: "x", after: null, at: "ref" }], "/r", MAX_DIFF_LINES, "origin/main"), /AGENTS\.md: the file was deleted on origin\/main\./);
  } finally {
    s.done();
  }
});

test("--ref: a ref that does not resolve records nothing; once it appears, the first check is a quiet baseline", () => {
  const s = sandbox();
  try {
    const git = gitIn(s.root);
    writeFileSync(join(s.root, "CLAUDE.md"), "# committed on main\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "one");
    writeFileSync(join(s.root, "CLAUDE.md"), "# committed on main\nlocal draft line\n"); // uncommitted
    const ref = ["--ref", "origin/main"];
    assert.equal(run(args("start", s.root, ref), input("SessionStart", { source: "startup" }), { dir: s.dir }), null);
    assert.equal(readRecord(s.dir, "sess-1"), null);
    assert.equal(run(args("check", s.root, ref), input("UserPromptSubmit"), { dir: s.dir }), null);
    assert.equal(readRecord(s.dir, "sess-1"), null);
    assert.deepEqual(statusOf({ root: s.root, ref: "origin/main", files: ["CLAUDE.md"], acked: {} }), { current: false, behind: [], unknown: ["CLAUDE.md"] });
    git("update-ref", "refs/remotes/origin/main", "main");
    assert.equal(run(args("check", s.root, ref), input("UserPromptSubmit"), { dir: s.dir }), null, "no false diff when the ref appears");
    assert.ok(readRecord(s.dir, "sess-1"));
    git("commit", "-qam", "two");
    git("update-ref", "refs/remotes/origin/main", "main");
    assert.match(run(args("check", s.root, ref), input("UserPromptSubmit"), { dir: s.dir }), /\+local draft line/);
    // a startup while the ref is missing drops the old baseline instead of keeping a stale one
    git("update-ref", "-d", "refs/remotes/origin/main");
    run(args("start", s.root, ref), input("SessionStart", { source: "startup" }), { dir: s.dir });
    assert.equal(readRecord(s.dir, "sess-1"), null);
  } finally {
    s.done();
  }
});

test("--ref: a tracked file deleted on the ref is reported even while it is still on disk", () => {
  const s = sandbox();
  try {
    const git = gitIn(s.root);
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "one");
    git("branch", "other");
    const ref = ["--ref", "other"];
    run(args("start", s.root, ref), input("SessionStart", { source: "startup" }), { dir: s.dir });
    git("checkout", "-q", "other");
    git("rm", "-q", "AGENTS.md");
    git("commit", "-qm", "drop AGENTS.md");
    git("checkout", "-q", "main");
    assert.ok(existsSync(join(s.root, "AGENTS.md")));
    const ctx = JSON.parse(run(args("check", s.root, ref), input("UserPromptSubmit"), { dir: s.dir })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /changed since this session started: AGENTS\.md\./);
    assert.match(ctx, /- AGENTS\.md: the file was deleted on other\./);
  } finally {
    s.done();
  }
});

test("cleanup removes records unchecked for 7+ days and orphan blobs; statusOf", () => {
  const s = sandbox();
  try {
    run(args("start", s.root), input("SessionStart", { source: "startup" }), { dir: s.dir });
    run(args("start", s.root), input("SessionStart", { session_id: "old", source: "startup" }), { dir: s.dir, now: Date.now() - 8 * 86_400_000 });
    writeFileSync(join(s.dir, "blobs", "deadbeef"), "orphan");
    cleanup(s.dir);
    assert.ok(existsSync(join(s.dir, "sess-1.json")));
    assert.ok(!existsSync(join(s.dir, "old.json")));
    assert.ok(!readdirSync(join(s.dir, "blobs")).includes("deadbeef"));
    const rec = readRecord(s.dir, "sess-1");
    assert.deepEqual(statusOf(rec), { current: true, behind: [] });
    writeFileSync(join(s.root, "CLAUDE.md"), "changed\n");
    assert.deepEqual(statusOf(rec), { current: false, behind: ["CLAUDE.md"] });
  } finally {
    s.done();
  }
});

test("config from env: RULES_DRIFT_FILES, RULES_DRIFT_REF; CLI flags win; RULES_DRIFT=off", () => {
  const env = { RULES_DRIFT_FILES: "CLAUDE.md, docs/RULES.md,../x", RULES_DRIFT_REF: "origin/main" };
  assert.deepEqual(parseArgs(["check"], env), { mode: "check", root: null, ref: "origin/main", files: ["CLAUDE.md", "docs/RULES.md"] });
  assert.deepEqual(parseArgs(["check", "--ref", "main", "--files", "A.md"], env), { mode: "check", root: null, ref: "main", files: ["A.md"] });
  assert.deepEqual(parseArgs(["check"], {}), { mode: "check", root: null, ref: null, files: ["CLAUDE.md", "AGENTS.md"] });
  const s = sandbox();
  try {
    run(args("start", s.root), input("SessionStart", { source: "startup" }), { dir: s.dir });
    writeFileSync(join(s.root, "CLAUDE.md"), "changed\n");
    assert.equal(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir, env: { RULES_DRIFT: "off" } }), null);
    assert.match(run(args("check", s.root), input("UserPromptSubmit"), { dir: s.dir, env: {} }), /\+changed/);
  } finally {
    s.done();
  }
});

test("state dir: GUARD_HOOKS_STATE_DIR, then CLAUDE_PLUGIN_DATA, then XDG_STATE_HOME, then ~/.local/state", () => {
  assert.equal(stateDir({ GUARD_HOOKS_STATE_DIR: "/a", CLAUDE_PLUGIN_DATA: "/b", XDG_STATE_HOME: "/c" }), join("/a", "rules-drift"));
  assert.equal(stateDir({ CLAUDE_PLUGIN_DATA: "/b", XDG_STATE_HOME: "/c" }), join("/b", "rules-drift"));
  assert.equal(stateDir({ XDG_STATE_HOME: "/c" }), join("/c", "guard-hooks", "rules-drift"));
  assert.equal(stateDir({}), join(homedir(), ".local/state", "guard-hooks", "rules-drift"));
});
