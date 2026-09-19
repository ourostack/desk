import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { main } from "../../index.js"
import { createMcpServer, startServer } from "../../src/server.js"

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
    const root = mkdtempSync(path.join(tmpdir(), "desk-startup-authority-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const server = createMcpServer()
    const client = new Client({ name: "authority-smoke", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    let started = false
    let effectivePerson
    try {
      const starting = main({
        argv: ["--root", root, ...(scenario.raw === undefined ? [] : ["--person", scenario.raw])],
        env: {},
        readinessPolicy: {
          write_authority: scenario.policy, semantic: "unsupported",
          authority_provider: scenario.provider ? "registry" : null,
        },
        authorityProviders: { registry: async () => scenario.provider },
        runtimeImporter: async () => ({
          connectOrStartController: async () => ({ accepted: true }),
          async startServer(options) {
            started = true
            effectivePerson = options.person
            await startServer({ ...options, server, transport: serverTransport })
          },
        }),
      })
      if (scenario.refused) {
        await assert.rejects(starting, (error) => error.code === "authority_invalid" && error.status === "terminal")
        assert.equal(started, false)
        assert.deepEqual(readdirSync(root), [], "refusal must leave every possible write target untouched")
        return
      }
      await starting
      await client.connect(clientTransport)
      const result = await client.callTool({
        name: "task_create",
        arguments: { track: "ops", slug: "authority-route", title: "Admitted write" },
      })
      assert.equal(result.isError, undefined)
      const prefix = scenario.expectedPerson === null ? [] : ["desks", scenario.expectedPerson]
      const expectedPath = path.join(...prefix, "ops", "authority-route", "task.md")
      assert.equal(JSON.parse(result.content[0].text).path, expectedPath)
      assert.equal(effectivePerson, scenario.expectedPerson)
      assert.equal(existsSync(path.join(root, expectedPath)), true)
      const wrongPrefix = scenario.expectedPerson === null ? ["desks", "ari"] : []
      assert.equal(existsSync(path.join(root, ...wrongPrefix, "ops", "authority-route", "task.md")), false)
      assert.equal(existsSync(path.join(root, "desks", "bob")), false)
    } finally {
      await client.close()
      await server.close()
    }
  })
}

test("common startup rejects contradictory authority even from a runtime-provided admission implementation", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-custom-admission-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let started = false
  await assert.rejects(main({
    argv: ["--root", root, "--person", "ari"], env: {},
    runtimeImporter: async () => ({
      admitControlPlane: async () => ({ authority: { mode: "workspace" } }),
      async startServer() { started = true },
    }),
  }), (error) => error.code === "authority_invalid")
  assert.equal(started, false)
  assert.deepEqual(readdirSync(root), [])
})

for (const scenario of [
  { policy: "person", authority: { mode: "workspace" }, refused: true },
  { policy: "workspace", authority: { mode: "person", person: "ari" }, refused: true },
  { policy: "person", authority: { mode: "person", person: "ari" }, expected: "ari" },
  { policy: "workspace", authority: { mode: "workspace" }, expected: null },
]) {
  test(`prebuilt runtime admission ${scenario.authority.mode} under ${scenario.policy} policy`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "desk-runtime-authority-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const events = []
    const starting = main({
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
        async startServer({ person }) { events.push(["start", person]) },
      }),
    })
    if (scenario.refused) {
      await assert.rejects(starting, (error) => error.code === "authority_invalid" && error.status === "terminal")
      assert.deepEqual(events, [], "neither convergence nor server exposure is allowed")
      assert.deepEqual(readdirSync(root), [])
    } else {
      await starting
      assert.deepEqual(events, ["converge", ["start", scenario.expected]])
    }
  })
}
