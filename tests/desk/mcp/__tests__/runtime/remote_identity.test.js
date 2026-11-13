// Desk syncs a desk with the GitHub account that owns its remote, even when the Copilot app's command-line Git config
// resets the credential helpers to the session's own account. A session signed in as one account used to get
// "Repository not found" from a desk whose remote another account owns, and the push stayed local.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { deliver } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { credentialHelperFor, hasCredentialOverride, parseHttpsRemote, remoteIdentityEnv } from "../../../../../plugins/desk/mcp/src/runtime/remote-identity.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

const APP_OVERRIDE = { GIT_CONFIG_PARAMETERS: "'credential.https://github.com.helper=' 'credential.https://github.com.helper=copilot'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.interactive", GIT_CONFIG_VALUE_0: "never" }
const REMOTE = "https://arimendelow_microsoft@github.com/arimendelow_microsoft/desk.git"

function git(root, args, env) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: env ?? process.env })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

// Answers `git config` reads from a table and `gh auth token` for the logins in `tokens`; records every call.
function fakeSpawn({ config = {}, tokens = [] } = {}) {
  const calls = []
  const spawn = (command, args) => {
    calls.push([command, ...args])
    if (command === "gh") return tokens.includes(args[args.indexOf("--user") + 1]) ? { status: 0, stdout: "s3cret-value\n" } : { status: 1, stdout: "" }
    const key = args[args.indexOf("config") + 2]
    if (args.includes("config") && key in config) return { status: 0, stdout: `${config[key]}\n` }
    return { status: 1, stdout: "" }
  }
  return { spawn, calls }
}

test("an HTTPS remote names its login by user, else by owner; anything else names none", () => {
  assert.deepEqual(parseHttpsRemote(REMOTE), { origin: "https://github.com", host: "github.com", user: "arimendelow_microsoft", owner: "arimendelow_microsoft" })
  assert.deepEqual(parseHttpsRemote("https://github.com/ourostack/desk.git"), { origin: "https://github.com", host: "github.com", user: null, owner: "ourostack" })
  for (const url of ["git@github.com:o/r.git", "/tmp/origin.git", "https://u:secret@github.com/o/r.git", "https://github.com:8443/o/r.git", ""]) assert.equal(parseHttpsRemote(url), null, url)
})

