// The bounded headless runner for the waste evaluator. A fake `spawn` stands in
// for the agent CLI everywhere: no test starts a real process. Nothing the
// child prints is returned beyond a stable state code and the cost number.

import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  HEADLESS_ARGV,
  HEADLESS_BUDGET_USD,
  HEADLESS_TIMEOUT_MS,
  MAX_HEADLESS_JOBS_PER_DAY,
  CHILD_ENV_ALLOW,
  billingVariableBlocks,
  findAgentCli,
  hostSupported,
  probeSignIn,
  runHeadless,
} from "../../../../../plugins/desk/mcp/src/factory/headless.js"

// A scripted fake child. `script(child)` runs on the next tick and may emit
// output, `close` or `error`. `kill` records the signal.
function fakeSpawn(scripts) {
  const calls = []
  const queue = Array.isArray(scripts) ? [...scripts] : [scripts]
  function spawn(cmd, args, opts) {
    const script = queue.length > 1 ? queue.shift() : queue[0]
    const child = new EventEmitter()
    child.pid = 4000 + calls.length
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.destroyed = []
    child.stdout.destroy = () => child.destroyed.push("stdout")
    child.stderr.destroy = () => child.destroyed.push("stderr")
    child.kills = []
    child.kill = (signal) => {
      child.kills.push(signal)
      return true
    }
    calls.push({ cmd, args, opts, child })
    if (script === "throw-enoent") {
      throw Object.assign(new Error("spawn"), { code: "ENOENT" })
    }
    if (script === "throw-other") {
      throw Object.assign(new Error("spawn"), { code: "EACCES" })
    }
    setImmediate(() => script(child))
    return child
  }
  spawn.calls = calls
  return spawn
}

const finish = (stdout, code = 0) => (child) => {
  if (stdout !== undefined) {
    child.stdout.emit("data", Buffer.from(stdout))
  }
  child.stderr.emit("data", Buffer.from("secret stderr text"))
  child.emit("close", code, null)
}

const status = (obj, code = 0) => finish(JSON.stringify(obj), code)
const SUB = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "a@b.c", orgName: "o" }
const okRun = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25 }

const baseOpts = (over = {}) => ({
  env: { PATH: "/bin", HOME: "/h" },
  job: { host: "claude-code" },
  dirExists: () => true,
  briefPaths: ["/b/one.json", "/b/two.json"],
  evaluationDir: "/e/job1",
  logDirs: ["/l/a", "/l/b", "/l/a"],
  workDir: "/scratch/run",
  cli: "/bin/claude",
  signIn: { state: "subscription" },
  ...over,
})

test("constants are the named values", () => {
  assert.equal(HEADLESS_BUDGET_USD, 1)
  assert.equal(MAX_HEADLESS_JOBS_PER_DAY, 6)
  assert.equal(HEADLESS_TIMEOUT_MS, 900000)
  assert.equal(CHILD_ENV_ALLOW.prefixes.includes("LC_"), true)
  assert.equal(CHILD_ENV_ALLOW.names.includes("CLAUDE_CONFIG_DIR"), true)
})

test("the argv is the pinned list exactly", () => {
  const argv = HEADLESS_ARGV({ briefPaths: ["/b/one.json", "/b/two.json"], evaluationDir: "/e/job1", logDirs: ["/l/a", "/l/b", "/l/a"] })
  assert.deepEqual(argv, [
    "-p",
    "Label the waste in these evaluator briefs with desk:factory-evaluator: /b/one.json /b/two.json.",
    "--agent",
    "desk:observer",
    "--output-format",
    "json",
    "--max-budget-usd",
    "1",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Write",
    "--add-dir",
    "/e/job1",
    "--add-dir",
    "/l/a",
    "--add-dir",
    "/l/b",
  ])
})

// Fixture paths are built the way the platform builds them, and the program is named the way the platform names it.
const CLI_NAME = process.platform === "win32" ? "claude.exe" : "claude"
const at = (...parts) => path.join(...parts)

