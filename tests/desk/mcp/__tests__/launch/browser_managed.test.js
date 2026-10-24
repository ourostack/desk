import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"
import { removeTree } from "../_remove_tree.js"

const require = createRequire(import.meta.url)
const common = require(path.join(mcpRoot, "browser-context-common.cjs"))

test("managed execution preserves the native home instead of hiding device identity", () => {
  const root = path.resolve("owned-context")
  const nativeHome = path.resolve("native-account")
  const source = { PATH: process.env.PATH, HOME: "/inherited-other-home", USER: "operator", LOGNAME: "operator" }
  const before = { ...source }
  const env = common.environment(source, root, path.join(root, "socket"), process.execPath, { nativeHome })
  assert.equal(env.HOME, nativeHome)
  assert.equal(env.USERPROFILE, nativeHome)
  assert.equal(env.LOGNAME, "operator")
  assert.deepEqual(source, before)
})

test("managed execution confines its CLI registry while refusing ambient connection and preload overrides", () => {
  const root = path.resolve("owned-context")
  const nativeHome = path.resolve("native-account")
  const source = {
    PATH: process.env.PATH, HOME: nativeHome,
    PLAYWRIGHT_CLI_SESSION: "foreign", PWTEST_DAEMON_SESSION_DIR: "/foreign/registry",
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "not-a-credential", PLAYWRIGHT_MCP_CONFIG: "/foreign/config",
    PWTEST_SOCKETS_DIR: "/foreign/socket", CDP_ENDPOINT: "http://foreign.invalid/",
    DESK_BROWSER_PROFILE: "/foreign/profile", NODE_OPTIONS: "--require=/foreign/preload",
  }
  const env = common.environment(source, root, path.join(root, "socket"), process.execPath, { nativeHome })
  assert.equal(env.PWTEST_DAEMON_SESSION_DIR, path.join(root, "registry"))
  for (const key of ["PLAYWRIGHT_CLI_SESSION", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "PLAYWRIGHT_MCP_CONFIG",
    "PWTEST_SOCKETS_DIR", "CDP_ENDPOINT", "DESK_BROWSER_PROFILE", "NODE_OPTIONS"]) assert.equal(env[key], undefined, key)
  assert.equal(env.TMPDIR, path.join(root, "socket"))
})

test("separate managed contexts cannot share CLI registry or profile namespaces", () => {
  const nativeHome = path.resolve("native-account")
  const a = common.environment({ PATH: process.env.PATH }, path.resolve("context-a"), path.resolve("socket-a"),
    process.execPath, { nativeHome })
  const b = common.environment({ PATH: process.env.PATH }, path.resolve("context-b"), path.resolve("socket-b"),
    process.execPath, { nativeHome })
  assert.equal(a.HOME, b.HOME)
  assert.equal(typeof a.PWTEST_DAEMON_SESSION_DIR, "string")
  assert.equal(typeof b.PWTEST_DAEMON_SESSION_DIR, "string")
  assert.notEqual(a.PWTEST_DAEMON_SESSION_DIR, b.PWTEST_DAEMON_SESSION_DIR)
})

test("private execution still hides the native home and inherits no managed registry override", () => {
  const root = path.resolve("private-context")
  const env = common.environment({ PATH: process.env.PATH, HOME: "/native-account",
    PWTEST_DAEMON_SESSION_DIR: "/foreign/registry" }, root, path.join(root, "socket"), process.execPath)
  assert.equal(env.HOME, path.join(root, "home"))
  assert.equal(env.PWTEST_DAEMON_SESSION_DIR, undefined)
})

