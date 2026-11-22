// Desk's CLI walker (ax/walkers/cli.mts), over a plugin folder shaped like Desk's.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "../../ax/walkers/cli.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli"));
const at = (file: string) => `${FIX}/${file}`;
const options = (source: string, more: Record<string, unknown> = {}) => ({ product: "desk", module: "", source: at(source), root: ROOT, ...more });

test("kit commands, hand-written entry points and their first words, and shell and Python scripts are doors; an `ax: read-only` line in a script's leading comments is its read-only evidence", async () => {
  const { doors, errors } = await walk(options("plug"));
  assert.deepEqual(errors, []);
  assert.deepEqual(
    doors.map((d) => [d.id, d.file, d.line, d.evidence]).sort(),
    [
      ["cli:node " + at("plug/scripts/channel.js"), at("plug/scripts/channel.js"), 2, {}],
      ["cli:node " + at("plug/scripts/channel.js") + " read", at("plug/scripts/channel.js"), 4, {}],
      ["cli:node " + at("plug/scripts/channel.js") + " send", at("plug/scripts/channel.js"), 3, {}],
      ["cli:node " + at("plug/scripts/credential.js"), at("plug/scripts/credential.js"), 1, {}],
      ["cli:node " + at("plug/scripts/credential.js") + " erase", at("plug/scripts/credential.js"), 6, {}],
      ["cli:node " + at("plug/scripts/credential.js") + " get", at("plug/scripts/credential.js"), 1, {}],
      ["cli:node " + at("plug/scripts/late-marker.js"), at("plug/scripts/late-marker.js"), 2, {}],
      ["cli:node " + at("plug/scripts/main-check.cjs"), at("plug/scripts/main-check.cjs"), 2, {}],
      ["cli:node " + at("plug/scripts/peek.js"), at("plug/scripts/peek.js"), 4, { readOnly: true }],
      ["cli:node " + at("plug/scripts/peek.js") + " list", at("plug/scripts/peek.js"), 4, { readOnly: true }],
      ["cli:node " + at("plug/scripts/run-main.mjs"), at("plug/scripts/run-main.mjs"), 6, {}],
      ["cli:python3 " + at("plug/skills/helper/audit.py"), at("plug/skills/helper/audit.py"), 8, {}],
      ["cli:python3 " + at("plug/skills/helper/report.py"), at("plug/skills/helper/report.py"), 5, { readOnly: true }],
      ["cli:" + at("plug/hooks/node-missing.sh"), at("plug/hooks/node-missing.sh"), 1, {}],
      ["cli:" + at("plug/scripts/peek-repo"), at("plug/scripts/peek-repo"), 1, { readOnly: true }],
      ["cli:" + at("plug/scripts/task-done"), at("plug/scripts/task-done"), 1, {}],
      ["cli:session-boot", at("plug/src/one-cli.js"), 4, { readOnly: true }],
      ["cli:tasks add", at("plug/src/tasks-cli.js"), 13, {}],
      ["cli:tasks archive", at("plug/src/tasks-cli.js"), 5, {}],
      ["cli:tasks count", at("plug/src/tasks-cli.js"), 18, { readOnly: true }],
      ["cli:tasks peek", at("plug/src/tasks-cli.js"), 20, { readOnly: true }],
      ["cli:tasks purge", at("plug/src/tasks-cli.js"), 19, {}],
      ["cli:tasks sync", at("plug/src/tasks-cli.js"), 21, {}],
      ["cli:tasks list", at("plug/src/tasks-cli.js"), 4, { readOnly: true }],
      ["cli:tasks show", at("plug/src/tasks-cli.js"), 14, { readOnly: true }],
    ].sort(),
  );
});

test("an entry point that runs a kit CLI, a script a hooks file registers (directly or through a dispatcher), a library, vendored kits and tests are not doors of their own", async () => {
  const ids = (await walk(options("plug"))).doors.map((d) => d.id);
  const files = ["scripts/tasks.js", "hooks/start.cjs", "hooks/fallback.sh", "hooks/session-start", "src/library.js", "src/lib/ouro-ui/ax-command.ts", "__tests__/x.test.js", "skills/helper/module.py", "skills/helper/test_audit.py"];
  for (const file of files) {
    assert.ok(!ids.some((id) => id.includes(file)), `${file} is not a door`);
  }
  assert.ok(!ids.includes("cli:xray"));
});

test("a command or CLI the walker can't follow is an unwalked gap", async () => {
  const { unwalked } = await walk(options("plug"));
  assert.deepEqual(
    unwalked.map((g) => [g.id, g.reasons]),
    [
      [`cli:${at("plug/src/one-cli.js")}:5`, ["unwalked: a defineCli whose name isn't a literal"]],
      [`cli:${at("plug/src/one-cli.js")}:6`, ["unwalked: empty with neither command nor commands"]],
      [`cli:${at("plug/src/tasks-cli.js")}:17`, ["unwalked: a command of tasks"]],
    ],
  );
});

test("a card's codes count as raised when the door's file or a handler holds them, hyphens or underscores; a shell script claims none", async () => {
  const { doors, errors } = await walk(options("plug", { cards: at("cards.json"), handlers: [at("handlers")] }));
  const by = (id: string) => doors.find((d) => d.id === id)!;
  assert.deepEqual(by("cli:tasks add").evidence, { raises: ["slug-invalid"] });
  assert.equal(by("cli:tasks add").card?.group, "g");
  assert.deepEqual(by("cli:session-boot").evidence, { readOnly: true, raises: ["raised-here"] });
  assert.deepEqual(by("cli:" + at("plug/scripts/task-done")).evidence, {});
  assert.deepEqual(errors, [`cli:gone: a card in ${at("cards.json")} for a command the walker doesn't find under ${at("plug")}. Fix: remove the card, or fix its id.`]);
});

test("a door found twice, a card without an id and an unreadable sidecar are census errors", async () => {
  assert.deepEqual((await walk(options("dup"))).errors, [`cli:twin: found twice (again at ${at("dup/a.js")}:3)`]);
  assert.deepEqual((await walk(options("plug", { cards: at("bad-cards.json") }))).errors, [`${at("bad-cards.json")}: doors must be a list of cards, each with an id`]);
  const broken = await walk(options("plug", { cards: at("broken-cards.txt") }));
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0]!, /broken-cards\.txt: can't read the cards: /);
});

test("a source with no doors at all is a census error, so the walker can't go blind unnoticed", async () => {
  const { doors, errors } = await walk(options("empty"));
  assert.deepEqual(doors, []);
  assert.deepEqual(errors, [`${at("empty")}: no commands or scripts under it, so the walker finds nothing. Fix: point the source at a folder of code.`]);
});
