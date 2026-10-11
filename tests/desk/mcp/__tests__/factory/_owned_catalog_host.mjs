// The one owned-catalog platform split for tests. The product decision is
// ownedCatalogHostSupport() in triage-custody.js: Darwin alone has process
// provenance; every non-Windows host has POSIX private-file custody. A test
// whose need this host lacks never skips silently. It asserts the product's
// refusal instead: nothing launched and no receipt materialized.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import * as path from "node:path"

const custody = await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
const catalog = await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/v12-owned-catalog.json", import.meta.url)))

export const ownedHost = custody.ownedCatalogHostSupport()
const NEEDS = { provenance: "provenance", posix: "posixCustody" }

// Real-binary checks read the installed Claude Code 2.1.296 engine itself.
// They belong to the qualifier run, so the unit suite runs them only on an
// explicit opt-in; CI never depends on an operator's host binary.
export const REAL_CLI = process.env.DESK_TRIAGE_REAL_CLI === "1"
const REAL_CLI_REASON = "set DESK_TRIAGE_REAL_CLI=1 on a host with the installed Claude Code 2.1.296 engine to run this real-binary check"

export async function assertOwnedHostRefusal(host = ownedHost) {
  assert.equal(host.provenance, false, "only an unsupported host asserts refusal")
  assert.equal(host.reason, "provenance_unsupported")
  const direct = await custody.runDirectCatalog({ fixture, deadline: Date.now() + 15000 })
  assert.equal(direct.state, "scope_unqualified")
  assert.equal(direct.reason, "provenance_unsupported")
  assert.deepEqual(direct.resources.pids, [], "direct lane launched nothing")
  assert.equal(direct.custody, undefined, "no receipt materialized")
  await direct.cleanup()
  const wire = await custody.runCatalogWireCase({ fixture, frames: [], deadline: Date.now() + 15000 })
  assert.equal(wire.state, "scope_unqualified")
  assert.equal(wire.reason, "provenance_unsupported")
  assert.deepEqual(wire.resources.pids, [], "wire case launched nothing")
  await wire.cleanup()
  let closed = 0, spawned = 0
  const native = await custody.runOwnedCatalogNative({
    owned: { runDir: "unsupported-host", async close() { closed += 1 } },
    command: "must-not-launch", args: [], env: {}, deadline: Date.now() + 15000, resultFile: "unsupported-host",
    onChild() { spawned += 1 }, onChildExit() {}, spawn() { spawned += 1; throw new Error("forbidden") },
  })
  assert.equal(native.state, "scope_unqualified")
  assert.equal(native.reason, "provenance_unsupported")
  assert.equal(native.cost_usd, null)
  assert.equal(spawned, 0, "native engine never started")
  assert.equal(closed, 1, "prepared run released")
  if (!host.posixCustody) {
    // Windows has no POSIX owner/mode bits to verify, so private-file custody
    // refuses an owner-only file rather than trusting it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owned-host-")), file = path.join(dir, "probe.json")
    try {
      fs.writeFileSync(file, "{}", { mode: 0o600 })
      await assert.rejects(catalog.safeCatalogPath(file), { message: "catalog_invalid" })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
}

// need: "provenance" (real launcher/server/native processes) or "posix"
// (POSIX uid, modes, FIFOs, signals and paths). realCli adds the opt-in gate.
export function ownedHostTest(name, need, fn, { realCli = false } = {}) {
  if (!Object.hasOwn(NEEDS, need)) throw new Error(`unknown owned-catalog need ${need}`)
  if (realCli && !REAL_CLI) return test(name, { skip: REAL_CLI_REASON }, fn)
  return test(name, async (t) => {
    if (ownedHost[NEEDS[need]]) return fn(t)
    t.diagnostic(`${ownedHost.platform} lacks owned-catalog ${need}; asserting the product refusal instead`)
    await assertOwnedHostRefusal()
  })
}
export const realCliTest = (name, need, fn) => ownedHostTest(name, need, fn, { realCli: true })

// One owned-catalog custody scenario, run twice. The first variant uses the
// production module and needs Darwin provenance (elsewhere it asserts the
// refusal). The second runs the same scenario on every POSIX host through
// createNonacceptedOwnedCatalog: the actual launcher, server, FIFOs and files,
// with the Darwin ps observation replaced by the facade's observer double and
// every registry private to the facade. fn receives the custody API to use.
export function ownedCatalogTest(name, fn) {
  ownedHostTest(name, "provenance", (t) => fn(t, custody))
  ownedHostTest(`${name} [observer double]`, "posix", (t) => fn(t, observerDoubleCustody()))
}
export function observerDoubleCustody() {
  return Object.freeze({ ...custody, ...custody.createNonacceptedOwnedCatalog() })
}