async function managedFixture(t, declaration = { state: "none" }) {
  const root = await mkTempRoot("desk-managed-")
  t.after(() => removeTree(root))
  const stateRoot = path.join(root, "state")
  fs.mkdirSync(stateRoot, { mode: 0o700 })
  const installed = { dir: path.join(root, "generation") }
  const cli = path.join(installed.dir, "node_modules/playwright-core/lib/tools/cli-client")
  fs.mkdirSync(cli, { recursive: true })
  for (const name of ["program", "registry", "session"]) fs.writeFileSync(path.join(cli, name + ".js"), "")
  // This unit test must never discover or read the operator's profiles.
  t.mock.method(require(path.join(mcpRoot, "web-real-profile.cjs")), "readDeclaration", () => declaration)
  const requests = []
  const options = {
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, DESK_BROWSER_STATE_DIR: stateRoot,
      PROGRAMFILES: root, "PROGRAMFILES(X86)": root, LOCALAPPDATA: root },
    nativeHome: root,
    socketRoot: path.join(root, "sockets"),
    browserExists: file => /msedge|Microsoft Edge/i.test(file),
    contextId: () => "11111111-1111-4111-8111-111111111111",
    prepareBrowserRuntime: async () => ({ nodePath: process.execPath, installed, stateRoot }),
    execute: async (_node, args, execution) => {
      requests.push({ request: JSON.parse(args[1]), execution })
      return { state: "running", result: { fixture: "external-browser-launch-only" } }
    },
  }
  fs.mkdirSync(options.socketRoot)
  const controller = require(path.join(mcpRoot, "browser-context.cjs"))
  return { root, stateRoot, options, requests, controller }
}

test("normal create launches an exclusive persistent sandboxed profile without an existing human profile or extension", async t => {
  const f = await managedFixture(t)
  const result = await f.controller.context({ action: "create", label: "Work browser" }, f.options)
  assert.equal(result.exitCode, 0, JSON.stringify(result.payload))
  assert.equal(result.payload.mode, "signed-in")
  const resources = result.payload.contextResources
  const config = JSON.parse(fs.readFileSync(resources.configFile, "utf8"))
  assert.equal(config.browser.userDataDir, path.join(resources.contextDirectory, "profile"))
  assert.equal(config.browser.isolated, false)
  assert.equal(config.browser.launchOptions.headless, true)
  assert.equal(config.browser.launchOptions.chromiumSandbox, true)
  assert.equal(config.extension, undefined)
  assert.equal(config.deskNativeContext, undefined)
  assert.equal(f.requests[0].request.backend, "managed")
  assert.equal(f.requests[0].execution.env.HOME, f.root)
  assert.equal(f.requests[0].execution.env.PWTEST_DAEMON_SESSION_DIR, path.join(resources.contextDirectory, "registry"))
})

test("managed command refuses a changed profile binding before external execution", async t => {
  const f = await managedFixture(t)
  const created = await f.controller.context({ action: "create", label: "Work browser" }, f.options)
  assert.equal(created.exitCode, 0, JSON.stringify(created.payload))
  const file = created.payload.contextResources.configFile
  const config = JSON.parse(fs.readFileSync(file, "utf8"))
  config.browser.userDataDir = path.join(f.root, "foreign-profile")
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  const before = f.requests.length
  const result = await f.controller.command({ contextId: created.payload.contextId, args: ["snapshot"] }, f.options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "unsafe_registry")
  assert.equal(f.requests.length, before)
})

test("managed creation refuses owner-protection failure before launching or creating an authentication profile", async t => {
  const f = await managedFixture(t)
  t.mock.method(require(path.join(mcpRoot, "browser-native.cjs")), "protectSigned", async () => {
    throw Object.assign(new Error("Owner protection unavailable"), { code: "OWNER_PROTECTION_UNAVAILABLE" })
  })
  const result = await f.controller.context({ action: "create", label: "Work browser" }, f.options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "OWNER_PROTECTION_UNAVAILABLE")
  assert.equal(f.requests.length, 0)
  assert.equal(fs.existsSync(path.join(f.stateRoot, "signed-in", "11111111-1111-4111-8111-111111111111", "profile")), false)
})

