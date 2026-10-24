import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
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

test("managed environments refuse a missing or relative native account home",()=>{
  for(const nativeHome of [undefined,7,"relative-home"])
    assert.throws(()=>common.environment({},path.resolve("owned"),path.resolve("socket"),process.execPath,{nativeHome}),
      {code:"invalid_arguments"})
})

test("managed Windows environment keeps OS account locations separate from context storage",()=>{
  const module={exports:{}}
  const {loadTemplate}=require("./fixtures/native-template-loader.cjs")
  const windows=loadTemplate(path.join(mcpRoot,"browser-context-common.cjs"),{
    module,exports:module.exports,__dirname:mcpRoot,process:{platform:"win32"},
    require:name=>name==="path"?path.win32:require(name.startsWith("./")?path.join(mcpRoot,name):name),
  })
  const env=windows.environment({PATH:"C:\\Windows\\System32"},"C:\\owned\\context","C:\\owned\\socket",
    "C:\\Node\\node.exe",{nativeHome:"C:\\Accounts\\operator"})
  assert.equal(env.HOME,"C:\\Accounts\\operator")
  assert.equal(env.LOCALAPPDATA,"C:\\Accounts\\operator\\AppData\\Local")
  assert.equal(env.APPDATA,"C:\\Accounts\\operator\\AppData\\Roaming")
  assert.equal(env.PWTEST_DAEMON_SESSION_DIR,"C:\\owned\\context\\registry")
  assert.equal(env.XDG_CONFIG_HOME,"C:\\owned\\context\\config")
})

test("ownership namespaces reject an unknown or private managed backend",()=>{
  for(const [id,mode,backend] of [
    ["11111111-1111-4111-8111-111111111111","signed-in","foreign"],
    ["private-11111111-1111-4111-8111-111111111111","private","managed"],
  ])assert.throws(()=>common.layout(path.resolve("state"),id,mode,undefined,backend),{code:"invalid_arguments"})
})

test("default ownership markers remain private and verify their exact bytes",async t=>{
  const f=await managedFixture(t)
  common.marker(f.root,"owned fixture",true)
  common.marker(f.root,"owned fixture",false)
  assert.throws(()=>common.marker(f.root,"different owner",false),{code:"unsafe_path"})
  assert.equal(fs.readFileSync(path.join(f.root,".desk-private-owner"),"utf8"),"owned fixture")
})

test("managed receipt reads distinguish invalid or unreadable state from absence",async t=>{
  const f=await managedFixture(t),file=path.join(f.root,"receipt.json")
  for(const value of [null,{version:0,contextId:"fixture"},{version:1,contextId:"different"}]){
    fs.writeFileSync(file,JSON.stringify(value),{mode:0o600})
    assert.throws(()=>common.readManagedState(f.root,"receipt.json","fixture"),{code:"cleanup_unconfirmed"})
  }
  const lstat=fs.lstatSync
  t.mock.method(fs,"lstatSync",(target,...args)=>{
    if(target===file)throw Object.assign(Error("inspection refused"),{code:"EACCES"})
    return lstat(target,...args)
  })
  assert.throws(()=>common.readManagedState(f.root,"receipt.json","fixture"),{code:"EACCES"})
  assert.equal(fs.existsSync(file),true)
})

for(const blockedCheck of [1,2])test("managed state publication preserves the prior file when ownership inspection "+blockedCheck+" fails",async t=>{
  const f=await managedFixture(t),file=path.join(f.root,"lifecycle.json")
  fs.writeFileSync(file,'{"previous":true}',{mode:0o600})
  const lstat=fs.lstatSync
  let checks=0
  t.mock.method(fs,"lstatSync",(target,...args)=>{
    if(target===file&&++checks===blockedCheck)throw Object.assign(Error("inspection refused"),{code:"EACCES"})
    return lstat(target,...args)
  })
  assert.throws(()=>common.atomicJson(file,{next:true}),{code:"EACCES"})
  assert.equal(fs.readFileSync(file,"utf8"),'{"previous":true}')
  assert.equal(fs.readdirSync(f.root).filter(name=>name.startsWith("lifecycle.json.pending-")).length,blockedCheck===2?1:0)
})