test("findAgentCli prefers DESK_AGENT_CLI, then PATH, then the fixed locations, else null", () => {
  const present = new Set()
  const exists = (p) => present.has(p)
  const explicit = at("/x", "agent")
  const onPath = at("/v/bin", CLI_NAME)
  const local = at("/home/me/.local/bin", CLI_NAME)
  const claudeLocal = at("/home/me/.claude/local", CLI_NAME)
  const configured = at("/cfg/claude/local", CLI_NAME)
  const env = { DESK_AGENT_CLI: explicit, PATH: [at("/u/bin"), at("/v/bin")].join(path.delimiter), HOME: "/home/me" }
  present.add(explicit).add(onPath).add(local).add(claudeLocal)
  assert.equal(findAgentCli({ env, exists }), explicit)
  present.delete(explicit)
  assert.equal(findAgentCli({ env, exists }), onPath)
  present.delete(onPath)
  assert.equal(findAgentCli({ env, exists }), claudeLocal)
  present.add(configured)
  assert.equal(findAgentCli({ env: { ...env, CLAUDE_CONFIG_DIR: "/cfg/claude" }, exists }), configured, "the Claude config directory moves the fixed location")
  present.delete(configured)
  present.delete(claudeLocal)
  assert.equal(findAgentCli({ env, exists }), local)
  present.clear()
  assert.equal(findAgentCli({ env, exists }), null)
  assert.equal(findAgentCli({ env: {}, exists }), null)
  assert.equal(findAgentCli({ env: { PATH: `/u/bin${path.delimiter}${path.delimiter}` }, exists }), null)
})

test("findAgentCli looks for claude.exe on Windows, where a program started without a shell must be named in full", () => {
  const seen = []
  const exists = (candidate) => { seen.push(candidate); return false }
  findAgentCli({ env: { PATH: "/u/bin", HOME: "/home/me" }, exists, platform: "win32" })
  assert.deepEqual(seen.map((candidate) => path.basename(candidate)), ["claude.exe", "claude.exe", "claude.exe"])
  seen.length = 0
  findAgentCli({ env: { PATH: "/u/bin", HOME: "/home/me" }, exists, platform: "linux" })
  assert.deepEqual(seen.map((candidate) => path.basename(candidate)), ["claude", "claude", "claude"])
})

test("findAgentCli defaults to the real file check", () => {
  assert.equal(findAgentCli({ env: { DESK_AGENT_CLI: "/definitely/not/here/claude", PATH: "", HOME: "/definitely/not/here" } }), null)
})

test("hostSupported is true only for claude-code", () => {
  assert.equal(hostSupported("claude-code"), true)
  for (const h of ["codex", "copilot", "", undefined]) {
    assert.equal(hostSupported(h), false)
  }
})

test("probeSignIn: subscription, reading no more than three fields", async () => {
  const spawn = fakeSpawn(status(SUB))
  const out = await probeSignIn({ cli: "/bin/claude", env: { PATH: "/bin" }, spawn })
  assert.deepEqual(out, { state: "subscription" })
  assert.deepEqual(spawn.calls[0].args, ["auth", "status"])
  assert.equal(spawn.calls[0].cmd, "/bin/claude")
})

test("probeSignIn: not signed in is no_credentials, even with a non-zero exit", async () => {
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ loggedIn: false }, 1)) }), { state: "no_credentials" })
})

test("probeSignIn: a per-token method is disabled_would_bill", async () => {
  const out = await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })) })
  assert.deepEqual(out, { state: "disabled_would_bill" })
})

test("probeSignIn: anything unreadable is sign_in_unknown", async () => {
  const cases = [
    finish("not json"),
    finish(""),
    finish(undefined),
    finish("[1]"),
    finish("null"),
    status({ authMethod: "claude.ai", subscriptionType: "max" }),
    status({ loggedIn: "yes", authMethod: "claude.ai", subscriptionType: "max" }),
    status({ loggedIn: true, subscriptionType: "max" }),
    status({ loggedIn: true, authMethod: 7 }),
    status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
    status({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "" }),
    (child) => child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })),
  ]
  for (const script of cases) {
    assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(script) }), { state: "sign_in_unknown" })
  }
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn("throw-enoent") }), { state: "sign_in_unknown" })
})

test("probeSignIn: a hung probe times out and the exact child handle is signalled", async () => {
  const spawn = fakeSpawn(() => {})
  const out = await probeSignIn({ cli: "c", env: {}, spawn, timeoutMs: 20 })
  assert.deepEqual(out, { state: "sign_in_unknown" })
  assert.deepEqual(spawn.calls[0].child.kills, ["SIGKILL"])
})

