// A session started inside a Crew workspace clone binds that workspace, even with a user-wide DESK or a saved binding
// for the personal desk, and the boot script resolves exactly as the tool server does. Throwaway folders only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import * as paths from "../../../../../plugins/desk/mcp/src/util/paths.js"

const { resolveDeskRootWithSource } = paths
import { resolveStartupDeskRoot } from "../../../../../plugins/desk/mcp/src/runtime/startup-resolve.js"
import { bootOnce, personSummary, resolveBootRoot } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"

async function fixture() {
  const root = await mkTempRoot("desk-crew-binding-")
  const personal = path.join(root, "ms-desk")
  const crew = path.join(root, "code", "team")
  const other = path.join(root, "code", "other-desk")
  for (const dir of [path.join(personal, "_meta"), path.join(personal, "_archive"), path.join(crew, "_meta"), path.join(crew, "desks", "ari"), path.join(other, "_meta"), path.join(other, "_archive")]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(crew, "_meta", "desks.md"), "| alias | identity |\n|---|---|\n| ari | ari_microsoft |\n")
  const binding = path.join(root, "desk.activation.json")
  writeFileSync(binding, JSON.stringify({ schema_version: 1, desk: { root: personal } }))
  const home = path.join(root, "home")
  mkdirSync(home, { recursive: true })
  return { root, personal, crew, other, binding, home }
}

test("a Crew clone as the launch folder outranks a user-wide DESK and the saved binding", async () => {
  const f = await fixture()
  const viaDesk = resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, cwd: f.crew, projectRootHint: f.crew })
  assert.deepEqual({ root: viaDesk.root, source: viaDesk.source, hint: viaDesk.hint }, { root: f.crew, source: "host-project", hint: undefined })
  const viaBinding = resolveDeskRootWithSource({ env: { DESK: f.personal }, activationConfigPath: f.binding, homeDir: f.home, cwd: f.crew, projectRootHint: f.crew })
  assert.equal(viaBinding.root, f.crew)
  assert.equal(paths.isCrewWorkspaceFolder(f.crew), true)
  assert.equal(paths.isCrewWorkspaceFolder(f.personal), false)
  assert.equal(paths.isCrewWorkspaceFolder(""), false)
})

test("a personal desk as the launch folder stays below DESK, as before", async () => {
  const f = await fixture()
  const bound = resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, cwd: f.other, projectRootHint: f.other })
  assert.deepEqual({ root: bound.root, source: bound.source }, { root: f.personal, source: "env:DESK" })
  // An explicit root still wins over a Crew launch folder.
  assert.equal(resolveDeskRootWithSource({ explicitRoot: f.personal, homeDir: f.home, projectRootHint: f.crew }).source, "explicit-root")
  // A host project folder that is not a desk is not replaced by the launch folder.
  assert.equal(resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, hostProjectRoot: f.root, projectRootHint: f.crew }).source, "env:DESK")
})

test("the boot script binds what the tool server binds: the Crew clone, with a user-wide DESK set", async () => {
  const f = await fixture()
  const env = { HOME: f.home, XDG_STATE_HOME: path.join(f.home, "state"), DESK: f.personal }
  const server = resolveStartupDeskRoot({ args: {}, env, cwd: f.crew, homeDir: f.home })
  const boot = resolveBootRoot({ env, cwd: f.crew, homeDir: f.home })
  assert.deepEqual({ root: boot.path, source: boot.source }, { root: server.root, source: server.source })
  assert.deepEqual({ root: boot.path, source: boot.source }, { root: f.crew, source: "host-project" })
})

test("on Copilot the boot script reads the session record the server reads, wherever it runs from", async () => {
  const f = await fixture()
  const env = { HOME: f.home, XDG_STATE_HOME: path.join(f.home, "state"), DESK: f.personal, COPILOT_AGENT_SESSION_ID: "crew-session" }
  assert.equal(recordCopilotSession({ sessionId: "crew-session", folder: f.crew, env }), true)
  const server = resolveStartupDeskRoot({ args: {}, env, cwd: f.root, homeDir: f.home })
  const boot = resolveBootRoot({ env, cwd: f.root, homeDir: f.home })
  assert.deepEqual({ root: boot.path, source: boot.source }, { root: server.root, source: server.source })
  assert.equal(boot.path, f.crew)
})

const ok = { code: 0, stdout: "gh version 2.54.0\njq-1.7\n", stderr: "" }
const runner = async (args) => (args.join(" ").startsWith("auth status") ? { code: 0, stdout: "", stderr: "" } : ok)

function bootIn(cwd, env) {
  return bootOnce({
    env, cwd, homeDir: env.HOME, gh: runner, jq: runner,
    migrationsFn: async () => [], repoFn: () => ({ states: [], pending: [] }), prFn: async () => ({ prs: [], pending: [] }),
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
}

function ghConfig(dir, login) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "hosts.yml"), `github.com:\n    users:\n        ${login}:\n    user: ${login}\n`)
  return dir
}

test("the boot prints the Crew clone, the member and where they write, with a user-wide DESK and no --person", async () => {
  const f = await fixture()
  writeFileSync(path.join(f.crew, "desks", "ari", "AGENTS.md"), "# Ari's own rules\n")
  const env = { HOME: f.home, XDG_STATE_HOME: path.join(f.home, "state"), DESK: f.personal, GH_CONFIG_DIR: ghConfig(path.join(f.root, "gh"), "ari_microsoft") }
  const result = await bootIn(f.crew, env)
  assert.deepEqual({ path: result.root.path, source: result.root.source }, { path: f.crew, source: "host-project" })
  assert.deepEqual(result.person, { alias: "ari", source: "crew-roster", identity: "ari_microsoft", write_path: "desks/ari", problem: null })
  assert.match(result.person_agents_md?.text ?? JSON.stringify(result.person_agents_md), /Ari's own rules/u)
  const text = formatBootText(result)
  assert.ok(text.includes(`desk ${f.crew} (bound by host-project) | person ari, writes to desks/ari (crew roster, GitHub account ari_microsoft)`), text.split("\n")[0])
})

test("the boot says plainly when the session's account is not on the roster", async () => {
  const f = await fixture()
  const env = { HOME: f.home, XDG_STATE_HOME: path.join(f.home, "state"), DESK: f.personal, GH_CONFIG_DIR: ghConfig(path.join(f.root, "gh"), "stranger") }
  const result = await bootIn(f.crew, env)
  assert.equal(result.person.alias, null)
  const text = formatBootText(result)
  assert.match(text.split("\n")[0], /\| team workspace read-only: no person/u)
  assert.ok(text.includes("This session's GitHub account (stranger) is not on this team workspace's roster"), text)
  // A personal desk has no person line.
  assert.equal(personSummary({ crew: false, person: null }), null)
  assert.equal(personSummary(null), null)
})