test("interactive signed-in creation is explicit and private contexts refuse it", async t => {
  const f = await managedFixture(t)
  const result = await f.controller.context({ action: "create", label: "Human sign-in", interactive: true }, f.options)
  assert.equal(result.exitCode, 0, JSON.stringify(result.payload))
  assert.equal(JSON.parse(fs.readFileSync(result.payload.contextResources.configFile)).browser.launchOptions.headless, false)
  assert.equal(f.requests[0].request.browserArgs.includes("--headed"), true)
  for (const input of [
    { action: "create", mode: "private", interactive: true },
    { action: "create", label: "Work", interactive: "true" },
    { action: "resume", contextId: result.payload.contextId, interactive: true },
  ]) assert.equal((await f.controller.context(input, f.options)).payload.code, "invalid_arguments")
})

test("the public CLI accepts the explicit interactive sign-in flag without a second parser", async t => {
  const f = await managedFixture(t)
  const result = await f.controller.run(["create", "--label", "Human sign-in", "--interactive"], f.options)
  assert.equal(result.exitCode, 0, JSON.stringify(result.payload))
  assert.equal(f.requests[0].request.browserArgs.includes("--headed"), true)
})

test("a managed owner cannot be changed into an extension-backed owner through its config", async t => {
  const f = await managedFixture(t)
  const created = await f.controller.context({ action: "create", label: "Managed" }, f.options)
  assert.equal(created.exitCode, 0)
  const file = created.payload.contextResources.configFile
  const config = JSON.parse(fs.readFileSync(file))
  config.deskNativeContext = { contextId: created.payload.contextId }
  fs.writeFileSync(file, JSON.stringify(config))
  t.mock.method(require(path.join(mcpRoot, "browser-native.cjs")), "command", async () =>
    ({ exitCode: 0, payload: { state: "wrong-backend" } }))
  const result = await f.controller.command({ contextId: created.payload.contextId, args: ["snapshot"] }, f.options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "unsafe_registry")
})

test("an invalid browser declaration is not silently replaced with a different browser", async t => {
  const f = await managedFixture(t, { state: "invalid", summary: "Invalid configured browser" })
  const result = await f.controller.context({ action: "create", label: "Managed" }, f.options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "browser_declaration_unavailable")
  assert.equal(f.requests.length, 0)
})

test("unknown managed runner outcomes preserve the handle and cleanup obligations", async t => {
  const f = await managedFixture(t)
  f.options.execute = async () => {
    throw Object.assign(new Error("Acknowledgement lost"), { code: "runner_failed", resources: { disposition: "unknown" } })
  }
  const result = await f.controller.context({ action: "create", label: "Managed" }, f.options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.mode, "signed-in")
  assert.equal(result.payload.resources.disposition, "unknown")
  assert.equal(fs.existsSync(result.payload.contextResources.contextDirectory), true)
})

test("managed operations serialize per context rather than racing the maintained session", async t => {
  const f = await managedFixture(t)
  const created = await f.controller.context({ action: "create", label: "Managed" }, f.options)
  assert.equal(created.exitCode, 0)
  // The external OS privacy checks have their own refusal test above.
  t.mock.method(require(path.join(mcpRoot, "browser-native.cjs")), "protectSigned", async () => {})
  t.mock.method(require(path.join(mcpRoot, "web-native-messaging.cjs")), "privatePaths", () => {})
  let active = 0, maximum = 0
  f.options.execute = async () => {
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => setTimeout(resolve, 250))
    active--
    return { state: "running", result: "inspected" }
  }
  const result = await Promise.all([1, 2].map(() =>
    f.controller.command({ contextId: created.payload.contextId, args: ["snapshot"] }, f.options)))
  assert.deepEqual(result.map(value => value.exitCode), [0, 0])
  assert.equal(maximum, 1)
})

test("discard removes only the owned authentication profile and permanently retires the handle", async t => {
  const f = await managedFixture(t)
  const created = await f.controller.context({ action: "create", label: "Managed" }, f.options)
  assert.equal(created.exitCode, 0)
  const root = created.payload.contextResources.contextDirectory
  fs.writeFileSync(path.join(root, "profile", "example-session"), "fake session fixture")
  fs.writeFileSync(path.join(root, "export.txt"), "keep this export")
  f.options.execute = async (_node, args) => ({
    state: JSON.parse(args[1]).operation === "discard" ? "discarded" : "running",
  })
  const discarded = await f.controller.context({ action: "discard", contextId: created.payload.contextId }, f.options)
  assert.equal(discarded.exitCode, 0, JSON.stringify(discarded.payload))
  assert.equal(fs.existsSync(path.join(root, "profile")), false)
  assert.equal(fs.readFileSync(path.join(root, "export.txt"), "utf8"), "keep this export")
  f.options.prepareBrowserRuntime = async () => { throw new Error("Retired handles must refuse before runtime preparation") }
  const resumed = await f.controller.context({ action: "resume", contextId: created.payload.contextId }, f.options)
  assert.equal(resumed.payload.code, "context_discarded")
})