test("probeSignIn: oversized output is sign_in_unknown", async () => {
  const out = await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(finish("x".repeat(70000))) })
  assert.deepEqual(out, { state: "sign_in_unknown" })
})

test("billingVariableBlocks: provider switches and credentials block, harmless values do not", () => {
  const blocking = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_ANYTHING_ELSE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
  ]
  for (const name of blocking) {
    assert.equal(billingVariableBlocks({ [name]: "1" }), true, name)
    assert.equal(billingVariableBlocks({ [name]: "" }), false, name)
    assert.equal(billingVariableBlocks({ [name]: "0" }), false, name)
    assert.equal(billingVariableBlocks({ [name]: "false" }), false, name)
  }
  assert.equal(billingVariableBlocks({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", AWS_REGION: "x", XANTHROPIC_A: "1" }), false)
  assert.equal(billingVariableBlocks({ ANTHROPIC_API_KEY: 1 }), false)
})

test("probeSignIn: a billing variable gives disabled_would_bill without starting anything", async () => {
  const spawn = fakeSpawn(status(SUB))
  assert.deepEqual(await probeSignIn({ cli: "c", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, spawn }), { state: "disabled_would_bill" })
  assert.equal(spawn.calls.length, 0)
  assert.deepEqual((await probeSignIn({ cli: "c", env: { ANTHROPIC_API_KEY: "" }, spawn })).state, "subscription")
})

test("probeSignIn: the probe runs with the same allowlisted environment as the run", async () => {
  const spawn = fakeSpawn(status(SUB))
  const env = { PATH: "/p", HOME: "/h", LC_ALL: "C", XDG_STATE_HOME: "/x", CLAUDE_CONFIG_DIR: "/c", GH_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", DESK_FACTORY_HEADLESS: "0", CLAUDE_CODE_ENTRYPOINT: "x", HTTPS_PROXY: "p", NODE_OPTIONS: "o", ANTHROPIC_API_KEY: "" }
  await probeSignIn({ cli: "c", env, spawn })
  assert.deepEqual(spawn.calls[0].opts.env, { PATH: "/p", HOME: "/h", LC_ALL: "C", XDG_STATE_HOME: "/x", CLAUDE_CONFIG_DIR: "/c", HTTPS_PROXY: "p", DESK_FACTORY_HEADLESS: "1" })
})

test("the allowlisted environment keeps proxy and certificate settings, so a run on a proxied machine reaches its service", () => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    assert.equal(CHILD_ENV_ALLOW.names.includes(name), true, name)
  }
  assert.equal(CHILD_ENV_ALLOW.names.includes("NODE_OPTIONS"), false, "a variable that changes what node runs stays out")
})

test("probeSignIn: the provider must be firstParty; a missing one is unknown", async () => {
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ ...SUB, apiProvider: "bedrock" })) }), { state: "disabled_would_bill" })
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ ...SUB, apiProvider: undefined })) }), { state: "sign_in_unknown" })
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ ...SUB, apiProvider: 3 })) }), { state: "sign_in_unknown" })
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ ...SUB, apiProvider: "" })) }), { state: "sign_in_unknown" })
  assert.deepEqual(await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status({ ...SUB, authMethod: "Claude.ai" })) }), { state: "disabled_would_bill" })
})

test("probeSignIn reports its child to onChild and onChildExit", async () => {
  const events = []
  await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status(SUB)), onChild: (pid) => events.push(["s", pid]), onChildExit: (pid) => events.push(["e", pid]) })
  assert.deepEqual(events, [["s", 4000], ["e", 4000]])
})

test("the default timeouts are the named constants", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    for (const [ms, run] of [
      [HEADLESS_TIMEOUT_MS, (spawn) => runHeadless(baseOpts({ spawn }))],
      [15000, (spawn) => probeSignIn({ cli: "c", env: {}, spawn })],
    ]) {
      const spawn = fakeSpawn(() => {})
      let done = false
      const p = run(spawn).then(() => {
        done = true
      })
      await new Promise((r) => setImmediate(r))
      mock.timers.tick(ms - 1)
      await new Promise((r) => setImmediate(r))
      assert.equal(done, false)
      mock.timers.tick(1)
      await p
      assert.equal(done, true)
    }
  } finally {
    mock.timers.reset()
  }
})