test("profile reuse refuses missing or changed identity without deleting authentication state",async t=>{
  const f=await managedFixture(t),profile=path.join(f.root,"profile")
  fs.mkdirSync(profile,{mode:0o700})
  fs.writeFileSync(path.join(profile,"auth-marker"),"synthetic authentication state")
  const identity=common.profileIdentity(f.root)
  for(const value of [null,{...identity,dev:"changed"},{...identity,ino:"changed"},{...identity,birthtimeMs:"changed"}])
    assert.throws(()=>common.profileUnused(f.root,value,false),{code:"cleanup_unconfirmed"})
  assert.equal(fs.readFileSync(path.join(profile,"auth-marker"),"utf8"),"synthetic authentication state")
})

for(const target of ["profile","SingletonLock"])test("profile inspection "+target+" errors remain errors rather than absence",async t=>{
  const f=await managedFixture(t),profile=path.join(f.root,"profile")
  fs.mkdirSync(profile,{mode:0o700})
  const identity=common.profileIdentity(f.root),lstat=fs.lstatSync
  const refused=target==="profile"?profile:path.join(profile,target)
  t.mock.method(fs,"lstatSync",(file,...args)=>{
    if(file===refused)throw Object.assign(Error("inspection unavailable"),{code:"EIO"})
    return lstat(file,...args)
  })
  assert.throws(()=>common.profileUnused(f.root,identity,true),{code:"EIO"})
  assert.equal(fs.existsSync(profile),true)
})

test("legacy owners stay on their original backend and cannot enter managed sign-in completion",async t=>{
  const f=await managedFixture(t),id="11111111-1111-4111-8111-111111111111"
  const layout=common.layout(f.stateRoot,id,"signed-in",f.options.socketRoot)
  for(const directory of [layout.parent,layout.root,path.dirname(layout.configFile)])fs.mkdirSync(directory,{mode:0o700})
  common.marker(layout.root,layout.owner,true,layout.markerName)
  fs.writeFileSync(layout.configFile,JSON.stringify({extension:true,browser:{browserName:"chromium",
    userDataDir:path.join(f.root,"legacy-profile"),launchOptions:{channel:"msedge"}},deskNativeContext:{
    version:1,contextId:id,label:"Legacy fixture",channel:"msedge",userDataDir:path.join(f.root,"legacy-profile"),
    profileDirName:"Default",nativeReadyFile:path.join(f.root,"ready.json"),extensionId:"a".repeat(32),sourceDigest:"b".repeat(64),
  }}),{mode:0o600})
  const native=require(path.join(mcpRoot,"browser-native.cjs"))
  t.mock.method(native,"context",async input=>({exitCode:0,payload:{backend:"legacy",action:input.action}}))
  t.mock.method(native,"command",async input=>({exitCode:0,payload:{backend:"legacy",contextId:input.contextId}}))
  for(const action of ["keep","resume","discard"])
    assert.deepEqual((await f.controller.context({action,contextId:id},f.options)).payload,{backend:"legacy",action})
  assert.equal((await f.controller.command({contextId:id,args:["snapshot"]},f.options)).payload.backend,"legacy")
  assert.equal((await f.controller.context({action:"finish-sign-in",contextId:id},f.options)).payload.code,"invalid_context_state")
  assert.equal(f.requests.length,0)
})

test("missing owners preserve resume intent across ordinary home defaults without creating a replacement",async t=>{
  const f=await managedFixture(t),id="11111111-1111-4111-8111-111111111111"
  const state=path.join(f.root,"absent-state")
  t.mock.method(require(path.join(mcpRoot,"web.cjs")),"stateDir",()=>state)
  t.mock.method(os,"homedir",()=>f.root)
  t.mock.method(require(path.join(mcpRoot,"browser-local.cjs")),"run",async(args,_options,mode)=>{
    assert.deepEqual(args,["resume",id])
    assert.equal(mode,"signed-in")
    return {exitCode:1,payload:{code:"context_absent"}}
  })
  for(const options of [undefined,{env:{USERPROFILE:f.root}},{env:{}}])
    assert.equal((await f.controller.context({action:"resume",contextId:id},options)).payload.code,"context_absent")
  assert.equal(fs.existsSync(state),false)
})

test("owner inspection failures do not silently select another browser backend",async t=>{
  const f=await managedFixture(t),id="11111111-1111-4111-8111-111111111111"
  const owner=path.join(f.stateRoot,"signed-in",id),lstat=fs.lstatSync
  t.mock.method(fs,"lstatSync",(file,...args)=>{
    if(file===owner)throw Object.assign(Error("owner unavailable"),{code:"EIO"})
    return lstat(file,...args)
  })
  const result=await f.controller.context({action:"resume",contextId:id},f.options)
  assert.equal(result.payload.code,"EIO")
  assert.equal(f.requests.length,0)
})

