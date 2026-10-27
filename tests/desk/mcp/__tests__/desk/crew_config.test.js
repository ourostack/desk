// The crew declaration (`_meta/crew.json`) says where the team's plugin lives: in a separate tooling repository
// (dual-repo) or in the workspace's own `plugins/` (monorepo). Without it the workspace is a monorepo, so a workspace
// made before the declaration existed reads exactly as before. Fixtures are synthetic.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { CREW_CONFIG_FILE, parseCrewConfig, readCrewConfig } from "../../../../../plugins/desk/mcp/src/desk/crew-config.js"

test("no declaration: a monorepo, nothing declared", () => {
  const config = parseCrewConfig(null)
  assert.equal(config.declared, false)
  assert.equal(config.setup, "monorepo")
  assert.equal(config.tooling, null)
  assert.deepEqual(config.shared_writes, { merge_workflow: null })
  assert.deepEqual(config.problems, [])
  assert.equal(CREW_CONFIG_FILE, path.join("_meta", "crew.json"))
})

test("a tooling repository makes the workspace dual-repo", () => {
  const config = parseCrewConfig(JSON.stringify({
    schema_version: 1,
    tooling: { repo: "example-org/team-tooling", path: "plugins/team", plugin: "team", ref: "release", marketplace: "example-org" },
    shared_writes: { merge_workflow: ".github/workflows/merge.yml" },
  }))
  assert.equal(config.declared, true)
  assert.equal(config.setup, "dual-repo")
  assert.deepEqual(config.tooling, { repo: "example-org/team-tooling", path: "plugins/team", plugin: "team", ref: "release", marketplace: "example-org" })
  assert.deepEqual(config.shared_writes, { merge_workflow: ".github/workflows/merge.yml" })
  assert.deepEqual(config.problems, [])
})

test("a tooling repository with no plugin yet is a stub, still dual-repo", () => {
  const config = parseCrewConfig(JSON.stringify({ tooling: { repo: "example-org/stub" } }))
  assert.equal(config.setup, "dual-repo")
  assert.deepEqual(config.tooling, { repo: "example-org/stub", path: "", plugin: null, ref: "main", marketplace: null })
})

test("an Enterprise Managed Users owner, with an underscore, is a valid tooling repository", () => {
  const config = parseCrewConfig(JSON.stringify({ tooling: { repo: "pat_example/team-tooling" } }))
  assert.deepEqual(config.problems, [])
  assert.equal(config.tooling.repo, "pat_example/team-tooling")
  assert.equal(parseCrewConfig(JSON.stringify({ tooling: { repo: "_leading/x" } })).tooling, null)
})

test("tooling inside the workspace is a path with no repository: a monorepo", () => {
  const config = parseCrewConfig(JSON.stringify({ tooling: { path: "./plugins/team/", plugin: "team" } }))
  assert.equal(config.setup, "monorepo")
  assert.deepEqual(config.tooling, { repo: null, path: "plugins/team", plugin: "team", ref: "main", marketplace: null })
})

test("what cannot be honored is reported and never followed", () => {
  const config = parseCrewConfig(JSON.stringify({
    tooling: { repo: "not a repo", path: "../x", plugin: 3, ref: "", marketplace: 4 },
    shared_writes: { merge_workflow: "../w.yml" },
  }))
  assert.equal(config.tooling, null)
  assert.equal(config.setup, "monorepo")
  assert.deepEqual(config.shared_writes, { merge_workflow: null })
  assert.deepEqual(config.problems, [
    "tooling.repo: \"not a repo\" is not owner/name",
    "tooling.path: \"../x\" is not a folder inside the tooling repository",
    "tooling.plugin: must be a name",
    "tooling.ref: must be a branch name",
    "tooling.marketplace: must be a name",
    "shared_writes.merge_workflow: \"../w.yml\" is not a file inside the repository",
  ])
})

test("paths outside the repository, in any spelling, are refused", () => {
  for (const raw of ["", "/abs/w.yml", "C:\\w.yml", ".", "./", "a/../../w.yml", 7]) {
    const config = parseCrewConfig(JSON.stringify({ shared_writes: { merge_workflow: raw } }))
    assert.equal(config.shared_writes.merge_workflow, null, String(raw))
    assert.equal(config.problems.length, 1, String(raw))
  }
  assert.equal(parseCrewConfig(JSON.stringify({ shared_writes: { merge_workflow: ".github\\workflows\\m.yml" } })).shared_writes.merge_workflow, ".github/workflows/m.yml")
  assert.deepEqual(parseCrewConfig(JSON.stringify({ shared_writes: { merge_workflow: null } })).problems, [])
})

test("a tooling block with neither repo nor path is no tooling", () => {
  assert.equal(parseCrewConfig(JSON.stringify({ tooling: {} })).tooling, null)
  assert.equal(parseCrewConfig(JSON.stringify({ tooling: { path: "", plugin: "x" } })).tooling, null)
})

test("text that is not a JSON object is a problem, and the workspace reads as a monorepo", () => {
  for (const text of ["{", "[]", "3", "null"]) {
    const config = parseCrewConfig(text)
    assert.equal(config.declared, true)
    assert.equal(config.setup, "monorepo")
    assert.deepEqual(config.problems, ["_meta/crew.json is not a JSON object"])
  }
  const blocks = parseCrewConfig(JSON.stringify({ tooling: "x", shared_writes: 2 }))
  assert.deepEqual(blocks.problems, ["tooling: must be an object", "shared_writes: must be an object"])
})

test("readCrewConfig reads the file at the root, and a missing or unreadable one is undeclared", async () => {
  const root = await mkTempRoot("crew-config-")
  assert.equal(readCrewConfig(root).declared, false)
  assert.equal(readCrewConfig("").declared, false)
  assert.equal(readCrewConfig(null).declared, false)
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(path.join(root, CREW_CONFIG_FILE), JSON.stringify({ tooling: { repo: "example-org/tools" } }), "utf8")
  assert.equal(readCrewConfig(root).setup, "dual-repo")
  // A folder in the file's place cannot be read: undeclared, not a crash.
  const odd = await mkTempRoot("crew-config-dir-")
  await fs.mkdir(path.join(odd, CREW_CONFIG_FILE), { recursive: true })
  assert.equal(readCrewConfig(odd).declared, false)
})
