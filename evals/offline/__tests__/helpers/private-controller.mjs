import fs from "node:fs";
import path from "node:path";
import { controllerFixture } from "./controller-fixture.mjs";
import { privateFixture } from "./private-callbacks.mjs";

// Source-only callbacks and raw protocol records. None of these qualify a native producer.
export async function privateControllerFixture(options = {}) {
  const f = await controllerFixture("private-recording-boundaries", options);
  const controls = path.join(f.root, "private-controls");
  fs.mkdirSync(controls);
  const p = privateFixture(controls, options.fault);
  f.input.createDeskCallbacks = async () => p.callbacks;
  f.opened.privateOperations = p.options;
  f.opened.session = { synthetic: true };
  const close = f.opened.close;
  const stopped = { receipt: { completedWithinBudget: true } };
  f.opened.close = async function () {
    const bound = await close.call(this);
    bound.receipt.completedWithinBudget = stopped.receipt.completedWithinBudget;
    return bound;
  };
  f.opened.legacy = async () => {
    fs.writeFileSync(path.join(f.input.roots.canonical, "task.md"), "Source-only canonical legacy write.\n");
    return p.options.legacy();
  };
  return Object.assign(f, { p, stopped });
}