test("private handles and duplicate interactive flags cannot request managed sign-in completion",async()=>{
  const native=require(path.join(mcpRoot,"browser-native.cjs"))
  const controller=require(path.join(mcpRoot,"browser-context.cjs"))
  assert.equal((await controller.context({action:"finish-sign-in",contextId:"private-11111111-1111-4111-8111-111111111111"})).payload.code,"invalid_arguments")
  assert.equal((await native.run(["create","--interactive","--interactive"])).payload.code,"invalid_arguments")
  assert.equal((await native.run(null)).payload.code,"invalid_arguments")
  assert.equal((await native.context({})).payload.code,"invalid_arguments")
})

test("legacy command entry refuses missing compatible runtime without allocating a context",()=>{
  const module={exports:{}},output=[]
  const proc={env:{},platform:process.platform,arch:process.arch,execPath:process.execPath,version:process.version,
    versions:{modules:process.versions.modules},argv:["node","browser-native.cjs","create"],
    stdout:{write:value=>output.push(JSON.parse(value))}}
  function loader(name){
    if(name==="./bootstrap.cjs")return {selectNode:()=>({node:null})}
    return require(name.startsWith("./")?path.join(mcpRoot,name):name)
  }
  loader.main=module
  require("./fixtures/native-template-loader.cjs").loadTemplate(path.join(mcpRoot,"browser-native.cjs"),{
    module,exports:module.exports,require:loader,process:proc,__dirname:mcpRoot,__filename:path.join(mcpRoot,"browser-native.cjs"),
  })
  assert.equal(proc.exitCode,1)
  assert.equal(output[0].code,"node_missing")
  assert.equal(output[0].contextId,undefined)
})

test("legacy preparation failures use the ordinary environment and remain structured",async()=>{
  const module={exports:{}}
  const native=require("./fixtures/native-template-loader.cjs").loadTemplate(path.join(mcpRoot,"browser-native.cjs"),{
    module,exports:module.exports,__dirname:mcpRoot,process:{env:{}},Buffer,
    require:name=>name==="./web.cjs"?{prepareBrowserRuntime:async()=>{
      throw Object.assign(Error("Preparation refused"),{code:"runtime_refused"})
    }}:require(name.startsWith("./")?path.join(mcpRoot,name):name),
  })
  const result=await native.context({action:"create",label:"Legacy fixture"})
  assert.equal(result.exitCode,1)
  assert.equal(result.payload.code,"runtime_refused")
  assert.equal(result.payload.contextId,undefined)
})

test("local control rejects unknown modes and keeps absent private handles absent",async t=>{
  const f=await managedFixture(t),local=require(path.join(mcpRoot,"browser-local.cjs"))
  assert.equal((await local.run(["create"],f.options,"automatic")).payload.code,"invalid_arguments")
  const id="private-11111111-1111-4111-8111-111111111111"
  assert.equal((await local.run(["resume",id],f.options,"private")).payload.code,"context_absent")
  assert.equal((await local.run(["discard",id],f.options,"private")).payload.state,"absent")
  assert.equal(f.requests.length,0)
})

test("a retirement written during preparation prevents the queued page operation",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Retirement race"},f.options)
  const root=created.payload.contextResources.contextDirectory,prepare=f.options.prepareBrowserRuntime
  f.options.prepareBrowserRuntime=async()=>{
    common.atomicJson(path.join(root,".managed-discard.json"),{version:1,contextId:created.payload.contextId,
      profile:common.profileIdentity(root)})
    return prepare()
  }
  const result=await f.controller.command({contextId:created.payload.contextId,args:["snapshot"]},f.options)
  assert.equal(result.payload.code,"context_discarded")
  assert.equal(f.requests.length,1,"only the original creation reached the browser")
})

test("ordinary page work cannot cross an incomplete explicit sign-in handoff",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Interactive fixture",interactive:true},f.options)
  const root=created.payload.contextResources.contextDirectory,id=created.payload.contextId
  common.atomicJson(path.join(root,".managed-sign-in-handoff.json"),{version:1,contextId:id,phase:"stopping",
    profile:common.profileIdentity(root),originalDaemon:{version:1,contextId:id,pid:123456,started:"fixture:original"}})
  const result=await f.controller.command({contextId:id,args:["snapshot"]},f.options)
  assert.equal(result.payload.code,"sign_in_incomplete")
  assert.equal(f.requests.length,1)
})