test("probeSignIn result never carries account values", async () => {
  const out = await probeSignIn({ cli: "c", env: {}, spawn: fakeSpawn(status(SUB)) })
  assert.equal(JSON.stringify(out).includes("@"), false)
  assert.deepEqual(Object.keys(out), ["state"])
})

test("runHeadless in a headless session starts nothing, not even the probe", async () => {
  for (const value of ["1", "yes"]) {
    const spawn = fakeSpawn(status(okRun))
    const out = await runHeadless(baseOpts({ env: { DESK_FACTORY_HEADLESS: value }, signIn: undefined, spawn }))
    assert.equal(out.state, "headless_session")
    assert.equal(out.cost_usd, null)
    assert.equal(spawn.calls.length, 0)
  }
})

test("a flag of empty or 0 is not a headless session", async () => {
  for (const value of ["", "0"]) {
    const spawn = fakeSpawn(status(okRun))
    const out = await runHeadless(baseOpts({ env: { DESK_FACTORY_HEADLESS: value }, spawn }))
    assert.equal(out.state, "ran")
  }
})

test("runHeadless starts the pinned argv with the headless flag, from the scratch folder", async () => {
  const spawn = fakeSpawn(status(okRun))
  const out = await runHeadless(baseOpts({ spawn }))
  assert.deepEqual(out, { state: "ran", cost_usd: 0.25, detail: null })
  assert.equal(spawn.calls.length, 1)
  const [call] = spawn.calls
  assert.equal(call.cmd, "/bin/claude")
  assert.deepEqual(call.args, HEADLESS_ARGV({ briefPaths: ["/b/one.json", "/b/two.json"], evaluationDir: "/e/job1", logDirs: ["/l/a", "/l/b"] }))
  assert.equal(call.opts.cwd, "/scratch/run")
  assert.equal(call.opts.env.DESK_FACTORY_HEADLESS, "1")
  assert.equal(call.opts.env.PATH, "/bin")
})

test("the child environment is built from the allowlist", async () => {
  const env = { PATH: "/bin", HOME: "/h", LANG: "C", LC_CTYPE: "C", GH_TOKEN: "t", HTTPS_PROXY: "p", ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_BEDROCK: "0", DESK_FACTORY_HEADLESS: "" }
  const spawn = fakeSpawn(status(okRun))
  await runHeadless(baseOpts({ env, spawn }))
  assert.deepEqual(spawn.calls[0].opts.env, { PATH: "/bin", HOME: "/h", LANG: "C", LC_CTYPE: "C", HTTPS_PROXY: "p", DESK_FACTORY_HEADLESS: "1" })
})

test("a billing variable blocks the run even when a sign-in result is passed", async () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) {
    for (const signIn of [undefined, { state: "subscription" }]) {
      const spawn = fakeSpawn(status(okRun))
      const out = await runHeadless(baseOpts({ env: { [name]: "k" }, signIn, spawn }))
      assert.deepEqual(out, { state: "disabled_would_bill", cost_usd: null, detail: null })
      assert.equal(spawn.calls.length, 0)
    }
  }
})

test("an unknown or malformed sign-in result is sign_in_unknown and starts nothing", async () => {
  for (const signIn of [{}, { state: "a/b" }, { state: "ran" }, "subscription"]) {
    const spawn = fakeSpawn(status(okRun))
    const out = await runHeadless(baseOpts({ signIn, spawn }))
    assert.equal(out.state, "sign_in_unknown")
    assert.equal(spawn.calls.length, 0)
  }
})

test("runHeadless probes by itself when no sign-in result is given, and starts the run on subscription", async () => {
  const spawn = fakeSpawn([status(SUB), status(okRun)])
  const out = await runHeadless(baseOpts({ signIn: undefined, spawn }))
  assert.equal(out.state, "ran")
  assert.deepEqual(spawn.calls[0].args, ["auth", "status"])
  assert.equal(spawn.calls.length, 2)
})

test("a sign-in that is not a subscription starts nothing", async () => {
  for (const state of ["no_credentials", "disabled_would_bill", "sign_in_unknown"]) {
    const spawn = fakeSpawn(status(okRun))
    const out = await runHeadless(baseOpts({ signIn: { state }, spawn }))
    assert.deepEqual(out, { state, cost_usd: null, detail: null })
    assert.equal(spawn.calls.length, 0)
  }
})

