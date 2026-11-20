import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { campaign } from "./helpers/publication-campaign.mjs";

test("a full fixed-six publication source control keeps a failure without inventing a winner", async () => {
  const failed = await campaign("fail");
  assert.equal(failed.result.exitCode, 1, JSON.stringify(failed.result));
  const runSet = JSON.parse(fs.readFileSync(path.join(failed.prepared.root, "run-set.json")));
  assert.equal(runSet.state, "complete");
  assert.equal(runSet.unstartedCellIds.length, 0);
  assert.ok(runSet.attempts.every(attempt => attempt.commitMarker !== null));
});