test("discard preserves the profile when its fresh identity inspection fails",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Inspection failure"},f.options)
  const root=created.payload.contextResources.contextDirectory,identity=common.profileIdentity
  let reads=0
  t.mock.method(common,"profileIdentity",directory=>{
    if(++reads===2)throw Object.assign(Error("inspection failed"),{code:"EIO"})
    return identity(directory)
  })
  const result=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
  assert.equal(result.payload.code,"EIO")
  assert.equal(fs.existsSync(path.join(root,"profile")),true)
  assert.equal(f.requests.length,1)
})

test("metadata absence from the worker never substitutes for profile-disposal proof",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Missing shutdown proof"},f.options)
  f.options.execute=async()=>({state:"absent"})
  const result=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
  assert.equal(result.payload.code,"cleanup_unconfirmed")
  assert.equal(fs.existsSync(path.join(created.payload.contextResources.contextDirectory,"profile")),true)
  assert.equal(result.payload.contextResources.profileDisposition,undefined)
})

test("uncoded managed failures retain an explicit managed cleanup obligation",async t=>{
  const f=await managedFixture(t)
  f.options.execute=async()=>{throw Error("Unconfirmed browser outcome")}
  const result=await f.controller.context({action:"create",label:"Unknown result"},f.options)
  assert.equal(result.payload.code,"managed_browser_failed")
  assert.equal(result.payload.mode,"signed-in")
  assert.equal(fs.existsSync(path.join(result.payload.contextResources.contextDirectory,"profile")),true)
})

for(const condition of ["present","inspection-error"])test("profile removal remains unconfirmed when the final check is "+condition,async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Final absence proof"},f.options)
  const profile=path.join(created.payload.contextResources.contextDirectory,"profile")
  f.options.execute=async()=>({state:"discarded"})
  const remove=fs.promises.rm,lstat=fs.lstatSync
  let removed=false
  t.mock.method(fs.promises,"rm",async(file,...args)=>{
    if(file!==profile)return remove(file,...args)
    if(condition==="present")return
    await remove(file,...args);removed=true
  })
  t.mock.method(fs,"lstatSync",(file,...args)=>{
    if(file===profile&&removed)throw Object.assign(Error("absence inspection failed"),{code:"EIO"})
    return lstat(file,...args)
  })
  const result=await f.controller.context({action:"discard",contextId:created.payload.contextId},f.options)
  assert.equal(result.exitCode,1)
  assert.equal(result.payload.code,condition==="present"?"cleanup_unconfirmed":"EIO")
  assert.equal(result.payload.contextResources.profileDisposition,undefined)
})

for(const condition of ["valid","unreadable"])test("a standalone retirement tombstone is "+condition+" without being ignored",async t=>{
  const f=await managedFixture(t)
  const created=await f.controller.context({action:"create",label:"Retained tombstone"},f.options)
  const root=created.payload.contextResources.contextDirectory,file=path.join(root,".desk-context-discarded")
  common.marker(root,JSON.stringify({contextId:created.payload.contextId,directory:root,backend:"managed"}),true,".desk-context-discarded")
  if(condition==="unreadable"){
    const lstat=fs.lstatSync
    t.mock.method(fs,"lstatSync",(target,...args)=>{
      if(target===file)throw Object.assign(Error("tombstone unavailable"),{code:"EIO"})
      return lstat(target,...args)
    })
  }
  const result=await f.controller.context({action:"resume",contextId:created.payload.contextId},f.options)
  assert.equal(result.payload.code,condition==="valid"?"context_discarded":"EIO")
  assert.equal(f.requests.length,1)
})

test("a missing installed managed browser never falls back to a private session",async t=>{
  const f=await managedFixture(t)
  delete f.options.nativeHome
  const info=os.userInfo()
  t.mock.method(os,"userInfo",()=>({...info,homedir:f.root}))
  t.mock.method(require(path.join(mcpRoot,"web-browser-discovery.cjs")),"channelBrowserSelection",()=>({}))
  const result=await f.controller.context({action:"create",label:"No installed browser"},f.options)
  assert.equal(result.payload.code,"browser_missing")
  assert.equal(f.requests.length,0)
})

test("invalid declarations without a diagnostic still refuse before launch",async t=>{
  const f=await managedFixture(t,{state:"invalid"})
  const result=await f.controller.context({action:"create",label:"Invalid declaration"},f.options)
  assert.equal(result.payload.code,"browser_declaration_unavailable")
  assert.equal(f.requests.length,0)
})