test("only the Copilot app's credential override counts as an override", () => {
  assert.equal(hasCredentialOverride(APP_OVERRIDE), true)
  assert.equal(hasCredentialOverride({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "copilot" }), true)
  assert.equal(hasCredentialOverride({ GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.interactive", GIT_CONFIG_VALUE_0: "never" }), false)
})

test("a session whose helper is overridden pushes as the account its remote names, appended after the override", async () => {
  const root = await mkTempRoot("desk-identity-")
  git(root, ["init", "-q"])
  const { spawn } = fakeSpawn({ config: { "remote.origin.url": REMOTE }, tokens: ["arimendelow_microsoft"] })
  const env = remoteIdentityEnv({ root, args: ["push", "--quiet", "origin", "abc:refs/heads/main"], env: APP_OVERRIDE, spawn, cache: new Map() })

  assert.ok(env.GIT_CONFIG_PARAMETERS.startsWith(APP_OVERRIDE.GIT_CONFIG_PARAMETERS + " "), "the app's own entries stay first")
  assert.equal(env.GIT_CONFIG_COUNT, APP_OVERRIDE.GIT_CONFIG_COUNT)
  assert.match(env.GIT_CONFIG_PARAMETERS, /--user arimendelow_microsoft /u)
  assert.doesNotMatch(JSON.stringify(env), /s3cret-value/u, "no secret is written into config")
  // Git reads the app's override first and ours last, so ours is the helper it uses for the remote.
  assert.equal(git(root, ["config", "--get-urlmatch", "credential.helper", REMOTE], { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1" }), credentialHelperFor({ host: "github.com", login: "arimendelow_microsoft" }))
})

test("an environment, command or remote Desk cannot place with confidence is left exactly as it was", async () => {
  const root = await mkTempRoot("desk-identity-none-")
  const https = fakeSpawn({ config: { "remote.origin.url": REMOTE }, tokens: [] })
  assert.equal(remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn: https.spawn, cache: new Map() }), APP_OVERRIDE, "gh holds no token for the login")
  assert.ok(https.calls.some((call) => call[0] === "gh"))

  const plain = fakeSpawn({ config: { "remote.origin.url": REMOTE }, tokens: ["arimendelow_microsoft"] })
  const noOverride = { GIT_CONFIG_COUNT: "0" }
  assert.equal(remoteIdentityEnv({ root, args: ["push", "origin"], env: noOverride, spawn: plain.spawn, cache: new Map() }), noOverride)
  assert.equal(remoteIdentityEnv({ root, args: ["status"], env: APP_OVERRIDE, spawn: plain.spawn, cache: new Map() }), APP_OVERRIDE)
  assert.deepEqual(plain.calls, [], "nothing is asked when no override is in play or the command is local")

  const ssh = fakeSpawn({ config: { "remote.origin.url": "git@github.com:o/r.git" }, tokens: ["o"] })
  assert.equal(remoteIdentityEnv({ root, args: ["pull"], env: APP_OVERRIDE, spawn: ssh.spawn, cache: new Map() }), APP_OVERRIDE)
})

test("a pull with no remote named uses the current branch's upstream remote, and a push uses its push URL", async () => {
  const root = await mkTempRoot("desk-identity-upstream-")
  const config = { "remote.fork.url": "https://github.com/someone/desk.git", "remote.fork.pushurl": REMOTE, "branch.main.remote": "fork" }
  const { spawn } = fakeSpawn({ config, tokens: ["arimendelow_microsoft", "someone"] })
  const onMain = (command, args) => (args.includes("symbolic-ref") ? { status: 0, stdout: "main\n" } : spawn(command, args))
  const loginFor = (args) => remoteIdentityEnv({ root, args, env: APP_OVERRIDE, spawn: onMain, cache: new Map() }).GIT_CONFIG_PARAMETERS.match(/--user (\S+)/u)[1]
  assert.equal(loginFor(["pull", "--rebase"]), "someone")
  assert.equal(loginFor(["push", "fork", "x:y"]), "arimendelow_microsoft")
})

test("delivery fetches and pushes with the remote's account, and local commands with the plain environment", async () => {
  const origin = await mkTempRoot("desk-identity-origin-")
  spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin])
  const root = await mkTempRoot("desk-identity-desk-")
  git(root, ["init", "-q", "--initial-branch=main"])
  git(root, ["config", "user.email", "t@example.com"])
  git(root, ["config", "user.name", "T"])
  git(root, ["commit", "-q", "--allow-empty", "-m", "seed"])
  // The remote reads as HTTPS to Desk and resolves to the local bare repository for Git itself.
  git(root, ["config", `url.${origin}.insteadOf`, REMOTE])
  git(root, ["remote", "add", "origin", REMOTE])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["commit", "-q", "--allow-empty", "-m", "stranded"])

  const seen = []
  const spawnGit = (command, args, options) => {
    if (command === "gh") return { status: 0, stdout: "token\n" }
    if (["fetch", "push"].includes(args[2])) seen.push({ command: args[2], key: options.env.GIT_CONFIG_PARAMETERS })
    if (args[2] === "diff" || args[2] === "log") seen.push({ command: args[2], key: options.env.GIT_CONFIG_PARAMETERS })
    return spawnSync(command, args, options)
  }
  const saved = Object.fromEntries(Object.keys(APP_OVERRIDE).map((key) => [key, process.env[key]]))
  Object.assign(process.env, APP_OVERRIDE)
  try {
    const result = deliver({ root, spawnGit })
    assert.equal(result.state, "delivered", JSON.stringify(result))
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value)
  }
  const network = seen.filter((call) => call.command === "fetch" || call.command === "push")
  assert.ok(network.length >= 2 && network.every((call) => /--user arimendelow_microsoft /u.test(call.key)), JSON.stringify(seen))
  assert.ok(seen.filter((call) => call.command === "log").every((call) => !/--user /u.test(call.key ?? "")))
  assert.equal(spawnSync("git", [`--git-dir=${origin}`, "log", "--format=%s", "-1", "main"], { encoding: "utf8" }).stdout.trim(), "stranded")
})

test("a refused pull tells the agent the probable cause, how to look further, how to file it and what to run, in one AX line", async () => {
  const origin = await mkTempRoot("desk-identity-tell-origin-")
  spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin])
  const root = await mkTempRoot("desk-identity-tell-")
  git(root, ["init", "-q", "--initial-branch=main"])
  git(root, ["config", "user.email", "t@example.com"])
  git(root, ["config", "user.name", "T"])
  git(root, ["commit", "-q", "--allow-empty", "-m", "seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  git(root, ["remote", "set-url", "origin", REMOTE])
  const refused = (command, args, options) => (args[2] === "pull" ? { status: 128, stdout: "", stderr: "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/arimendelow_microsoft/desk.git/'\n" } : spawnSync(command, args, options))
  const result = await syncWorkspace({ root, env: process.env, spawnGit: refused, spawnPull: refused, scheduleDelivery: () => {}, fileProblem: () => {} })

  assert.equal(result.cause, "auth_failed")
  const tell = result.diagnostic.split("\n").find((line) => line.startsWith("  tell: ")).slice("  tell: ".length)
  assert.match(tell, /^desk: sync: the remote refused this host's credentials, probably because the GitHub account Git is signed in as here does not own https:\/\/github\.com\/arimendelow_microsoft\/desk\.git; /u)
  assert.match(tell, /local work continues and Desk retries with every write/u)
  assert.match(tell, /run `git -C \S+ ls-remote origin`/u)
  assert.match(tell, /file this with its evidence run `node \S+file-desk-problem\.js --mechanism session-sync --reason '[^']*Repository not found[^']*' --host \S+`/u)
  assert.match(tell, / Fix: gh auth status\.$/u)
})
