// ax/check-uses.mts: a card's uses must name doors some Desk walker finds.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unresolvedUses } from "../../ax/check-uses.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("a uses entry naming a door another walker finds resolves; a mistyped one doesn't; host tools and walkers outside the config are skipped", async () => {
  assert.deepEqual(await unresolvedUses("tests/ax/fixtures/uses/config.json", ROOT), [
    `skill:plug:start-task: uses mcp:task_creat, which no walker finds. Fix: name a door that exists, or "host:<tool>" for a host tool.`,
  ]);
});

test("Desk's own config resolves every uses entry", async () => {
  assert.deepEqual(await unresolvedUses("ax/census.config.json", ROOT), []);
});