for(const shape of ["file","directory","missing"])test("default managed browser inspection handles a "+shape+" candidate",async t=>{
  const f=await managedFixture(t),executable=path.join(f.root,"fixture-msedge")
  if(shape==="file")fs.writeFileSync(executable,"browser discovery fixture")
  else if(shape==="directory")fs.mkdirSync(executable)
  delete f.options.browserExists
  t.mock.method(require(path.join(mcpRoot,"web-browser-discovery.cjs")),"channelBrowserSelection",
    (_channel,_platform,_env,exists)=>exists(executable)?{executablePath:executable}:{})
  const result=await f.controller.context({action:"create",label:"Installed file inspection"},f.options)
  assert.equal(result.exitCode,shape==="file"?0:1)
  if(shape!=="file")assert.equal(result.payload.code,"browser_missing")
  assert.equal(f.requests.length,shape==="file"?1:0)
})

for(const accepted of [true,false])test("managed Windows creation requires "+(accepted?"successful":"refused")+" owner ACL protection before launch",async t=>{
  const f=await managedFixture(t),module={exports:{}},RealFunction=Function
  t.mock.method(require(path.join(mcpRoot,"web-browser-discovery.cjs")),"channelBrowserSelection",
    ()=>({executablePath:path.join(f.root,"fixture-msedge")}))
  let profileProtected=false
  function imports(...parameters){
    const actual=new RealFunction(...parameters)
    if(parameters.length!==2||parameters[0]!=="url")return actual
    return url=>{
      if(!url.endsWith("/src/factory/windows-acl.js"))return actual(url)
      return Promise.resolve({async protectWindowsPaths(paths){
        profileProtected=paths.some(item=>item.path===path.join(f.stateRoot,"signed-in",
          "11111111-1111-4111-8111-111111111111","profile")&&item.kind==="directory"&&item.created===true)
        if(!accepted)throw Object.assign(Error("Owner ACL refused"),{code:"OWNER_ACL_REFUSED"})
      }})
    }
  }
  const local=require("./fixtures/native-template-loader.cjs").loadTemplate(path.join(mcpRoot,"browser-local.cjs"),{
    module,exports:module.exports,__dirname:mcpRoot,process:{...process,platform:"win32"},Function:imports,
    require:name=>require(name.startsWith("./")?path.join(mcpRoot,name):name),
  },{execution:"function"})
  const result=await local.run(["create"],f.options,"signed-in")
  assert.equal(profileProtected,true)
  assert.equal(result.exitCode,accepted?0:1)
  if(!accepted)assert.equal(result.payload.code,"OWNER_ACL_REFUSED")
  assert.equal(f.requests.length,accepted?1:0)
})

test("an absent private state root is not created by resume or discard",async t=>{
  const f=await managedFixture(t),state=path.join(f.root,"missing-state")
  const options={...f.options,env:{...f.options.env,DESK_BROWSER_STATE_DIR:state}}
  const local=require(path.join(mcpRoot,"browser-local.cjs")),id="private-11111111-1111-4111-8111-111111111111"
  assert.equal((await local.run(["resume",id],options,"private")).payload.code,"context_absent")
  assert.equal((await local.run(["discard",id],options,"private")).payload.state,"absent")
  assert.equal(fs.existsSync(state),false)
})

test("successful managed requests derive their native home from the OS when no override was supplied",async t=>{
  const f=await managedFixture(t),info=os.userInfo()
  delete f.options.nativeHome
  t.mock.method(os,"userInfo",()=>({...info,homedir:f.root}))
  const result=await f.controller.context({action:"create",label:"Native identity default"},f.options)
  assert.equal(result.exitCode,0)
  assert.equal(f.requests[0].execution.env.HOME,f.root)
  assert.equal(f.requests[0].execution.env.USERPROFILE,f.root)
})

test("a missing declared Chrome is not silently replaced with an available Edge",async t=>{
  const declaration={state:"declared",channel:"chrome",profileDirName:"Default"}
  const f=await managedFixture(t,declaration)
  declaration.userDataDir=path.join(f.root,"operator-profile-must-not-be-opened")
  const result=await f.controller.context({action:"create",label:"Declared browser only"},f.options)
  assert.equal(result.payload.code,"browser_missing")
  assert.equal(f.requests.length,0)
  assert.equal(fs.existsSync(declaration.userDataDir),false)
})
