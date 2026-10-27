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

test("a session started in a folder inside a Crew clone binds the clone, up to the Git top level", async () => {
  const f = await fixture()
  mkdirSync(path.join(f.crew, ".git"), { recursive: true })
  const inside = path.join(f.crew, "desks", "ari", "ops", "some-task")
  mkdirSync(inside, { recursive: true })
  const fromHint = resolveDeskRootWithSource({ env: { DESK: f.personal }, activationConfigPath: f.binding, homeDir: f.home, cwd: inside, projectRootHint: inside })
  assert.deepEqual({ root: fromHint.root, source: fromHint.source }, { root: f.crew, source: "host-project" })
  const fromHost = resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, hostProjectRoot: path.join(f.crew, "desks", "ari") })
  assert.deepEqual({ root: fromHost.root, source: fromHost.source }, { root: f.crew, source: "host-project" })
  // A repository nested inside the clone is its own project: the walk stops at its top level.
  const nested = path.join(f.crew, "repos", "tool", "src")
  mkdirSync(path.join(f.crew, "repos", "tool", ".git"), { recursive: true })
  mkdirSync(nested, { recursive: true })
  assert.equal(resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, cwd: nested, projectRootHint: nested }).source, "env:DESK")
  assert.equal(paths.crewWorkspaceAbove(nested), null)
  assert.equal(paths.crewWorkspaceAbove(""), null)
  assert.equal(paths.crewWorkspaceAbove(f.root), null, "a folder above every clone, with no .git, walks to the top and finds none")
})

test("only a real Crew workspace outranks DESK: _meta/crew.json or a roster, never a personal desk's track named desks", async () => {
  const f = await fixture()
  // A personal desk with a track folder named desks, started in, stays below DESK as before.
  mkdirSync(path.join(f.other, "desks", "some-task"), { recursive: true })
  assert.equal(paths.isCrewWorkspaceFolder(f.other), false)
  assert.equal(resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, cwd: f.other, projectRootHint: f.other }).source, "env:DESK")
  // A new workspace marked by _meta/crew.json, before anyone has joined, is one.
  writeFileSync(path.join(f.other, "_meta", "crew.json"), "{\"schema_version\": 1}\n")
  assert.equal(paths.isCrewWorkspaceFolder(f.other), true)
  assert.equal(resolveDeskRootWithSource({ env: { DESK: f.personal }, homeDir: f.home, cwd: f.other, projectRootHint: f.other }).root, f.other)
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

function bootIn(cwd, env, extra = {}) {
  return bootOnce({
    env, cwd, homeDir: env.HOME, gh: runner, jq: runner, ...extra,
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

test("a member lookup that throws never stops the boot: the Crew clone shows no person line", async () => {
  const f = await fixture()
  const env = { HOME: f.home, XDG_STATE_HOME: path.join(f.home, "state"), DESK: f.personal }
  const result = await bootIn(f.crew, env, { memberFn: async () => { throw new Error("unexpected") } })
  assert.equal(result.root.path, f.crew)
  assert.equal(result.person, null)
})

test("the boot records local-only clones only on the member's own cards in a Crew clone", async () => {
  const f = await fixture()
  for (const [dir, title] of [[path.join(f.crew, "desks", "ari", "ops", "mine"), "Mine"], [path.join(f.crew, "desks", "bob", "ops", "theirs"), "Theirs"]]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "task.md"), `---\ntitle: ${title}\nstatus: active\ncreated: 2026-10-27\nupdated: 2026-10-27\n---\n# ${title}\n`)
  }
  const seen = (cards) => cards.map((card) => path.relative(f.crew, card.file).split(path.sep).join("/")).sort()
  const run = async (gh, extra = {}) => {
    let passed = null
    const env = { HOME: f.home, XDG_STATE_HOME: path.join(f.home, "state"), DESK: f.personal, GH_CONFIG_DIR: ghConfig(path.join(f.root, gh), gh) }
    await bootIn(f.crew, env, { localOnlyFn: async ({ cards }) => { passed = cards; return [] }, ...extra })
    return seen(passed)
  }
  assert.deepEqual(await run("ari_microsoft"), ["desks/ari/ops/mine/task.md"])
  assert.deepEqual(await run("stranger"), [], "a session with no member writes no card")
  assert.deepEqual(await run("ari_microsoft", { memberFn: async () => { throw new Error("unexpected") } }), [], "nor does one whose lookup failed")
})
