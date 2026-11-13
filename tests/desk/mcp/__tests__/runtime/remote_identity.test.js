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
const ORG_REMOTE = "https://github.com/ourostack/desk.git"
const TANDEM_REMOTE = "https://github.com/teams-microsoft/tandem.git"

function git(root, args, env) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: env ?? process.env })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

// Answers `git config` reads from `config`, and `gh` for the accounts in `logins`: `gh auth status` lists them, a token
// is held for each of `tokens`, and `gh api repos/...` reports the `access` permissions of each login (missing: 404).
// Records every call.
function fakeSpawn({ config = {}, logins = [], tokens = logins, access = {}, ghMissing = false } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push([command, ...args])
    if (command === "gh") {
      if (ghMissing) return { status: null, stdout: null, stderr: null, error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }) }
      if (args[1] === "status") return { status: 0, stdout: logins.map((login) => `  ✓ Logged in to github.com account ${login} (keyring)\n`).join(""), stderr: "" }
      if (args[1] === "token") {
        const login = args[args.indexOf("--user") + 1]
        return tokens.includes(login) ? { status: 0, stdout: `secret-${login}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" }
      }
      const login = options.env.GH_TOKEN.replace(/^secret-/u, "")
      if (!(login in access)) return { status: 1, stdout: "", stderr: "HTTP 404" }
      const field = args[args.indexOf("--jq") + 1].split(".").pop()
      return { status: 0, stdout: `${access[login][field] === true}\n`, stderr: "" }
    }
    const key = args[args.indexOf("config") + 2]
    if (args.includes("config") && key in config) return { status: 0, stdout: `${config[key]}\n` }
    return { status: 1, stdout: "" }
  }
  return { spawn, calls }
}

test("an HTTPS repository names its login by user, else by owner; anything else names none", () => {
  assert.deepEqual(parseHttpsRemote(REMOTE), { origin: "https://github.com", host: "github.com", user: "arimendelow_microsoft", owner: "arimendelow_microsoft", repo: "desk" })
  assert.deepEqual(parseHttpsRemote(ORG_REMOTE), { origin: "https://github.com", host: "github.com", user: null, owner: "ourostack", repo: "desk" })
  assert.deepEqual(parseHttpsRemote("https://github.com/ourostack/desk"), { origin: "https://github.com", host: "github.com", user: null, owner: "ourostack", repo: "desk" })
  for (const url of ["git@github.com:o/r.git", "/tmp/origin.git", "https://u:secret@github.com/o/r.git", "https://github.com:8443/o/r.git", "https://github.com/", "https://github.com/o", "https://github.com/o/r%20x", ""]) assert.equal(parseHttpsRemote(url), null, url)
})

test("only the Copilot app's credential override counts as an override", () => {
  assert.equal(hasCredentialOverride(APP_OVERRIDE), true)
  assert.equal(hasCredentialOverride({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "copilot" }), true)
  assert.equal(hasCredentialOverride({ GIT_CONFIG_PARAMETERS: "'core.fsmonitor=false'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.interactive", GIT_CONFIG_VALUE_0: "never" }), false)
  assert.equal(hasCredentialOverride({ GIT_CONFIG_COUNT: "x" }), false)
  assert.equal(hasCredentialOverride({}), false)
  assert.equal(hasCredentialOverride({ GIT_CONFIG_COUNT: "1" }), false)
})

test("a session whose helper is overridden pushes as the account its remote names, appended after the override", async () => {
  const root = await mkTempRoot("desk-identity-")
  git(root, ["init", "-q"])
  const { spawn, calls } = fakeSpawn({ config: { "remote.origin.url": REMOTE }, logins: ["arimendelow_microsoft"], access: { arimendelow_microsoft: { pull: true, push: true } } })
  const env = remoteIdentityEnv({ root, args: ["push", "--quiet", "origin", "abc:refs/heads/main"], env: APP_OVERRIDE, spawn, cache: new Map() })

  assert.ok(env.GIT_CONFIG_PARAMETERS.startsWith(APP_OVERRIDE.GIT_CONFIG_PARAMETERS + " "), "the app's own entries stay first")
  assert.equal(env.GIT_CONFIG_COUNT, APP_OVERRIDE.GIT_CONFIG_COUNT)
  assert.match(env.GIT_CONFIG_PARAMETERS, /--user arimendelow_microsoft /u)
  assert.doesNotMatch(JSON.stringify(env), /secret-/u, "no secret is written into config")
  assert.ok(calls.some((call) => call[0] === "gh" && call.includes("repos/arimendelow_microsoft/desk")), "gh checks the account can push to the repository")
  // Git reads the app's override first and ours last, so ours is the helper it uses for the remote.
  assert.equal(git(root, ["config", "--get-urlmatch", "credential.helper", REMOTE], { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1" }), credentialHelperFor({ host: "github.com", login: "arimendelow_microsoft" }))
  const named = remoteIdentityEnv({ root, args: ["fetch", REMOTE], env: APP_OVERRIDE, spawn, cache: new Map() })
  assert.match(named.GIT_CONFIG_PARAMETERS, /--user arimendelow_microsoft /u, "a URL given in place of a remote is read as the remote")
})

// Case: a desk in an organization that the personal account owns. The owner is not a login, so Desk asks gh instead.
test("an organization's desk fetches and pushes as the signed-in account that can reach it: the personal one for ourostack/desk", async () => {
  const root = await mkTempRoot("desk-identity-org-")
  const { spawn, calls } = fakeSpawn({ config: { "remote.origin.url": ORG_REMOTE }, logins: ["arimendelow_microsoft", "arimendelow"], access: { arimendelow: { pull: true, push: true } } })
  const env = remoteIdentityEnv({ root, args: ["push", "origin", "HEAD:refs/heads/main"], env: APP_OVERRIDE, spawn, cache: new Map() })

  assert.match(env.GIT_CONFIG_PARAMETERS, /--user arimendelow /u)
  assert.doesNotMatch(env.GIT_CONFIG_PARAMETERS, /arimendelow_microsoft/u, "the account that cannot reach the repository is not used")
  assert.ok(calls.some((call) => call[0] === "gh" && call.includes("repos/ourostack/desk")), "gh is asked whether each account can reach it")
})

// Case: a push to an organization's repository must go as the account that holds push rights, not the one that can only read it.
test("a push to an organization's desk goes as the account with push rights, while a fetch takes the first that can read it", async () => {
  const root = await mkTempRoot("desk-identity-tandem-")
  const { spawn } = fakeSpawn({ config: { "remote.origin.url": TANDEM_REMOTE }, logins: ["arimendelow", "arimendelow_microsoft"], access: { arimendelow: { pull: true, push: false }, arimendelow_microsoft: { pull: true, push: true } } })
  const pushed = remoteIdentityEnv({ root, args: ["push", "origin", "HEAD:refs/heads/main"], env: APP_OVERRIDE, spawn, cache: new Map() })
  assert.match(pushed.GIT_CONFIG_PARAMETERS, /--user arimendelow_microsoft /u)
  const fetched = remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn, cache: new Map() })
  assert.match(fetched.GIT_CONFIG_PARAMETERS, /--user arimendelow /u)
})

test("what gh says about an account is remembered for five minutes", async () => {
  const root = await mkTempRoot("desk-identity-cache-")
  const { spawn, calls } = fakeSpawn({ config: { "remote.origin.url": ORG_REMOTE }, logins: ["arimendelow"], access: { arimendelow: { pull: true, push: true } } })
  const cache = new Map()
  let clock = 0
  const fetch = () => remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn, cache, now: () => clock })
  const ghCalls = () => calls.filter((call) => call[0] === "gh").length

  fetch()
  const asked = ghCalls()
  fetch()
  assert.equal(ghCalls(), asked, "a second command asks gh nothing")
  clock = 6 * 60_000
  fetch()
  assert.ok(ghCalls() > asked, "after five minutes gh is asked again")
})

test("an environment, command or remote Desk cannot place with confidence is left exactly as it was", async () => {
  const root = await mkTempRoot("desk-identity-none-")
  const unreachable = fakeSpawn({ config: { "remote.origin.url": ORG_REMOTE }, logins: ["arimendelow_microsoft"], access: {} })
  assert.equal(remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn: unreachable.spawn, cache: new Map() }), APP_OVERRIDE, "no signed-in account can reach the repository")
  assert.ok(unreachable.calls.some((call) => call[0] === "gh"))

  const tokenless = fakeSpawn({ config: { "remote.origin.url": REMOTE }, logins: ["arimendelow_microsoft"], tokens: [], access: { arimendelow_microsoft: { pull: true, push: true } } })
  assert.equal(remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn: tokenless.spawn, cache: new Map() }), APP_OVERRIDE, "gh holds no token for the account")

  const plain = fakeSpawn({ config: { "remote.origin.url": REMOTE }, logins: ["arimendelow_microsoft"], access: { arimendelow_microsoft: { pull: true, push: true } } })
  const noOverride = { GIT_CONFIG_COUNT: "0" }
  assert.equal(remoteIdentityEnv({ root, args: ["push", "origin"], env: noOverride, spawn: plain.spawn, cache: new Map() }), noOverride)
  assert.equal(remoteIdentityEnv({ root, args: ["status"], env: APP_OVERRIDE, spawn: plain.spawn, cache: new Map() }), APP_OVERRIDE)
  assert.deepEqual(plain.calls, [], "nothing is asked when no override is in play or the command is local")

  const unnamed = fakeSpawn({ config: {}, logins: ["arimendelow_microsoft"], access: { arimendelow_microsoft: { pull: true, push: true } } })
  assert.equal(remoteIdentityEnv({ root, args: ["fetch", "nowhere"], env: APP_OVERRIDE, spawn: unnamed.spawn, cache: new Map() }), APP_OVERRIDE, "a remote with no configured URL")

  const ssh = fakeSpawn({ config: { "remote.origin.url": "git@github.com:o/r.git" }, logins: ["o"], access: { o: { pull: true, push: true } } })
  assert.equal(remoteIdentityEnv({ root, args: ["pull"], env: APP_OVERRIDE, spawn: ssh.spawn, cache: new Map() }), APP_OVERRIDE)

  const noGh = fakeSpawn({ config: { "remote.origin.url": REMOTE }, ghMissing: true })
  assert.equal(remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn: noGh.spawn, cache: new Map() }), APP_OVERRIDE, "gh is not installed")

  const badLogin = fakeSpawn({ config: { "remote.origin.url": "https://bad.user@github.com/ourostack/desk.git" }, logins: [], access: {} })
  assert.equal(remoteIdentityEnv({ root, args: ["fetch", "origin"], env: APP_OVERRIDE, spawn: badLogin.spawn, cache: new Map() }), APP_OVERRIDE, "a user name that is not a login is not asked about")
})

test("an override that arrives only as numbered config entries gets the helper too", async () => {
  const root = await mkTempRoot("desk-identity-count-")
  const countOnly = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "copilot" }
  const { spawn } = fakeSpawn({ config: { "remote.origin.url": REMOTE }, logins: ["arimendelow_microsoft"], access: { arimendelow_microsoft: { pull: true, push: true } } })
  const env = remoteIdentityEnv({ root, args: ["fetch", "origin"], env: countOnly, spawn, cache: new Map() })
  assert.equal(env.GIT_CONFIG_COUNT, "1")
  assert.match(env.GIT_CONFIG_PARAMETERS, /^'credential\.https:\/\/github\.com\.helper=' 'credential\.https:\/\/github\.com\.helper=!f\(\)/u)
})

test("a pull with no remote named uses the current branch's upstream remote, and a push uses its push URL", async () => {
  const root = await mkTempRoot("desk-identity-upstream-")
  const config = { "remote.fork.url": "https://github.com/someone/desk.git", "remote.fork.pushurl": REMOTE, "branch.main.remote": "fork" }
  const { spawn } = fakeSpawn({ config, logins: ["arimendelow_microsoft", "someone"], access: { someone: { pull: true, push: false }, arimendelow_microsoft: { pull: true, push: true } } })
  const onMain = (command, args, options) => (args.includes("symbolic-ref") ? { status: 0, stdout: "main\n" } : spawn(command, args, options))
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
    if (command === "gh") return args[0] === "api" ? { status: 0, stdout: "true\n", stderr: "" } : args[1] === "status" ? { status: 0, stdout: "  ✓ Logged in to github.com account arimendelow_microsoft (keyring)\n", stderr: "" } : { status: 0, stdout: "token\n", stderr: "" }
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
  assert.match(tell, /^desk: sync: the remote refused this host's credentials, probably because no GitHub account signed in to gh can reach https:\/\/github\.com\/arimendelow_microsoft\/desk\.git; /u)
  assert.match(tell, /local work continues and Desk retries with every write/u)
  assert.match(tell, /run `git -C \S+ ls-remote origin`/u)
  assert.match(tell, /file this with its evidence run `node \S+file-desk-problem\.js --mechanism session-sync --reason '[^']*Repository not found[^']*' --host \S+`/u)
  assert.match(tell, / Fix: gh auth login --hostname github\.com\.$/u)
})

test("a refused pull on a branch that tracks a remote other than origin still names the remote it could not reach", async () => {
  const fork = await mkTempRoot("desk-identity-tell-fork-")
  spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", fork])
  const root = await mkTempRoot("desk-identity-tell-none-")
  git(root, ["init", "-q", "--initial-branch=main"])
  git(root, ["config", "user.email", "t@example.com"])
  git(root, ["config", "user.name", "T"])
  git(root, ["commit", "-q", "--allow-empty", "-m", "seed"])
  git(root, ["remote", "add", "fork", fork])
  git(root, ["push", "-q", "-u", "fork", "main"])
  const refused = (command, args, options) => (args[2] === "pull" ? { status: 128, stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/o/r.git/'\n" } : spawnSync(command, args, options))
  const result = await syncWorkspace({ root, env: process.env, spawnGit: refused, spawnPull: refused, scheduleDelivery: () => {}, fileProblem: () => {} })

  assert.equal(result.cause, "auth_failed")
  assert.match(result.diagnostic, /can reach the desk's remote; /u)
})
