import assert from "node:assert/strict";
import { test } from "node:test";
import { simpleCommands } from "../hooks/shell.mjs";

const D = "/srv/app";

const cases = [
  // separators: ; && || | newline ( ) ` $(
  [`cd ${D} && npm test`, [["cd", D], ["npm", "test"]]],
  [`cd "${D}"; ls`, [["cd", D], ["ls"]]],
  [`a | b || c`, [["a"], ["b"], ["c"]]],
  [`npm test && (cd ${D} && ls)`, [["npm", "test"], ["cd", D], ["ls"]]],
  [`x=$(cd ${D} && pwd)`, [["x="], ["cd", D], ["pwd"]]],
  [`echo \`pidof node\``, [["echo"], ["pidof", "node"]]],
  [`if cd ${D}; then ls; fi`, [["if", "cd", D], ["then", "ls"], ["fi"]]],
  // quoting and escapes
  [`git -C '${D}' status`, [["git", "-C", D, "status"]]],
  [`echo "a \\"b\\" c" 'd e'`, [["echo", 'a "b" c', "d e"]]],
  [`echo a\\ b`, [["echo", "a b"]]],
  [`echo "pkill -f node"`, [["echo", "pkill -f node"]]],
  [`echo ''`, [["echo", ""]]],
  // comments
  [`# pkill node\nls`, [["ls"]]],
  [`ls # pkill node`, [["ls"]]],
  // heredoc bodies are data, here-strings are left alone
  [`cat <<'EOF' > f\npkill node\nEOF\nls`, [["cat", "<<EOF", ">", "f"], ["ls"]]],
  [`cat <<-EOF\n\tpkill node\n\tEOF\nls`, [["cat", "<<-EOF"], ["ls"]]],
  [`python3 - <<EOF\nimport os; os.system("pkill node")\nEOF`, [["python3", "-", "<<EOF"]]],
  [`cat <<< "pkill node"`, [["cat", "<<<", "pkill node"]]],
];

for (const [command, expected] of cases) {
  test(JSON.stringify(command).slice(0, 70), () => assert.deepEqual(simpleCommands(command), expected));
}
