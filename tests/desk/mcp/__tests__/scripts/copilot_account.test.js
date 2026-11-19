import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { test } from "node:test"

const repo = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(import.meta.url)
const { copilotEnvironment, copilotLogin, isWorkOwner, ownerOfRepo, withoutAmbientTokens } = require(path.join(repo, "scripts/copilot-account.cjs"))

const remote = (url) => (cmd) => ({ status: 0, stdout: cmd === "git" ? url : "" })

test("work owners are recognised, everything else is personal", () => {
  for (const owner of ["teams-microsoft", "gim-home", "shared-internal-tools", "arimendelow_microsoft", "Some-Microsoft"]) assert.equal(isWorkOwner(owner, {}), true)
  for (const owner of ["ourostack", "arimendelow", "", undefined]) assert.equal(isWorkOwner(owner, {}), false)
  assert.equal(isWorkOwner("extra-org", { MS_DESK_WORK_OWNERS: "a, extra-org" }), true)
  assert.equal(typeof isWorkOwner("ourostack"), "boolean")
})

test("the repository owner picks the login", () => {
  assert.equal(copilotLogin("/x", { env: {}, run: remote("https://github.com/ourostack/desk.git\n") }), "arimendelow")
  assert.equal(copilotLogin("/x", { env: {}, run: remote("git@github.com:arimendelow/notes.git") }), "arimendelow")
  assert.equal(copilotLogin("/x", { env: {}, run: remote("https://github.com/gim-home/CIT") }), "arimendelow_microsoft")
  assert.equal(copilotLogin("/x", { env: { DESK_COPILOT_WORK_ACCOUNT: "w" }, run: remote("https://github.com/gim-home/CIT") }), "w")
  assert.equal(copilotLogin("/x", { env: { DESK_COPILOT_ACCOUNT: "pinned" }, run: remote("https://github.com/gim-home/CIT") }), "pinned")
  assert.equal(copilotLogin("/x", { env: {}, run: () => ({}) }), "arimendelow")
  assert.equal(ownerOfRepo("/x", () => ({ stdout: "" })), "")
  assert.equal(ownerOfRepo(repo) === "" || typeof ownerOfRepo(repo) === "string", true)
  assert.equal(typeof copilotLogin(repo, { env: {} }), "string")
})

test("the child env drops ambient tokens and carries the owner's account token", () => {
  const calls = []
  const run = (cmd, args, options) => {
    if (cmd === "git") return { status: 0, stdout: "https://github.com/ourostack/desk.git" }
    calls.push({ args, env: options.env })
    return { status: 0, stdout: "personal-token\n" }
  }
  const env = copilotEnvironment({ GH_TOKEN: "w", github_token: "w", KEEP: "1" }, "/x", { run })
  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(env.github_token, undefined)
  assert.equal(env.KEEP, "1")
  assert.equal(env.COPILOT_GITHUB_TOKEN, "personal-token")
  assert.equal(calls[0].args.at(-1), "arimendelow")
  assert.equal(copilotEnvironment({ COPILOT_GITHUB_TOKEN: "given", GH_TOKEN: "w" }, "/x", { run }).COPILOT_GITHUB_TOKEN, "given")
  assert.deepEqual(withoutAmbientTokens({ GITHUB_TOKEN: "w", A: "b" }), { A: "b" })
})

test("an account that is not signed in falls back with a warning", () => {
  const write = process.stderr.write
  let message = ""
  process.stderr.write = (chunk) => { message += chunk; return true }
  try {
    const env = copilotEnvironment({}, "/x", { run: (cmd) => (cmd === "git" ? { stdout: "https://github.com/ourostack/desk" } : { status: 1 }) })
    assert.equal(env.COPILOT_GITHUB_TOKEN, undefined)
  } finally {
    process.stderr.write = write
  }
  assert.match(message, /gh auth login/u)
})

test("the default process runner is used when none is injected", () => {
  const env = copilotEnvironment({ DESK_COPILOT_ACCOUNT: "no-such-login-for-test" }, repo)
  assert.equal(env.GH_TOKEN, undefined)
})
