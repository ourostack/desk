import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { completion } from "../src/account-runtime.js";

const child = () => Object.assign(new EventEmitter(), { signals: [], kill(signal) { this.signals.push(signal); } });
const unquiescent = error => error.code === "DESK_OPERATION_UNQUIESCENT" && error.quiescent === false;

test("owning UID completion requires both positive retirement and actual guardian close", async () => {
  const guardian = child();
  let completed = false;
  const done = completion(guardian, null, true).then(result => { completed = true; return result; });
  guardian.emit("message", { result: "actual result", retired: true, quiescent: true });
  await Promise.resolve();
  assert.equal(completed, false);
  guardian.emit("close", 0);
  assert.equal(await done, "actual result");
});

for (const ack of [undefined, null, {}, { retired: true }, { retired: true, quiescent: false }, { retired: "true", quiescent: true }, { retired: false, quiescent: true }]) {
  test(`missing or invalid retirement ${JSON.stringify(ack)} cannot certify successful close`, async () => {
    const guardian = child();
    const done = completion(guardian, null, true);
    guardian.emit("message", ack);
    guardian.emit("close", 0);
    await assert.rejects(done, unquiescent);
  });
}

test("lost guardian IPC without retirement fails closed", async () => {
  const guardian = child();
  const done = completion(guardian, null, true);
  guardian.emit("disconnect");
  await assert.rejects(done, unquiescent);
});

test("service deadline signals only its guardian and unproven retirement times out", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guardian = child();
  const done = completion(guardian, 10_000, true);
  t.mock.timers.tick(10_000);
  assert.deepEqual(guardian.signals, ["SIGKILL"]);
  t.mock.timers.tick(5_000);
  await assert.rejects(done, unquiescent);
});

test("bounded operation timeout remains an honest timeout after positive retirement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guardian = child();
  const done = completion(guardian, 60_000, true);
  t.mock.timers.tick(60_000);
  guardian.emit("message", { retired: true, quiescent: true });
  guardian.emit("close", 0);
  await assert.rejects(done, error => error.code === "DESK_OPERATION_TIMEOUT" && error.quiescent === true);
});

test("legacy completion still accepts ordinary child close without a retirement marker", async () => {
  const guardian = child();
  const done = completion(guardian);
  guardian.emit("message", { result: "legacy" });
  guardian.emit("close", 0);
  assert.equal(await done, "legacy");
});
