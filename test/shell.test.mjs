import assert from "node:assert/strict";
import { test } from "node:test";
import { flatten, parse, simpleCommands } from "../hooks/shell.mjs";

const D = "/srv/app";

const cases = [
  // separators: ; && || | newline ( )
  [`cd ${D} && npm test`, [["cd", D], ["npm", "test"]]],
  [`cd "${D}"; ls`, [["cd", D], ["ls"]]],
  [`a | b || c`, [["a"], ["b"], ["c"]]],
  [`npm test && (cd ${D} && ls)`, [["npm", "test"], ["cd", D], ["ls"]]],
  // substitutions are listed before the command that contains them, which keeps their source text
  [`x=$(cd ${D} && pwd)`, [["cd", D], ["pwd"], [`x=$(cd ${D} && pwd)`]]],
  [`echo \`pidof node\``, [["pidof", "node"], ["echo", "`pidof node`"]]],
  [`echo "a $(pkill node) b" "\`pidof x\`"`, [["pkill", "node"], ["pidof", "x"], ["echo", "a $(pkill node) b", "`pidof x`"]]],
  [`diff <(ls a) >(cat)`, [["ls", "a"], ["cat"], ["diff", "<(ls a)", ">(cat)"]]],
  [`echo $((1 + 2)) "$((3 << 1))"`, [["echo", "$((1 + 2))", "$((3 << 1))"]]],
  [`((n = 1 << 2))\nls`, [["ls"]]],
  [`a=(x $(pgrep y) z)`, [["pgrep", "y"], ["a=(x $(pgrep y) z)"]]],
  // keywords stay words here; kill-guard looks past them
  [`if cd ${D}; then ls; fi`, [["if", "cd", D], ["then", "ls"], ["fi"]]],
  // quoting and escapes
  [`git -C '${D}' status`, [["git", "-C", D, "status"]]],
  [`echo "a \\"b\\" c" 'd e'`, [["echo", 'a "b" c', "d e"]]],
  [`echo a\\ b`, [["echo", "a b"]]],
  [`echo "pkill -f node"`, [["echo", "pkill -f node"]]],
  [`echo "\\$(pkill node)"`, [["echo", "$(pkill node)"]]],
  [`echo ''`, [["echo", ""]]],
  [`$'pk\\x'ill node`, [["pk\\xill", "node"]]],
  [`$'a\\tb'`, [["a\tb"]]],
  // comments
  [`# pkill node\nls`, [["ls"]]],
  [`ls # pkill node`, [["ls"]]],
  // redirections are words of their own and do not split a pipeline
  [`pgrep x 2>&1 | xargs kill`, [["pgrep", "x", "2>&", "1"], ["xargs", "kill"]]],
  [`ls &>/dev/null; ls>out`, [["ls", "&>", "/dev/null"], ["ls", ">", "out"]]],
  // heredoc bodies are data, here-strings are left alone
  [`cat <<'EOF' > f\npkill node\nEOF\nls`, [["cat", "<<EOF", ">", "f"], ["ls"]]],
  [`cat <<-EOF\n\tpkill node\n\tEOF\nls`, [["cat", "<<-EOF"], ["ls"]]],
  [`python3 - <<EOF\nimport os; os.system("pkill node")\nEOF`, [["python3", "-", "<<EOF"]]],
  [`cat <<< "pkill node"`, [["cat", "<<<", "pkill node"]]],
  // …but an unquoted heredoc still runs its substitutions
  [`cat <<EOF\nnow: $(date)\nEOF`, [["date"], ["cat", "<<EOF"]]],
];

for (const [command, expected] of cases) {
  test(JSON.stringify(command).slice(0, 70), () => assert.deepEqual(simpleCommands(command), expected));
}

test("structure: pipeline stages, variables, substitutions, redirections, heredoc bodies", () => {
  const [a, b, c] = parse("pgrep -f vite 2>/dev/null | xargs kill; kill $PID");
  assert.equal(a.pipeline, b.pipeline);
  assert.deepEqual([a.stage, b.stage, c.stage], [0, 1, 0]);
  assert.notEqual(c.pipeline, a.pipeline);
  assert.deepEqual(a.info.map((i) => i.redir), [false, false, false, true, true]);
  assert.deepEqual(c.info[1].vars, ["PID"]);
  const [x] = parse('x="${HOME:-$(whoami)}"');
  assert.deepEqual(x.info[0].vars, ["HOME"]);
  assert.deepEqual(x.info[0].subs[0].commands[0].words, ["whoami"]);
  const [sh] = parse("bash <<'EOF'\npkill node\nEOF\necho after");
  assert.deepEqual(sh.heredocs.map((h) => [h.text, h.expand]), [["pkill node\n", false]]);
  // `(pgrep x) | …` keeps the pipeline across the parentheses
  const all = flatten(parse("(pgrep x) | xargs kill"));
  assert.deepEqual(all.map((k) => [k.words[0], k.stage]), [["pgrep", 0], ["xargs", 1]]);
  assert.equal(all[0].pipeline, all[1].pipeline);
});

test("never throws on malformed input", () => {
  const broken = ['echo "unclosed', "echo $(unclosed", "echo `unclosed", "echo ${unclosed", "echo $((1+", "echo $'abc", "cat <<EOF\nno end", "cat <<", "((", ")))", "}}}", "a=(", "<(", "2>&", "|||", ";;&&", "\\", "$", '"$(', "'"];
  for (const s of broken) assert.doesNotThrow(() => flatten(parse(s)), s);
  const chars = ["a", " ", "'", '"', "`", "$", "(", ")", "{", "}", "|", "&", ";", "<", ">", "\\", "\n", "#", "=", "-", "1"];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 3000; n++) {
    const s = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => chars[Math.floor(rand() * chars.length)]).join("");
    assert.doesNotThrow(() => flatten(parse(s)), JSON.stringify(s));
  }
});