test("an unsupported host starts nothing", async () => {
  const spawn = fakeSpawn(status(okRun))
  const out = await runHeadless(baseOpts({ job: { host: "codex" }, spawn }))
  assert.equal(out.state, "unsupported_host")
  assert.equal(spawn.calls.length, 0)
})

test("a job without a host is unsupported_host and starts nothing", async () => {
  for (const job of [undefined, {}, { host: null }]) {
    const spawn = fakeSpawn(status(okRun))
    assert.equal((await runHeadless(baseOpts({ job, spawn }))).state, "unsupported_host")
    assert.equal(spawn.calls.length, 0)
  }
})

test("a missing working folder is its own code, not no_agent_cli, and starts nothing", async () => {
  for (const workDir of ["/nope", undefined]) {
    const spawn = fakeSpawn(status(okRun))
    const out = await runHeadless(baseOpts({ workDir, dirExists: (p) => p !== "/nope", spawn }))
    assert.deepEqual(out, { state: "failed", cost_usd: null, detail: "work_dir_missing" })
    assert.equal(spawn.calls.length, 0)
  }
})

test("no CLI gives no_agent_cli and starts nothing", async () => {
  const spawn = fakeSpawn(status(okRun))
  const out = await runHeadless(baseOpts({ cli: undefined, exists: () => false, spawn }))
  assert.equal(out.state, "no_agent_cli")
  assert.equal(spawn.calls.length, 0)
})

test("the CLI is found with findAgentCli when none is passed", async () => {
  const spawn = fakeSpawn(status(okRun))
  const out = await runHeadless(baseOpts({ cli: undefined, exists: (p) => p === at("/bin", CLI_NAME), spawn }))
  assert.equal(out.state, "ran")
  assert.equal(spawn.calls[0].cmd, at("/bin", CLI_NAME))
})

test("a non-zero exit is failed and stderr text is never returned", async () => {
  const out = await runHeadless(baseOpts({ spawn: fakeSpawn(finish("", 1)) }))
  assert.equal(out.state, "failed")
  assert.equal(out.cost_usd, null)
  assert.equal(JSON.stringify(out).includes("secret"), false)
})

test("an output with total_cost_usd returns it; without it the cost is null, not zero", async () => {
  assert.equal((await runHeadless(baseOpts({ spawn: fakeSpawn(status(okRun)) }))).cost_usd, 0.25)
  const out = await runHeadless(baseOpts({ spawn: fakeSpawn(status({ type: "result", subtype: "success", is_error: false })) }))
  assert.equal(out.state, "ran")
  assert.equal(out.cost_usd, null)
  const bad = await runHeadless(baseOpts({ spawn: fakeSpawn(status({ subtype: "success", is_error: false, total_cost_usd: "1" })) }))
  assert.equal(bad.cost_usd, null)
  const neg = await runHeadless(baseOpts({ spawn: fakeSpawn(status({ subtype: "success", is_error: false, total_cost_usd: -1 })) }))
  assert.equal(neg.cost_usd, null)
})

test("is_error with a budget subtype gives budget_exceeded and keeps the cost", async () => {
  const out = await runHeadless(baseOpts({ spawn: fakeSpawn(status({ is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 1.02 }, 1)) }))
  assert.equal(out.state, "budget_exceeded")
  assert.equal(out.cost_usd, 1.02)
})

test("the budget subtype is detected whether or not is_error is set", async () => {
  const out = await runHeadless(baseOpts({ spawn: fakeSpawn(status({ type: "result", subtype: "error_max_budget_usd", is_error: false, total_cost_usd: 1.01 })) }))
  assert.deepEqual(out, { state: "budget_exceeded", cost_usd: 1.01, detail: null })
  const bare = await runHeadless(baseOpts({ spawn: fakeSpawn(status({ subtype: "error_max_budget_usd" })) }))
  assert.equal(bare.state, "budget_exceeded")
})

