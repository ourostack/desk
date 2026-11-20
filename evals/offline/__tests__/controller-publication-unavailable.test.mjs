import assert from "node:assert/strict";
import test from "node:test";
import { campaign } from "./helpers/publication-campaign.mjs";

test("HIGH-6 a committed unavailable twelfth cell wins over complete inventory", async () => {
  const f = await campaign("pass", true);
  assert.equal(f.result.attempts, 12);
  assert.equal(f.result.unstarted, 0);
  assert.equal(f.prepared.runSet.attempts.at(-1).status, "unavailable");
  assert.ok(f.prepared.runSet.attempts.at(-1).commitMarker);
  assert.equal(f.result.exitCode, 3);
});
