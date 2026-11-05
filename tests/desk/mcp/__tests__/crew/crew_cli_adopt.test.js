// scripts/crew.js join --adopt-existing: the reviewed commit reaches the engine as `adoptExisting`, and only when given.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { main } from "../../../../../plugins/desk/mcp/scripts/crew.js"

async function run(argv, engine) {
  let out = ""
  const code = await main({ argv, cwd: "/work/team", write: (text) => { out += text }, engine })
  return { code, result: JSON.parse(out) }
}

test("join --adopt-existing hands the reviewed commit to the engine; without it the option is absent", async () => {
  const calls = []
  const engine = { joinWorkspace: async (args) => (calls.push(args), { state: "plan" }) }
  const commit = "0123456789abcdef0123456789abcdef01234567"
  assert.equal((await run(["join", "--identity", "me", "--alias", "me", "--adopt-existing", commit, "--apply"], engine)).code, 0)
  assert.deepEqual(calls.pop(), { repo: "/work/team", identity: "me", alias: "me", apply: true, adoptExisting: commit })
  await run(["join", "--identity", "me", "--alias", "me"], engine)
  const plain = calls.pop()
  assert.equal("adoptExisting" in plain, false)
  assert.equal(plain.apply, false)
  const missing = await run(["join", "--adopt-existing"], engine)
  assert.equal(missing.code, 2)
  assert.match(missing.result.message, /^--adopt-existing needs a value\. usage: crew\.js/u)
  const wrongAction = await run(["status", "--adopt-existing", commit], engine)
  assert.equal(wrongAction.code, 2)
  assert.match(wrongAction.result.message, /^status does not take --adopt-existing/u)
})