test("ran only on a positive success; every other shape is failed with a stable detail", async () => {
  const cases = [
    [status({ is_error: true, subtype: "error_during_execution" }), "agent_error"],
    [status({ is_error: true }), "agent_error"],
    [status({}), "output_unexpected"],
    [status({ error: "x" }), "output_unexpected"],
    [status({ type: "result", subtype: "error_max_turns" }), "output_unexpected"],
    [status({ is_error: "true", subtype: "success" }), "output_unexpected"],
    [status({ is_error: false }), "output_unexpected"],
    [status({ subtype: "success" }), "output_unexpected"],
    [status({ is_error: false, subtype: 7 }), "output_unexpected"],
    [finish("garbage"), "output_unparsable"],
    [finish("[1]"), "output_unparsable"],
    [finish("null"), "output_unparsable"],
    [finish(undefined), "output_unparsable"],
  ]
  for (const [script, detail] of cases) {
    const out = await runHeadless(baseOpts({ spawn: fakeSpawn(script) }))
    assert.deepEqual([out.state, out.detail], ["failed", detail])
  }
})

test("a run past the wall-clock cap is stopped through the exact child handle", async () => {
  const spawn = fakeSpawn(() => {})
  const out = await runHeadless(baseOpts({ spawn, timeoutMs: 20 }))
  assert.equal(out.state, "timeout")
  assert.deepEqual(spawn.calls[0].child.kills, ["SIGKILL"])
})

test("a spawn error ENOENT gives no_agent_cli; another error gives failed", async () => {
  assert.equal((await runHeadless(baseOpts({ spawn: fakeSpawn("throw-enoent") }))).state, "no_agent_cli")
  assert.equal((await runHeadless(baseOpts({ spawn: fakeSpawn("throw-other") }))).state, "failed")
  const asEvent = (code) => (child) => child.emit("error", Object.assign(new Error("x"), { code }))
  assert.equal((await runHeadless(baseOpts({ spawn: fakeSpawn(asEvent("ENOENT")) }))).state, "no_agent_cli")
  assert.equal((await runHeadless(baseOpts({ spawn: fakeSpawn(asEvent("EPERM")) }))).state, "failed")
})

test("stdout beyond 1 MiB is discarded, not buffered", async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 97))
    child.stdout.emit("data", Buffer.from(JSON.stringify(okRun)))
    child.emit("close", 0, null)
  })
  const out = await runHeadless(baseOpts({ spawn }))
  assert.equal(out.state, "failed")
  assert.equal(out.cost_usd, null)
  assert.equal(out.detail, "output_too_large")
})

test("the child's PID is reported to onChild and onChildExit fires once at the end", async () => {
  const events = []
  const spawn = fakeSpawn(status(okRun))
  await runHeadless(baseOpts({ spawn, onChild: (pid) => events.push(["start", pid]), onChildExit: (pid) => events.push(["exit", pid]) }))
  assert.deepEqual(events, [["start", 4000], ["exit", 4000]])
})

test("onChildExit fires on timeout and on a spawn error, once each", async () => {
  const events = []
  await runHeadless(baseOpts({ spawn: fakeSpawn(() => {}), timeoutMs: 20, onChildExit: (pid) => events.push(pid) }))
  assert.deepEqual(events, [4000])
  const again = []
  const spawn = fakeSpawn((child) => {
    child.emit("error", Object.assign(new Error("x"), { code: "EPERM" }))
    child.emit("close", 1, null)
  })
  await runHeadless(baseOpts({ spawn, onChildExit: (pid) => again.push(pid) }))
  assert.deepEqual(again.length, 1)
})

test("a child with no PID is not reported", async () => {
  const events = []
  const spawn = fakeSpawn(status(okRun))
  const wrapped = (...a) => {
    const c = spawn(...a)
    delete c.pid
    return c
  }
  await runHeadless(baseOpts({ spawn: wrapped, onChild: () => events.push("start"), onChildExit: () => events.push("exit") }))
  assert.deepEqual(events, [])
})

test("the module never looks processes up by name", async () => {
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/headless.js", import.meta.url), "utf8")
  assert.equal(/pkill|killall|pgrep/.test(src), false)
  assert.equal(/process\.kill/.test(src), false)
})

test("a non-zero exit with output that reports no error is still failed, with the cost kept", async () => {
  const out = await runHeadless(baseOpts({ spawn: fakeSpawn(status(okRun, 2)) }))
  assert.deepEqual(out, { state: "failed", cost_usd: 0.25, detail: "exit_nonzero" })
})

test("a throwing onChild stops the exact child, returns failed and leaves nothing running", async () => {
  const spawn = fakeSpawn(() => {})
  const out = await runHeadless(baseOpts({ spawn, timeoutMs: 5000, onChild: () => { throw new Error("disk full") } }))
  assert.deepEqual(out, { state: "failed", cost_usd: null, detail: "callback_failed" })
  assert.deepEqual(spawn.calls[0].child.kills, ["SIGKILL"])
  assert.deepEqual(spawn.calls[0].child.destroyed, ["stdout", "stderr"])
})

