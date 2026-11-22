// Desk's skills walker (ax/walkers/skills.mts), over plugin folders shaped like Desk's.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { frontmatter, walk } from "../../ax/walkers/skills.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "skills"));
const at = (file: string) => `${FIX}/${file}`;
const options = (more: Record<string, unknown> = {}) => ({ product: "desk", module: "", source: FIX, root: ROOT, ...more });

test("each plugin's SKILL.md files and agent files are doors, described by their frontmatter", async () => {
  const { doors, errors } = await walk(options());
  assert.deepEqual(errors, []);
  assert.deepEqual(
    doors.map((d) => [d.id, d.kind, d.description, d.file, d.line, d.evidence]),
    [
      ["skill:other:plain", "skill", "", at("other/skills/plain/SKILL.md"), 1, { readOnly: true }],
      ["skill:plug:start-task", "skill", "Use to start a task and route it.", at("plug/skills/start-task/SKILL.md"), 2, { readOnly: true }],
      ["agent:plug:worker", "agent", "A worker.", at("plug/agents/worker.md"), 3, {}],
    ],
  );
});

test("frontmatter reads plain, quoted and folded values", () => {
  assert.deepEqual(frontmatter("---\na: one\nb: 'two'\nc: |\n  x\n  y\n---\nd: no"), { fields: { a: "one", b: "two", c: "x y" }, lines: { a: 2, b: 3, c: 4 } });
  assert.deepEqual(frontmatter("no frontmatter"), { fields: {}, lines: {} });
});

test("a card must list the doors it uses, as ids, naming skills that exist; a card with no door is an error", async () => {
  const { doors, errors } = await walk(options({ cards: at("cards.json") }));
  assert.deepEqual(doors.find((d) => d.id === "skill:plug:start-task")!.card?.uses, ["mcp:task_create", "skill:other:plain", "host:Bash"]);
  assert.deepEqual(errors, [
    `agent:plug:worker: the card names no uses. Fix: list the doors it tells the agent to use, such as "mcp:task_update" or "host:Bash", or [] when it uses none.`,
    `skill:other:plain: uses "nope", which isn't a door id such as "mcp:task_update".`,
    `skill:other:plain: uses skill:plug:missing, which the walker doesn't find. Fix: name a skill or agent file that exists.`,
    `skill:other:plain: uses 3, which isn't a door id such as "mcp:task_update".`,
    `skill:gone:x: a card in ${at("cards.json")} for a skill or agent file the walker doesn't find under ${FIX}. Fix: remove the card, or fix its id.`,
  ]);
});
