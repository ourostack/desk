// Desk's MCP walker (ax/walkers/mcp.mts), over registries shaped like Desk's two servers.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "../../ax/walkers/mcp.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp"));
const at = (file: string) => `${FIX}/${file}`;
const options = (module: string, more: Record<string, unknown> = {}) => ({ product: "desk", module: at(module), source: at(module), root: ROOT, ...more });

test("a JavaScript registry's tools are doors, each at its TOOL_NAMES literal, with the served read-only hint as evidence", async () => {
  const { doors, errors } = await walk(options("tool-names.js"));
  assert.deepEqual(errors, []);
  assert.deepEqual(
    doors.map((d) => [d.id, d.kind, d.name, d.description, d.file, d.line, d.card, d.evidence]),
    [
      ["mcp:task_create", "mcp", "task_create", "Create a task card.", at("tool-names.js"), 3, null, {}],
      ["mcp:desk_search", "mcp", "desk_search", "Search the desk.", at("tool-names.js"), 4, null, { readOnly: true }],
    ],
  );
});

test("a JSON catalog's tools are doors, each at its \"name\" literal", async () => {
  const { doors, errors } = await walk(options("catalog.json"));
  assert.deepEqual(errors, []);
  assert.deepEqual(
    doors.map((d) => [d.id, d.line, d.description, d.evidence]),
    [
      ["mcp:browser_context", 4, "Open or close a browser.", {}],
      ["mcp:browser_peek", 5, "Look.", { readOnly: true }],
    ],
  );
});

test("a name listed twice, a tool without a name and a registry with no list are census errors", async () => {
  const twice = await walk(options("twice.js"));
  assert.deepEqual(twice.doors.map((d) => [d.id, d.line, d.description]), [["mcp:note", 1, ""]]);
  assert.deepEqual(twice.errors, [`${at("twice.js")}: a tool without a name`, `mcp:note: listed twice in ${at("twice.js")}`]);
  const none = await walk(options("none.js"));
  assert.deepEqual(none.doors, []);
  assert.deepEqual(none.errors, [`${at("none.js")}: exports no TOOL_NAMES list`]);
  const noTools = await walk(options("no-tools.json"));
  assert.deepEqual(noTools.errors, [`${at("no-tools.json")}: a catalog with no tools list`]);
});

test("a name with no literal in the source is a door with line null", async () => {
  const { doors } = await walk({ ...options("tool-names.js"), source: at("catalog.json") });
  assert.deepEqual(doors.map((d) => d.line), [null, null]);
});

test("a card from the sidecar is the door's card, and its codes count as raised when a handler holds them, hyphens or underscores", async () => {
  const { doors, errors } = await walk(options("tool-names.js", { cards: at("cards.json"), handlers: [at("handlers")] }));
  assert.deepEqual(errors, []);
  const task = doors.find((d) => d.id === "mcp:task_create")!;
  assert.equal(task.card?.group, "desk-tasks");
  // never-raised-here appears only inside an error card, which declares it rather than raising it.
  assert.deepEqual(task.evidence, { raises: ["slug-invalid"] });
  assert.equal(doors.find((d) => d.id === "mcp:desk_search")!.card, null);
});

test("without handlers the walker can't tell what is raised, so it claims nothing either way", async () => {
  const { doors } = await walk(options("tool-names.js", { cards: at("cards.json") }));
  assert.deepEqual(doors.find((d) => d.id === "mcp:task_create")!.evidence, {});
});

test("a card for a tool the server doesn't list, and a card without an id, are census errors", async () => {
  const { errors } = await walk(options("tool-names.js", { cards: at("stale-cards.json") }));
  assert.deepEqual(errors, [
    `${at("stale-cards.json")}: doors must be a list of cards, each with an id`,
    `mcp:gone: a card in ${at("stale-cards.json")} for a tool ${at("tool-names.js")} doesn't list. Fix: remove the card, or serve the tool.`,
    `${at("stale-cards.json")}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`,
  ]);
});

test("a server with cards needs an unknown-door error card, raised by its handlers", async () => {
  const missing = await walk(options("tool-names.js", { cards: at("no-server-cards.json") }));
  assert.deepEqual(missing.errors, [`${at("no-server-cards.json")}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`]);
  const unraised = await walk(options("tool-names.js", { cards: at("unraised-server-cards.json"), handlers: [at("handlers/task.js")] }));
  assert.deepEqual(unraised.errors, [`${at("unraised-server-cards.json")}: the unknown-door code is never raised in ${at("handlers/task.js")}`]);
  const raised = await walk(options("tool-names.js", { cards: at("unraised-server-cards.json"), handlers: [at("handlers/server.js")] }));
  assert.deepEqual(raised.errors, []);
});

test("an empty sidecar declares nothing and asks for nothing; an unreadable one is a census error", async () => {
  assert.deepEqual((await walk(options("tool-names.js", { cards: at("empty-cards.json") }))).errors, []);
  const broken = await walk(options("tool-names.js", { cards: at("broken-cards.txt") }));
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0]!, /broken-cards\.txt: can't read the cards: /);
});