test("a throwing onChildExit cannot change the outcome or escape", async () => {
  const out = await runHeadless(baseOpts({ spawn: fakeSpawn(status(okRun)), onChild: () => {}, onChildExit: () => { throw new Error("x") } }))
  assert.equal(out.state, "ran")
  const late = await runHeadless(baseOpts({ spawn: fakeSpawn(() => {}), timeoutMs: 20, onChildExit: () => { throw new Error("x") } }))
  assert.equal(late.state, "timeout")
})

test("an exit without a close settles after a short wait and keeps the output and cost", async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(okRun)))
    child.emit("exit", 0, null)
  })
  const out = await runHeadless(baseOpts({ spawn, graceMs: 20, timeoutMs: 5000 }))
  assert.deepEqual(out, { state: "ran", cost_usd: 0.25, detail: null })
  assert.deepEqual(spawn.calls[0].child.destroyed, ["stdout", "stderr"])
})

test("output that arrives after exit but before close is kept", async () => {
  const spawn = fakeSpawn((child) => {
    child.emit("exit", 0, null)
    child.stdout.emit("data", Buffer.from(JSON.stringify(okRun)))
    child.emit("close", 0, null)
  })
  assert.equal((await runHeadless(baseOpts({ spawn, graceMs: 5000 }))).cost_usd, 0.25)
})

test("an exit by signal is failed", async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(okRun)))
    child.emit("exit", null, "SIGTERM")
  })
  const out = await runHeadless(baseOpts({ spawn, graceMs: 20 }))
  assert.deepEqual([out.state, out.detail], ["failed", "exit_nonzero"])
})

test("the streams are released on timeout, error and normal end", async () => {
  const spawn = fakeSpawn([() => {}, finish(JSON.stringify(okRun)), (c) => c.emit("error", new Error("x"))])
  await runHeadless(baseOpts({ spawn, timeoutMs: 20 }))
  await runHeadless(baseOpts({ spawn }))
  await runHeadless(baseOpts({ spawn }))
  for (const call of spawn.calls) {
    assert.deepEqual(call.child.destroyed, ["stdout", "stderr"])
  }
})

test("findAgentCli's default check accepts an executable file and refuses a folder or a plain file", { skip: process.platform === "win32" ? "Windows has no execute permission bit: fs.access X_OK succeeds for any file, so a plain file cannot be refused" : false }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "headless-cli-"))
  try {
    for (const name of ["dir", "plain", "exe"]) {
      mkdirSync(path.join(root, name))
    }
    mkdirSync(path.join(root, "dir", "claude"))
    writeFileSync(path.join(root, "plain", "claude"), "x")
    chmodSync(path.join(root, "plain", "claude"), 0o644)
    writeFileSync(path.join(root, "exe", "claude"), "x")
    chmodSync(path.join(root, "exe", "claude"), 0o755)
    const env = (dirs) => ({ PATH: dirs.map((d) => path.join(root, d)).join(path.delimiter), HOME: path.join(root, "nohome") })
    assert.equal(findAgentCli({ env: env(["dir", "plain"]) }), null)
    assert.equal(findAgentCli({ env: env(["dir", "plain", "exe"]) }), path.join(root, "exe", "claude"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the default working-folder check accepts a folder and refuses a missing path or a file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "headless-wd-"))
  try {
    writeFileSync(path.join(root, "f"), "x")
    for (const [workDir, expected] of [[root, "ran"], [path.join(root, "missing"), "failed"], [path.join(root, "f"), "failed"]]) {
      const out = await runHeadless({ ...baseOpts({ spawn: fakeSpawn(status(okRun)) }), dirExists: undefined, workDir })
      assert.equal(out.state, expected)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("non-string environment values are not passed to the child", async () => {
  const spawn = fakeSpawn(status(okRun))
  await runHeadless(baseOpts({ env: { PATH: "/bin", HOME: 5, LANG: undefined }, spawn }))
  assert.deepEqual(spawn.calls[0].opts.env, { PATH: "/bin", DESK_FACTORY_HEADLESS: "1" })
})
