import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { callTool, waitForStatusInspection } from "../../../../../plugins/desk/mcp/src/server.js"
import { admitInProcess, idleSearchEngine, startInProcess } from "./_in_process_desk.js"
import { removeTree } from "../_remove_tree.js"

// Windows refuses to remove a folder a process still uses for a moment; the shared removal waits that out.
function removeRoot(root) {
  return removeTree(root)
}

function tempRoot(prefix) {
  return mkdtempSync(path.join(realpathSync(tmpdir()), prefix))
}

// A search engine that records the paths each write reports.
function recordingSearch(events = []) {
  return idleSearchEngine({ noteChange(rel) { events.push(["noteChange", rel]) } })
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
    t.after(() => removeRoot(root))
    const searchEvents = []
    const desk = await startInProcess({
      argv: ["--root", root, ...(scenario.raw === undefined ? [] : ["--person", scenario.raw])],
      env: {},
      readinessPolicy: {
        write_authority: scenario.policy, semantic: "unsupported",
        authority_provider: scenario.provider ? "registry" : null,
      },
      authorityProviders: { registry: async () => scenario.provider },
      runtimeImporter: async () => ({
        // With waitForStatusInspection the session tracks the desk_status reader process and closing waits for it to
        // exit; without it, a reader still inspecting the root outlives close, and Windows cannot remove the root.
        callTool, waitForStatusInspection,
        createSearchEngine: () => recordingSearch(searchEvents),
      }),
    })
    try {
      const result = await desk.call("task_create", { track: "ops", slug: "authority-route", title: "Admitted write" })
      if (scenario.refused) {
        // Refused writes, served session: the handshake completed and the refusal names the fix.
        assert.equal(result.isError, true)
        assert.equal(result.payload.status, "degraded")
        assert.equal(result.payload.code, "authority_invalid")
        assert.equal((await desk.call("desk_status", { detail: true })).payload.state, "degraded:authority_invalid")
        assert.deepEqual(readdirSync(root), [], "refusal must leave every possible write target untouched")
        assert.deepEqual(searchEvents, [])
        return
      }
      assert.equal(result.isError, false, JSON.stringify(result.payload))
      const prefix = scenario.expectedPerson === null ? [] : ["desks", scenario.expectedPerson]
      // Desk spells the paths it reports with "/" on every platform.
      const expectedPath = path.posix.join(...prefix, "ops", "authority-route", "task.md")
      assert.equal(result.payload.path, expectedPath)
      assert.equal(desk.handle.session.context.person, scenario.expectedPerson)
      assert.equal(existsSync(path.join(root, expectedPath)), true)
      assert.deepEqual(searchEvents, [["noteChange", expectedPath]])
      const wrongPrefix = scenario.expectedPerson === null ? ["desks", "ari"] : []
      assert.equal(existsSync(path.join(root, ...wrongPrefix, "ops", "authority-route", "task.md")), false)
      assert.equal(existsSync(path.join(root, "desks", "bob")), false)
    } finally {
      // A refused session re-admits at once on desk_status, running Git in the root. Closing does not wait for that
      // attempt (follow-up #340), and Windows cannot remove a folder a running process still uses.
      await desk.handle.admission.idle({ waitMs: 10000 })
      await desk.close()
    }
  })
}

test("common startup rejects contradictory authority even from a runtime-provided verifier", async (t) => {
  const root = tempRoot("desk-custom-admission-")
  t.after(() => removeRoot(root))
  const started = await admitInProcess({
    argv: ["--root", root, "--person", "ari"], env: {},
    runtimeImporter: async () => ({
      verifyAuthority: async () => ({ mode: "workspace" }),
      createSearchEngine: () => assert.fail("no search engine without admitted authority"),
    }),
  })
  assert.equal(started.snapshot.state, "degraded:authority_invalid")
  assert.equal(started.statusContext.search, null)
  assert.deepEqual(readdirSync(root), [])
})

for (const scenario of [
  { policy: "person", authority: { mode: "workspace" }, refused: true },
  { policy: "workspace", authority: { mode: "person", person: "ari" }, refused: true },
  { policy: "person", authority: { mode: "person", person: "ari" }, expected: "ari" },
  { policy: "workspace", authority: { mode: "workspace" }, expected: null },
]) {
  test(`runtime-provided authority ${scenario.authority.mode} under ${scenario.policy} policy`, async (t) => {
    const root = tempRoot("desk-runtime-authority-")
    t.after(() => removeRoot(root))
    const events = []
    const started = await admitInProcess({
      argv: ["--root", root], env: {},
      readinessPolicy: { write_authority: scenario.policy },
      runtimeImporter: async () => ({
        verifyAuthority: async () => scenario.authority,
        createSearchEngine: () => idleSearchEngine({ warm() { events.push("warm") } }),
      }),
    })
    if (scenario.refused) {
      assert.equal(started.snapshot.state, "degraded:authority_invalid")
      assert.deepEqual(events, [], "no search engine without admitted authority")
      assert.equal(started.statusContext.search, null)
      assert.deepEqual(readdirSync(root), [])
    } else {
      assert.equal(started.snapshot.state, "ready")
      assert.deepEqual(events, ["warm"])
      assert.equal(started.person, scenario.expected)
    }
  })
}
