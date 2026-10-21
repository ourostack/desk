import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js";
import { assertWindowsAclAvailable } from "../../../../../plugins/desk/mcp/src/factory/windows-acl.js";

const fixture = fileURLToPath(new URL("./fixtures/native-private-worker-contract.cjs", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function generationAbsent(pid, started, observed) {
  if (typeof observed === "string" && observed.length > 0) return observed !== started;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
  return false;
}
test("worker contract closeout cannot turn a missing start observation into PID absence", () => {
  assert.equal(generationAbsent(process.pid, "owned-start", null), false);
  assert.equal(generationAbsent(process.pid, "owned-start", "owned-start"), false);
  assert.equal(generationAbsent(process.pid, "owned-start", "different-start"), true);
});
for (const mode of ["natural", "explicit-exit", "uncaught"]) {
  test(`actual Windows readonly helper closes before ${mode} worker shutdown ACK`, {
    skip: process.platform !== "win32", timeout: 30000,
  }, async t => {
    const provider = assertWindowsAclAvailable();
    const child = fork(fixture, [mode, provider], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", diagnostic = "", helper, nodeStart;
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      if (helper) {
        const deadline = Date.now() + 5000;
        let absent = generationAbsent(helper.pid, helper.start, await readProcessStart(helper.pid));
        while (!absent && Date.now() < deadline) {
          await pause(20);
          absent = generationAbsent(helper.pid, helper.start, await readProcessStart(helper.pid));
        }
        assert.equal(absent, true, "exact owned helper generation must independently be absent");
      }
    });
    const booted = await Promise.race([
      new Promise(resolve => child.once("message", resolve)),
      exited.then(() => { throw Error("OWNED_FIXTURE_ENDED_BEFORE_BOOT: " + diagnostic); }),
    ]);
    assert.equal(booted.event, "booted");
    helper = booted.helper;
    assert.ok(Number.isSafeInteger(helper.pid) && helper.pid > 0);
    assert.equal(helper.executable.toLowerCase(), provider.toLowerCase());
    assert.equal(await readProcessStart(helper.pid), helper.start, "real helper kernel start agrees before exit");
    nodeStart = await readProcessStart(child.pid);
    assert.equal(typeof nodeStart, "string");
    t.diagnostic(JSON.stringify({ scope: "owned readonly process contract only", node: {
      pid: child.pid, start: nodeStart, executable: process.execPath,
    }, helper, mode }));
    child.send("proceed");
    const outcome = await exited;
    assert.deepEqual(outcome, { code: mode === "uncaught" ? 1 : 0, signal: null });
    const lines = output.trim().split("\n");
    assert.equal(lines.length, 1);
    const receipt = JSON.parse(lines[0]);
    assert.equal(receipt.mode, mode);
    assert.equal(receipt.event, mode === "natural" ? "beforeExit" : "exit");
    assert.equal(receipt.status, 2, "ACK must follow real EOF, clean PS close and output drain");
    assert.equal(receipt.wait, "ok");
    assert.deepEqual(receipt.helper, helper);
    assert.equal(generationAbsent(child.pid, nodeStart, await readProcessStart(child.pid)), true);
    if (mode === "uncaught") assert.match(diagnostic, /OWNED_EXPECTED_FAILURE/);
    else assert.equal(diagnostic, "");
  });
}