test("MB-1 retired discard retries transient profile removal under the context lock",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Retry owned disposal"},f.options)
  assert.equal(created.exitCode,0)
  const root=created.payload.contextResources.contextDirectory,profile=path.join(root,"profile")
  fs.writeFileSync(path.join(profile,"auth-marker"),"fixture only")
  let stops=0,removals=0
  f.options.execute=async()=>{stops++;return {state:"discarded"}}
  const remove=fs.promises.rm
  t.mock.method(fs.promises,"rm",async(file,...args)=>{
    if(file===profile&&removals++===0)throw Object.assign(Error("busy"),{code:"EBUSY"})
    return remove(file,...args)
  })
  const first=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
  assert.equal(first.exitCode,1)
  assert.equal(fs.existsSync(profile),true)
  assert.equal((await f.controller.command({contextId:created.payload.contextId,args:["snapshot"]},f.options)).payload.code,"context_discarded")
  const second=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
  assert.equal(second.exitCode,0,JSON.stringify(second.payload))
  assert.equal(stops,2,"retry must obtain fresh shutdown proof")
  assert.equal(fs.existsSync(profile),false)
  const again=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
  assert.equal(again.exitCode,0,JSON.stringify(again.payload))
  assert.equal(stops,3,"even an absent profile must not substitute for fresh daemon proof")
})

for(const change of ["replacement-profile","singleton-lock"]){
  test("MB-1 retired cleanup retains authentication bytes on "+change,async t=>{
    const f=await managedFixture(t)
    const created=await f.controller.context({action:"create",label:"Retained cleanup"},f.options)
    const root=created.payload.contextResources.contextDirectory,profile=path.join(root,"profile")
    fs.writeFileSync(path.join(profile,"auth-marker"),"fixture")
    f.options.execute=async()=>({state:"discarded"})
    const remove=fs.promises.rm
    let first=true
    t.mock.method(fs.promises,"rm",async(file,...args)=>{
      if(file===profile&&first){first=false;throw Object.assign(Error("busy"),{code:"EBUSY"})}
      return remove(file,...args)
    })
    assert.equal((await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)).exitCode,1)
    if(change==="replacement-profile"){
      fs.renameSync(profile,path.join(root,"original-profile"))
      fs.mkdirSync(profile,{mode:0o700})
    }else fs.writeFileSync(path.join(profile,"SingletonLock"),"fixture")
    const result=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
    assert.equal(result.exitCode,1)
    assert.equal(result.payload.code,"cleanup_unconfirmed")
    assert.equal(fs.readFileSync(path.join(change==="replacement-profile"?path.join(root,"original-profile"):profile,"auth-marker"),"utf8"),"fixture")
    assert.equal(fs.existsSync(profile),true)
  })
}

test("MB-1 lost worker acknowledgement leaves a retired handle with resumable cleanup identity",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Lost acknowledgement"},f.options)
  const root=created.payload.contextResources.contextDirectory
  let attempts=0
  f.options.execute=async()=>{
    if(++attempts===1)throw Object.assign(Error("lost stop acknowledgement"),{code:"runner_failed"})
    return {state:"discarded"}
  }
  assert.equal((await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)).exitCode,1)
  assert.equal(fs.existsSync(path.join(root,".managed-discard.json")),true)
  assert.equal((await f.controller.context({action:"resume",contextId:created.payload.contextId},f.options)).payload.code,"context_discarded")
  assert.equal((await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)).exitCode,0)
})
