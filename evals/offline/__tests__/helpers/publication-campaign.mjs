import fs from "node:fs";
import path from "node:path";
import { runFixedController } from "../../fixed-controller.mjs";
import { prepareRunPlan } from "../../producer.mjs";
import { jsonBytes } from "../../core.mjs";
import { completedControllerFixture } from "./completed-controller.mjs";

// A full fixed-six campaign is twelve cells, about a minute and a half each time, so every test file runs at most two of them.
export async function campaign(judgeStatus = "pass", failLast = false) {
  const first = await completedControllerFixture("discussion-then-go", { judgeStatus });
  const cells = new Map();
  const seeds = [];
  for (const [index, cell] of first.expected.cells.entries()) {
    const f = index === 0 ? first : await completedControllerFixture(cell.caseId, { judgeStatus });
    if (failLast && index === first.expected.cells.length - 1) f.input.assertConfinement = async () => { throw new Error("Last-cell native capability unavailable"); };
    cells.set(cell.id, f.input);
    seeds.push({ ...f.plan.gitSeeds[0], cellId: cell.id });
  }
  first.plan.gitSeeds = seeds;
  fs.writeFileSync(path.join(first.inputRoot, "plan.json"), jsonBytes(first.plan));
  const prepared = prepareRunPlan({ filename: path.join(first.inputRoot, "plan.json"), outputRoot: path.join(first.root, "full-controller") });
  const result = await runFixedController({ prepared, nativeInputs: { ...first.nativeInputs, cells } });
  return { ...first, prepared, result };
}
