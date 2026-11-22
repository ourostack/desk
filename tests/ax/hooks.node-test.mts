// Desk's hooks walker (ax/walkers/hooks.mts), over hooks files shaped like Desk's.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "../../ax/walkers/hooks.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hooks"));
const at = (file: string) => `${FIX}/${file}`;
const options = (more: Record<string, unknown> = {}) => ({ product: "desk", module: "", source: FIX, root: ROOT, ...more });

test("each registered command is a door named by plugin, host, event and script, at its line; an extension's hooks are doors too", async () => {
  const { doors, unwalked, errors } = await walk(options());
  assert.deepEqual(
    doors.map((d) => [d.id, d.file, d.line]),
    [
      ["hook:plug copilot-extension onPreMcpToolCall label", at("plug/optional/label/extension.mjs"), 4],
      ["hook:plug claude SessionStart start.cjs", at("plug/hooks/hooks.json"), 4],
      ["hook:plug copilot sessionStart run-hook.cmd session-start", at("plug/hooks/copilot-hooks.json"), 5],
      ["hook:plug copilot preToolUse guard.cjs", at("plug/hooks/copilot-hooks.json"), 8],
      ["hook:plug copilot preToolUse guard.cjs [edit]", at("plug/hooks/copilot-hooks.json"), 10],
    ],
  );
  assert.deepEqual(unwalked.map((g) => [g.id, g.line]), [
    ["hook:plug copilot-extension opaque", 3],
    ["hook:plug claude PostToolUse", 7],
  ]);
  assert.deepEqual(errors, [
    `${at("broken/hooks/hooks.json")}: no hooks object, so the walker finds no hooks in it.`,
    `hook:plug copilot preToolUse guard.cjs: registered twice in ${at("plug/hooks/copilot-hooks.json")}`,
  ]);
});

test("a source with no hooks at all is a census error", async () => {
  const empty = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hooks-empty"));
  assert.deepEqual((await walk({ ...options(), source: empty })).errors, [`${empty}: no hooks registered under it, so the walker finds nothing. Fix: point the source at the folder of plugins.`]);
});

test("a hook card must list the doors it uses; a card with no hook is an error", async () => {
  const { doors, errors } = await walk(options({ cards: at("cards.json") }));
  assert.deepEqual(doors.find((d) => d.id === "hook:plug claude SessionStart start.cjs")!.card?.uses, ["mcp:desk_status"]);
  assert.deepEqual(errors.slice(2), [
    `hook:plug copilot sessionStart run-hook.cmd session-start: the card's uses must list the door ids its text tells the agent to use, such as "mcp:desk_status", or [] when it names none.`,
    `hook:plug claude Stop gone.cjs: a card in ${at("cards.json")} for a hook the walker doesn't find under ${FIX}. Fix: remove the card, or fix its id.`,
  ]);
});
