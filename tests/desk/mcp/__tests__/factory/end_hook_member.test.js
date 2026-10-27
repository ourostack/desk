// The factory's capture hook records a Crew member's sessions under the member's own desk, the person the tool server
// writes as, with no DESK_PERSON: the derive step then reads that member's task cards. Throwaway desks; no process starts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ID, scratch } from "./_session_helpers.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

const require = createRequire(import.meta.url)
const { runHook } = require(fileURLToPath(new URL("../../../../../plugins/desk/hooks/lib/factory-end.cjs", import.meta.url)))

async function crewClone(base) {
  const clone = path.join(base, "team")
  for (const dir of ["_meta", path.join("desks", "ari"), path.join("desks", "bob")]) await fs.mkdir(path.join(clone, dir), { recursive: true })
  await fs.writeFile(path.join(clone, "_meta", "desks.md"), "| alias | identity |\n|---|---|\n| ari | ari_microsoft |\n| bob | bob_microsoft |\n")
  const gh = path.join(base, "gh")
  await fs.mkdir(gh, { recursive: true })
  await fs.writeFile(path.join(gh, "hosts.yml"), "github.com:\n    users:\n        ari_microsoft:\n    user: ari_microsoft\n")
  return { clone, gh }
}

async function markerFor(env) {
  return JSON.parse(await fs.readFile(path.join(await factoryStateRoot(env), "markers", `copilot-cli-${ID}.json`), "utf8"))
}

test("a Crew member's session is recorded under the member's own desk, found from the roster", () => scratch(async (ctx) => {
  const { clone, gh } = await crewClone(ctx.base)
  const env = { ...ctx.env, DESK: clone, GH_CONFIG_DIR: gh }
  const payload = { sessionId: ID, cwd: clone, reason: "complete" }
  assert.equal(await runHook({ host: "copilot", payload, env, launch: async () => {} }), "written")
  const marker = await markerFor(env)
  assert.equal(marker.person_prefix, "desks/ari")
  assert.equal(path.resolve(marker.desk_root), path.resolve(clone))
}))

test("an account that is not on the roster records no person, and DESK_PERSON still wins", () => scratch(async (ctx) => {
  const { clone, gh } = await crewClone(ctx.base)
  await fs.writeFile(path.join(gh, "hosts.yml"), "github.com:\n    user: stranger\n")
  const env = { ...ctx.env, DESK: clone, GH_CONFIG_DIR: gh }
  const payload = { sessionId: ID, cwd: clone, reason: "complete" }
  assert.equal(await runHook({ host: "copilot", payload, env, launch: async () => {} }), "written")
  assert.equal((await markerFor(env)).person_prefix, "")
  assert.equal(await runHook({ host: "copilot", payload, env: { ...env, DESK_PERSON: "bob" }, launch: async () => {} }), "written")
  assert.equal((await markerFor(env)).person_prefix, "desks/bob")
}))
