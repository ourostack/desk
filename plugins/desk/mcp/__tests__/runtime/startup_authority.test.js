import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { callTool } from "../../src/server.js"
import { admitInProcess, startInProcess } from "./_in_process_desk.js"

function tempRoot(prefix) {
  return mkdtempSync(path.join(realpathSync(tmpdir()), prefix))
}

function admittedController(events = []) {
  return {
    accepted: true,
    async recordChange(change) {
      events.push(["recordChange", change])
      return { recorded: true }
    },
    async markUncertain(reason) {
      events.push(["markUncertain", reason])
      return { uncertain: true }
    },
    async beginConvergence() {
      events.push("converge")
      return { reused: false }
    },
    async barrier({ capability }) {
      return { capability, current: true, certain: true }
    },
  }
}

for (const scenario of [
  { name: "workspace", policy: "workspace", expectedPerson: null },
  { name: "matching person", policy: "person", raw: "ari", expectedPerson: "ari" },
  { name: "matching provider person", policy: "person", raw: "ari", provider: { mode: "person", person: "ari" }, expectedPerson: "ari" },
  { name: "provider-derived person", policy: "person", provider: { mode: "person", person: "ari" }, expectedPerson: "ari" },
  { name: "workspace/raw contradiction", policy: "workspace", raw: "ari", refused: true },
  { name: "provider/raw contradiction", policy: "person", raw: "ari", provider: { mode: "person", person: "bob" }, refused: true },
  { name: "provider workspace/raw contradiction", policy: "workspace", raw: "ari", provider: { mode: "workspace" }, refused: true },
  { name: "provider workspace/person policy mismatch", policy: "person", provider: { mode: "workspace" }, refused: true },
  { name: "provider person/workspace policy mismatch", policy: "workspace", provider: { mode: "person", person: "ari" }, refused: true },
]) {
  test(`common startup dispatches only admitted authority: ${scenario.name}`, async (t) => {
    const root = tempRoot("desk-startup-authority-")
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const controllerEvents = []
    const desk = await startInProcess({
      argv: ["--root", root, ...(scenario.raw === undefined ? [] : ["--person", scenario.raw])],
      env: {},
      readinessPolicy: {
        write_authority: scenario.policy, semantic: "unsupported",
        authority_provider: scenario.provider ? "registry" : null,
      },
      authorityProviders: { registry: async () => scenario.provider },
      runtimeImporter: async () => ({
        callTool,
        connectOrStartController: async () => admittedController(controllerEvents),
      }),
    })
    try {
      const result = await desk.call("task_create", { track: "ops", slug: "authority-route", title: "Admitted write" })
      if (scenario.refused) {
        // Refused writes, served session: the handshake completed and the refusal names the fix.
        assert.equal(result.isError, true)
        assert.equal(result.payload.status, "degraded")
        assert.equal(result.payload.code, "authority_invalid")
        assert.equal((await desk.call("desk_status")).payload.state, "degraded:authority_invalid")
        assert.deepEqual(readdirSync(root), [], "refusal must leave every possible write target untouched")
        assert.deepEqual(controllerEvents, [])
        return
      }
      assert.equal(result.isError, false, JSON.stringify(result.payload))
      const prefix = scenario.expectedPerson === null ? [] : ["desks", scenario.expectedPerson]
      const expectedPath = path.join(...prefix, "ops", "authority-route", "task.md")
      assert.equal(result.payload.path, expectedPath)
      assert.equal(desk.handle.session.context.person, scenario.expectedPerson)
      assert.equal(existsSync(path.join(root, expectedPath)), true)
      assert.deepEqual(controllerEvents.map(([method]) => method), ["recordChange"])
      assert.equal(controllerEvents[0][1].path, expectedPath)
      const wrongPrefix = scenario.expectedPerson === null ? ["desks", "ari"] : []
      assert.equal(existsSync(path.join(root, ...wrongPrefix, "ops", "authority-route", "task.md")), false)
      assert.equal(existsSync(path.join(root, "desks", "bob")), false)
    } finally {
      await desk.close()
    }
  })
}

test("common startup rejects contradictory authority even from a runtime-provided admission implementation", async (t) => {
  const root = tempRoot("desk-custom-admission-")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const started = await admitInProcess({
    argv: ["--root", root, "--person", "ari"], env: {},
    runtimeImporter: async () => ({
      admitControlPlane: async () => ({ authority: { mode: "workspace" } }),
    }),
  })
  assert.equal(started.snapshot.state, "degraded:authority_invalid")
  assert.equal(started.statusContext.admission, null)
  assert.deepEqual(readdirSync(root), [])
})

for (const scenario of [
  { policy: "person", authority: { mode: "workspace" }, refused: true },
  { policy: "workspace", authority: { mode: "person", person: "ari" }, refused: true },
  { policy: "person", authority: { mode: "person", person: "ari" }, expected: "ari" },
  { policy: "workspace", authority: { mode: "workspace" }, expected: null },
]) {
  test(`prebuilt runtime admission ${scenario.authority.mode} under ${scenario.policy} policy`, async (t) => {
    const root = tempRoot("desk-runtime-authority-")
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const events = []
    const started = await admitInProcess({
      argv: ["--root", root], env: {},
      readinessPolicy: { write_authority: scenario.policy, semantic: "required" },
      runtimeImporter: async () => ({
        admitControlPlane: async () => ({
          state: "CONTROL_READY", authority: scenario.authority,
          controller: {
            async beginConvergence() { events.push("converge") },
            async barrier() { return { capability: "semantic", current: true } },
          },
        }),
      }),
    })
    if (scenario.refused) {
      assert.equal(started.snapshot.state, "degraded:authority_invalid")
      assert.deepEqual(events, [], "no convergence without admitted authority")
      assert.equal(started.statusContext.admission, null)
      assert.deepEqual(readdirSync(root), [])
    } else {
      assert.equal(started.snapshot.state, "ready")
      assert.deepEqual(events, ["converge"])
      assert.equal(started.person, scenario.expected)
    }
  })
}
