import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { main } from "../cli.mjs";
import { campaign } from "./helpers/publication-campaign.mjs";

test("full fixed-six publication source controls preserve pass and inconclusive without inventing a winner", async () => {
  const passed = await campaign();
  assert.equal(passed.result.exitCode, 0, JSON.stringify(passed.result));
  assert.equal(passed.result.attempts, 12);
  const inconclusive = await campaign("investigate");
  assert.equal(inconclusive.result.exitCode, 2, JSON.stringify(inconclusive.result));
  for (const f of [passed, inconclusive]) {
    const runSet = JSON.parse(fs.readFileSync(path.join(f.prepared.root, "run-set.json")));
    assert.equal(runSet.state, "complete");
    assert.equal(runSet.unstartedCellIds.length, 0);
    assert.ok(runSet.attempts.every(attempt => attempt.commitMarker !== null));
  }
  let text = "";
  const exit = await main(["compare", "--left", path.join(passed.prepared.root, "run-set.json"), "--right", path.join(inconclusive.prepared.root, "run-set.json")], { stdout: { write: value => { text += value; } } });
  const compared = JSON.parse(text);
  assert.equal(exit, 0, text);
  assert.equal(compared.expectedCells, 24);
  assert.equal(compared.missing, 0);
  assert.equal(compared.grade, null);
});
