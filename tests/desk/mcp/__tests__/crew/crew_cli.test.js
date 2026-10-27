// scripts/crew.js: the command an agent runs. It parses its options, calls the workspace engine and prints one JSON
// result; the exit code says whether the result is a refusal or failure.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { CIT_SHAPED, teamRepo } from "./_fixtures.js"
import { isEntrypoint, main } from "../../../../../plugins/desk/mcp/scripts/crew.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/crew.js", import.meta.url))

async function run(argv, engine) {
  let out = ""
  const code = await main({ argv, cwd: "/work/team", write: (text) => { out += text }, engine })
  return { code, result: JSON.parse(out) }
}

test("usage errors: an unknown action, a flag the action does not take, and a flag with no value exit 2", async () => {
  const usage = [
    [[], "unknown action \"\""],
    [["rename"], "unknown action \"rename\""],
    [["status", "--apply"], "status does not take --apply"],
    [["join", "alias"], "join does not take alias"],
    [["join", "--alias"], "--alias needs a value"],
    [["join", "--alias", "--apply"], "--alias needs a value"],
  ]
  for (const [argv, error] of usage) {
    const { code, result } = await run(argv)
    assert.equal(code, 2, argv.join(" "))
    assert.equal(result.state, "usage")
    assert.ok(result.message.startsWith(`${error}. usage: crew.js`), result.message)
  }
})

test("main hands each action its options and exits by the result's state", async () => {
  const calls = []
  const engine = {
    crewStatus: async (args) => (calls.push(["status", args]), { state: "not_crew" }),
    joinWorkspace: async (args) => (calls.push(["join", args]), { state: "refused" }),
    startWorkspace: async (args) => (calls.push(["start", args]), { state: "plan" }),
  }
  assert.deepEqual(await run(["status"], engine), { code: 0, result: { state: "not_crew" } })
  assert.deepEqual(calls.pop(), ["status", { repo: "/work/team", identity: undefined }])
  assert.equal((await run(["join", "--repo", "/r", "--identity", "me", "--alias", "me", "--apply"], engine)).code, 1)
  assert.deepEqual(calls.pop(), ["join", { repo: "/r", identity: "me", alias: "me", apply: true }])
  await run(["start", "--merge-workflow", ".github/workflows/m.yml", "--founder", "test-founder=placeholder_id", "--tooling-repo", "acme/tools", "--tooling-path", "plugins/t", "--tooling-plugin", "t", "--tooling-ref", "dev", "--tooling-marketplace", "acme"], engine)
  assert.deepEqual(calls.pop(), ["start", {
    repo: "/work/team", apply: false, team: undefined, mergeWorkflow: ".github/workflows/m.yml", founder: { alias: "test-founder", identity: "placeholder_id" },
    tooling: { repo: "acme/tools", path: "plugins/t", plugin: "t", ref: "dev", marketplace: "acme" },
  }])
  await run(["start", "--team", "Placeholder", "--founder", "solo", "--apply"], engine)
  const [, start] = calls.pop()
  assert.equal(start.team, "Placeholder")
  assert.deepEqual(start.founder, { alias: "solo", identity: "" })
  assert.deepEqual(start.tooling, { repo: undefined, path: undefined, plugin: undefined, ref: undefined, marketplace: undefined })
  assert.equal(start.apply, true)
  const usage = await run(["status", "--bogus"], engine)
  assert.equal(usage.code, 2)
  assert.match(usage.result.message, /^status does not take --bogus\. usage: crew\.js/u)
})

test("the real engine through main: a team repository that is not a Crew workspace yet", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const { code, result } = await run(["status", "--repo", repo.clone])
  assert.equal(code, 0)
  assert.equal(result.state, "not_crew")
  assert.match(result.message, /crew:start-crew/u)
  const removed = await run(["adopt", "--repo", repo.clone])
  assert.equal(removed.code, 2)
})

test("run as a script, it prints the plan and exits 0; a folder that is not a clone exits 1", async () => {
  const repo = await teamRepo(CIT_SHAPED)
  const planned = spawnSync(process.execPath, [SCRIPT, "start", "--repo", repo.clone, "--tooling-repo", "acme/team-tooling"], { encoding: "utf8" })
  assert.equal(planned.status, 0, planned.stderr)
  const plan = JSON.parse(planned.stdout)
  assert.equal(plan.state, "plan")
  assert.equal(plan.setup, "dual-repo")
  assert.deepEqual(plan.outside, ["context/", "guides/", "team/"])
  const plain = await mkTempRoot("crew-cli-plain-")
  const notGit = spawnSync(process.execPath, [SCRIPT, "status", "--repo", path.join(plain)], { encoding: "utf8" })
  assert.equal(notGit.status, 1)
  assert.equal(JSON.parse(notGit.stdout).state, "not_git")
})

test("isEntrypoint", () => {
  assert.equal(isEntrypoint(SCRIPT, pathToFileURL(SCRIPT).href), true)
  assert.equal(isEntrypoint(""), false)
  assert.equal(isEntrypoint("/no/such/file.js"), false)
  assert.equal(isEntrypoint(), false)
})
