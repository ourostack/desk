// These fixtures implement only the maintained CLI boundary, never a browser.
// Removing isolation, validation, liveness or cleanup verification must break these tests.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import childProcess, { execFile } from "node:child_process"
import { promisify } from "node:util"
import net from "node:net"
import { pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import { removeTree } from "../_remove_tree.js"
import { windowsPowerShellPath } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

const require = createRequire(import.meta.url)
const entry = path.join(mcpRoot, "browser-private.cjs")
const A = "private-11111111-1111-4111-8111-111111111111"
const B = "private-22222222-2222-4222-8222-222222222222"
const exec = promisify(execFile)
// Data-URL registrations observe/instrument the owned process boundary without
// replaying the isolation preload, which would overwrite its private HOME.
function resourceImports() {
  const imports=[]
  for(let i=0;i<process.execArgv.length;i++)
    if(process.execArgv[i]==="--import"&&process.execArgv[i+1]?.startsWith("data:"))
      imports.push("--import",process.execArgv[++i])
  return imports
}
function controller() {
  assert.equal(fs.existsSync(entry), true, "private browser controller must exist")
  return require(entry)
}
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
async function fixture() {
  const root = await mkTempRoot("desk-private-")
  console.log("RESOURCE fixture " + root)
  const modules = path.join(root, "generation", "node_modules", "playwright-core", "lib", "tools", "cli-client")
  put(path.join(modules, "registry.js"), `
const fs = require("fs"), path = require("path");
const daemonDir=()=>process.env.PWTEST_DAEMON_SESSION_DIR||path.join(process.env.HOME,"registry");
exports.createClientInfo = () => ({ version:"1", workspaceDir:process.cwd(), daemonProfilesDir:daemonDir() });
exports.baseDaemonDir = daemonDir;
exports.Registry = { load: async () => ({ entry: (c,n) => {
  const file=path.join(c.daemonProfilesDir,n+".session");
  if (!fs.existsSync(file)) return undefined;
  try { return { file, daemonDir:c.daemonProfilesDir, config:JSON.parse(fs.readFileSync(file)) }; } catch { return undefined; }
} }) };
`)
  put(path.join(modules, "session.js"), `
const fs=require("fs"),path=require("path");
const transport=require("./fixtureTransport");
exports.Session=class {
  constructor(e) { this.e=e; this.config=e.config; }
  isCompatible() { return this.config.version==="1"; }
  async canConnect() {
    try { return transport.connect(this.e.file); }
    catch(error) { fs.appendFileSync(this.e.file+".unlinks",error.code+"\\n"); return false; }
  }
  async stop() {
    if(!await this.canConnect()) return {wasOpen:false};
    if(!await this.canConnect()) return {wasOpen:true};
    if(this.config.stopError) throw Error("unconfirmed stop");
    if(this.config.stillRunning) return;
    this.config.running=false;
    if(!this.config.stale) fs.unlinkSync(this.e.file);
    if(this.config.leaveSocket) { fs.mkdirSync(path.dirname(this.config.socketPath),{recursive:true});fs.writeFileSync(this.config.socketPath,"stale socket"); }
  }
  async deleteSessionConfig() { if(!this.config.cleanupError) fs.unlinkSync(this.e.file); }
};
`)
  put(path.join(modules, "fixtureTransport.js"), `
const fs=require("fs");
exports.connect=file=>{
  const config=JSON.parse(fs.readFileSync(file));
  const countFile=file+".connections";
  const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile)):0;
  fs.writeFileSync(countFile,String(count+1));
  const code=config.connectionErrors?.[count] || (config.probeError?"EMFILE":null);
  if(code) throw Object.assign(Error("fixture connect "+code),{code});
  return config.running;
};
`)
  const preload = path.join(root, "transport-preload.cjs")
  put(preload, `
const fs=require("fs"),path=require("path"),{EventEmitter}=require("events");
const controlFile=${JSON.stringify(path.join(root, "runtime-controls.json"))};
const controls=fs.existsSync(controlFile)?JSON.parse(fs.readFileSync(controlFile)):{};
if(controls.platform) Object.defineProperty(process,"platform",{value:controls.platform});
if(controls.fastTimers) {
  const timeout=setTimeout;
  global.setTimeout=(fn,ms,...args)=>timeout(fn,[10000,90000].includes(ms)?10:ms,...args);
}
const transport=require(${JSON.stringify(path.join(modules, "fixtureTransport.js"))});
require("net").createConnection=(socketPath,connected)=>{
  const socket=new EventEmitter();
  socket.destroy=()=>{socket.destroyed=true;queueMicrotask(()=>socket.emit("close"));};
  socket.write=(text,callback)=>{
    const message=JSON.parse(text);
    const dir=process.env.PWTEST_DAEMON_SESSION_DIR||path.join(process.env.HOME,"registry");
    const file=fs.readdirSync(dir).filter(n=>n.endsWith(".session")).map(n=>path.join(dir,n)).find(f=>JSON.parse(fs.readFileSync(f)).socketPath===socketPath);
    const config=JSON.parse(fs.readFileSync(file));
    callback();
    if(config.noReply) return;
    if(config.closeWithoutAck) { socket.destroy();return; }
    if(config.stopError) { queueMicrotask(()=>socket.emit("data",Buffer.from(JSON.stringify({id:message.id,error:"unconfirmed stop"})+"\\n")));return; }
    if(message.method==="stop") {
      if(!config.stillRunning) {
        config.running=false;
        fs.writeFileSync(file,JSON.stringify(config));
        if(!config.stale) fs.unlinkSync(file);
      }
      if(config.leaveSocket) {fs.mkdirSync(path.dirname(socketPath),{recursive:true});fs.writeFileSync(socketPath,"stale socket");}
      queueMicrotask(()=>socket.emit("data",Buffer.from(JSON.stringify({id:config.responseId??message.id,result:config.stopAck??"ok"})+"\\n")));
    } else {
      const args=message.params.args._;
      if(args.includes("transport-error")) {queueMicrotask(()=>socket.emit("error",Object.assign(Error("https://user:password@example.test/?token=abc"),{code:"ECONNRESET"})));return;}
      const result=config.runResponse || (args.includes("json-error")?{isError:true,text:"upstream command failed"}:{text:JSON.stringify({args:["--session="+config.name,"--json",...args],raw:message.params.raw,home:process.env.HOME,cwd:process.cwd(),pid:process.pid,inherited:[]})});
      queueMicrotask(()=>socket.emit("data",Buffer.from(JSON.stringify({id:config.responseId??message.id,result})+"\\n")));
    }
  };
  queueMicrotask(()=>{
    if(controls.connectHang) return;
    try {
      const dir=process.env.PWTEST_DAEMON_SESSION_DIR||path.join(process.env.HOME,"registry");
      const file=fs.readdirSync(dir).filter(n=>n.endsWith(".session")).map(n=>path.join(dir,n)).find(f=>JSON.parse(fs.readFileSync(f)).socketPath===socketPath);
      if(!file || !transport.connect(file)) throw Object.assign(Error("fixture absent"),{code:"ENOENT"});
      connected();
    } catch(error) { socket.emit("error",error);socket.destroy(); }
  });
  return socket;
};
`)
  const processPreload = path.join(root, "process-observation.mjs")
  put(processPreload, `
import fs from "node:fs";
import {processStartReaders} from ${JSON.stringify(pathToFileURL(path.join(mcpRoot, "src/readiness/process-start.js")).href)};
const file=${JSON.stringify(path.join(root, "runtime-controls.json"))};
const controls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
// The fake CLI runs in this frontend, not in an independently observable daemon.
processStartReaders[process.platform]=async pid=>
  pid===process.pid&&!controls.unobservableDaemon?"fixture:"+process.pid:null;
`)
  put(path.join(modules, "..", "utils", "socketConnection.js"), `
exports.SocketConnection=class {
  constructor(socket) {
    this.socket=socket;
    socket.on("data",data=>this.onmessage?.(JSON.parse(String(data))));
    socket.on("close",()=>this.onclose?.());
  }
  send(message) { return new Promise((resolve,reject)=>this.socket.write(JSON.stringify(message)+"\\n",error=>error?reject(error):resolve())); }
  close() {this.socket.destroy();}
};
`)
  put(path.join(modules, "minimist.js"), `exports.minimist=args=>({_:args});`)
  put(path.join(modules, "help.json"), JSON.stringify({ booleanOptions: [], commands: {
    snapshot: { flags: {}, args: [] },
  } }))
  put(path.join(modules, "program.js"), `
const fs=require("fs"),path=require("path"),r=require("./registry");
exports.program=async () => {
  const args=process.argv.slice(2), id=args.find(a=>a.startsWith("--session=")).slice(10);
  const c=r.createClientInfo(), file=path.join(c.daemonProfilesDir,id+".session");
  if(args.includes("open")) {
    const slash=String.fromCharCode(92),pipe=slash+slash+"."+slash+"pipe"+slash+"pw-test-cli-"+id;
    fs.mkdirSync(c.daemonProfilesDir,{recursive:true});
    const persistent=args.includes("--persistent");
    const configFile=args.find(a=>a.startsWith("--config="))?.slice(9);
    const browser=persistent?JSON.parse(fs.readFileSync(configFile)).browser:{browserName:"chromium",launchOptions:{}};
    fs.writeFileSync(file,JSON.stringify({ name:id,version:"1",workspaceDir:process.cwd(),
      socketPath:process.platform==="win32"?pipe:path.join(process.env.TMPDIR,"pw-test","cli","test.sock"),
      cli:persistent?{persistent:true}:{},browser,running:true }));
  }
  if(args.includes("fail-start")) throw Error("startup failure");
  if(args.includes("json-error")) { console.log(JSON.stringify({isError:true,error:"upstream command failed"})); return; }
  if(args.includes("transport-error")) throw Error("Bearer secret-value https://user:password@example.test/?token=abc");
  console.log(JSON.stringify({ args, cwd:process.cwd(), home:process.env.HOME, config:process.env.XDG_CONFIG_HOME,
    temp:process.env.TMPDIR, pid:process.pid, nodeOptions:process.env.NODE_OPTIONS,
    inherited:Object.keys(process.env).filter(k=>/^(PLAYWRIGHT|PWTEST|DESK_BROWSER|CDP)/.test(k)) }));
};
`)
  const stateRoot = path.join(root, "state")
  fs.mkdirSync(stateRoot)
  const options = {
    browserExists: () => false,
    env: { PATH: process.env.PATH, HOME: "/forbidden/operator", PLAYWRIGHT_CLI_SESSION: B,
      DESK_BROWSER_STATE_DIR: stateRoot,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "secret", PLAYWRIGHT_MCP_CONFIG: "/forbidden",
      PWTEST_SOCKETS_DIR: "/forbidden", DESK_BROWSER_PROFILE: "/forbidden", NODE_OPTIONS: "--not-allowed" },
    prepareBrowserRuntime: async () => ({ nodePath: process.execPath, stateRoot, installed: { dir: path.join(root, "generation") } }),
    // Keep short namespaces inside the exact-owned fixture for non-native tests.
    socketRoot: path.join(root, "sockets"),
    execute: async (node, args, opts) => {
      // Coverage may inject its own preload after this product boundary.
      assert.equal(opts.env.NODE_OPTIONS, undefined, "private runner must not inherit caller preloads")
      const result = await exec(node, [...resourceImports(),"--import", pathToFileURL(processPreload).href,"--require", preload, ...args], { cwd: opts.cwd, env: opts.env })
        .catch(error => {
          const payload = JSON.parse(error.stdout)
          throw Object.assign(Error(payload.message), { code: payload.code })
        })
      const payload = JSON.parse(result.stdout)
      if (payload.isError) throw Object.assign(Error(payload.message), { code: payload.code })
      return payload
    },
  }
  fs.mkdirSync(options.socketRoot)
  const invoke = (args, extra = {}) => controller().run(args, { ...options, ...extra })
  const metadata = id => path.join(stateRoot, "private", id, "home", "registry", id + ".session")
  const change = (id, fields) => {
    const file = metadata(id)
    put(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...fields }))
    put(file + ".connections", "0")
  }
  const control = fields => put(path.join(root, "runtime-controls.json"), JSON.stringify(fields))
  return { root, stateRoot, options, invoke, metadata, change, modules, preload, control }
}

function defaultExecutor(f, body) {
  const node = path.join(f.root, "runner-node")
  put(node, "#!/usr/bin/env node\n" + (body || `
const cp=require("child_process");
const result=cp.spawnSync(process.execPath,[...${JSON.stringify(resourceImports())},"--require",${JSON.stringify(f.preload)},...process.argv.slice(2)],{stdio:"inherit"});
process.exitCode=result.status===null?1:result.status;
`))
  fs.chmodSync(node, 0o700)
  return {
    execute: undefined,
    prepareBrowserRuntime: async () => ({ ...await f.options.prepareBrowserRuntime(), nodePath: node }),
  }
}

function managedOptions(f,id) {
  return {...f.options,nativeHome:f.root,contextId:()=>id,
    env:{...f.options.env,PROGRAMFILES:f.root,"PROGRAMFILES(X86)":f.root,LOCALAPPDATA:f.root},
    browserExists:file=>/msedge|Microsoft Edge/i.test(file)}
}

test("managed worker retains its profile when the daemon generation cannot be observed", async t => {
  const f = await fixture()
  const id = "11111111-1111-4111-8111-111111111111"
  t.mock.method(require(path.join(mcpRoot, "web-real-profile.cjs")), "readDeclaration", () => ({ state: "none" }))
  f.control({ unobservableDaemon: true })
  const controller = require(path.join(mcpRoot, "browser-context.cjs"))
  const result = await controller.context({ action: "create", label: "Unconfirmed daemon" }, managedOptions(f,id))
  assert.equal(result.exitCode, 1, JSON.stringify(result.payload))
  assert.equal(result.payload.code, "startup_unconfirmed")
  assert.equal(fs.existsSync(path.join(result.payload.contextResources.contextDirectory, "profile")), true)
})

test("managed worker retains its persistent profile across frontend calls without a native extension", async t => {
  const f = await fixture()
  const id = "11111111-1111-4111-8111-111111111111"
  t.mock.method(require(path.join(mcpRoot, "web-real-profile.cjs")), "readDeclaration", () => ({ state: "none" }))
  const options = managedOptions(f,id)
  const controller = require(path.join(mcpRoot, "browser-context.cjs"))
  const created = await controller.context({ action: "create", label: "Managed worker" }, options)
  assert.equal(created.exitCode, 0, JSON.stringify(created.payload))
  const resumed = await controller.context({ action: "resume", contextId: id }, options)
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.payload))
  const snapshot = await controller.command({ contextId: id, args: ["snapshot"] }, options)
  assert.equal(snapshot.exitCode, 0, JSON.stringify(snapshot.payload))
  assert.equal(snapshot.payload.result.home, f.root)
  const discarded = await controller.context({ action: "discard", contextId: id }, options)
  assert.equal(discarded.exitCode, 0, JSON.stringify(discarded.payload))
  assert.equal(discarded.payload.state, "discarded")
})

test("managed worker refuses a foreign persistent profile in daemon metadata", async t => {
  const f = await fixture()
  const id = "11111111-1111-4111-8111-111111111111"
  t.mock.method(require(path.join(mcpRoot, "web-real-profile.cjs")), "readDeclaration", () => ({ state: "none" }))
  const options = managedOptions(f,id)
  const controller = require(path.join(mcpRoot, "browser-context.cjs"))
  const created = await controller.context({ action: "create", label: "Managed worker" }, options)
  assert.equal(created.exitCode, 0, JSON.stringify(created.payload))
  const metadata = path.join(created.payload.contextResources.contextDirectory, "registry", id + ".session")
  const config = JSON.parse(fs.readFileSync(metadata, "utf8"))
  config.browser.userDataDir = path.join(f.root, "foreign-profile")
  fs.writeFileSync(metadata, JSON.stringify(config))
  const result = await controller.command({ contextId: id, args: ["snapshot"] }, options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "unsafe_registry")
})

test("explicit sign-in completion reopens only the same owned profile headlessly without replaying its pages", async t => {
  const f = await fixture()
  const id = "11111111-1111-4111-8111-111111111111"
  t.mock.method(require(path.join(mcpRoot, "web-real-profile.cjs")), "readDeclaration", () => ({ state: "none" }))
  const options = managedOptions(f,id)
  const controller = require(path.join(mcpRoot, "browser-context.cjs"))
  const created = await controller.context({ action: "create", label: "Human sign-in", interactive: true }, options)
  assert.equal(created.exitCode, 0, JSON.stringify(created.payload))
  const root = created.payload.contextResources.contextDirectory
  const file = created.payload.contextResources.configFile
  fs.writeFileSync(path.join(root, "profile", "auth-marker"), "fake session fixture")
  assert.equal(JSON.parse(fs.readFileSync(file)).browser.launchOptions.headless, false)
  const result = await controller.context({ action: "finish-sign-in", contextId: id }, options)
  assert.equal(result.exitCode, 0, JSON.stringify(result.payload))
  assert.equal(result.payload.contextId, id)
  assert.equal(result.payload.result.interactive, false)
  assert.equal(result.payload.result.authentication, "inspect-page")
  assert.equal(result.payload.result.previousPages, "closed-without-replay")
  assert.equal(JSON.parse(fs.readFileSync(file)).browser.launchOptions.headless, true)
  assert.equal(fs.readFileSync(path.join(root, "profile", "auth-marker"), "utf8"), "fake session fixture")
  assert.equal((await controller.context({ action: "discard", contextId: id }, options)).exitCode, 0)
})

test("sign-in completion cannot restart an ordinary background work context", async t => {
  const f = await fixture()
  const id = "11111111-1111-4111-8111-111111111111"
  t.mock.method(require(path.join(mcpRoot, "web-real-profile.cjs")), "readDeclaration", () => ({ state: "none" }))
  const options = managedOptions(f,id)
  const controller = require(path.join(mcpRoot, "browser-context.cjs"))
  const created = await controller.context({ action: "create", label: "Background work" }, options)
  assert.equal(created.exitCode, 0, JSON.stringify(created.payload))
  const result = await controller.context({ action: "finish-sign-in", contextId: id }, options)
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "invalid_context_state")
  const metadata = path.join(created.payload.contextResources.contextDirectory, "registry", id + ".session")
  assert.equal(JSON.parse(fs.readFileSync(metadata)).running, true)
  assert.equal((await controller.context({ action: "discard", contextId: id }, options)).exitCode, 0)
})

test("default executor runs the selected compatible child and confirms its result", { skip: process.platform === "win32" ? "Unix executable shim" : false }, async () => {
  const f = await fixture()
  const result = await f.invoke(["create"], { contextId: () => A, ...defaultExecutor(f) })
  assert.equal(result.exitCode, 0)
  assert.equal(result.payload.state, "running")
  assert.equal((await f.invoke(["discard", A], defaultExecutor(f))).payload.state, "discarded")
})

test("an unconfirmed default runner result is an explicit failure, never success-shaped output", { skip: process.platform === "win32" ? "Unix executable shim" : false }, async () => {
  const f = await fixture()
  const result = await f.invoke(["create"], {
    contextId: () => A, ...defaultExecutor(f, "process.stdout.write('{}');"),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "runner_failed")
})

test("a verified context lost during runtime preparation never claims successful absence", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  const directory = path.join(f.stateRoot, "private", A)
  const result = await f.invoke(["discard", A], {
    prepareBrowserRuntime: async () => {
      fs.renameSync(directory, path.join(f.root, "retained-context"))
      return f.options.prepareBrowserRuntime()
    },
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "context_absent")
  assert.equal(fs.existsSync(path.join(f.root, "retained-context", ".desk-private-owner")), true)
})

for (const value of [null, true, [], {}, { state: "unknown" }, { state: "absent" }, { state: "discarded" }]) {
  test("default executor rejects an invalid creation envelope " + JSON.stringify(value), { skip: process.platform === "win32" ? "Unix executable shim" : false }, async () => {
    const f = await fixture()
    const result = await f.invoke(["create"], {
      contextId: () => A, ...defaultExecutor(f, "process.stdout.write(" + JSON.stringify(JSON.stringify(value)) + ");"),
    })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "runner_failed")
  })
}
for (const [body, diagnostic] of [
  ["process.stderr.write('owned stderr failure');", "owned stderr failure"],
  ["process.stdout.write('not JSON');", "not JSON"],
  ["", "empty output"],
  ["process.exitCode=7;", "7"],
  ["process.kill(process.pid,'SIGTERM');", "SIGTERM"],
]) {
  test("default executor preserves unconfirmed child diagnostics " + diagnostic, { skip: process.platform === "win32" ? "Unix executable shim" : false }, async () => {
    const f = await fixture()
    const result = await f.invoke(["create"], { contextId: () => A, ...defaultExecutor(f, body || "process.exitCode=0;") })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "runner_failed")
    // nyc's shutdown hook can turn the signal into a clean, empty exit.
    const expected = diagnostic === "SIGTERM" ? /SIGTERM|empty output/ : new RegExp(diagnostic)
    assert.match(result.payload.message, expected)
  })
}
test("default executor preserves an OS-reported termination signal", async t => {
  const f = await fixture()
  t.mock.method(childProcess, "execFile", (_node, _args, _options, callback) => {
    callback({ code: null, signal: "SIGTERM" }, "", "")
  })
  const result = await f.invoke(["create"], { contextId: () => A, execute: undefined })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "runner_failed")
  assert.match(result.payload.message, /SIGTERM/)
})
for (const [payload, stderr, expected] of [
  [{ isError: true, code: "owned_error", message: "owned message" }, "", "owned message"],
  [{ isError: true, error: "owned error" }, "", "owned error"],
  [{ state: "running" }, "owned stderr", "owned stderr"],
  [{ state: "running" }, "", "Upstream command failed"],
]) {
  test("default executor rejects confirmed child failure " + expected, { skip: process.platform === "win32" ? "Unix executable shim" : false }, async () => {
    const f = await fixture()
    const body = "process.stdout.write(" + JSON.stringify(JSON.stringify(payload)) + ");process.stderr.write(" + JSON.stringify(stderr) + ");process.exitCode=1;"
    const result = await f.invoke(["create"], { contextId: () => A, ...defaultExecutor(f, body) })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.message, expected)
    assert.equal(result.payload.code, payload.code || "upstream_failed")
  })
}
test("default executor reports a missing selected executable without losing the resource handle", async () => {
  const f = await fixture()
  const result = await f.invoke(["create"], {
    contextId: () => A, execute: undefined,
    prepareBrowserRuntime: async () => ({ ...await f.options.prepareBrowserRuntime(), nodePath: path.join(f.root, "missing-node") }),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "runner_failed")
  assert.match(result.payload.message, /ENOENT/)
  assert.equal(result.payload.contextId, A)
})
test("injected executor still has to confirm the requested lifecycle state", async () => {
  const f = await fixture()
  for (const result of [null, "running", { isError: true, state: "running" }]) {
    const response = await f.invoke(["create"], { execute: async () => result })
    assert.equal(response.exitCode, 1)
    assert.equal(response.payload.code, "runner_failed")
  }
})
test("argument and generated-ID failures happen before runtime preparation", async () => {
  for (const args of [null, undefined, {}, [1], ["keep"], ["keep", A, "extra"], ["run", A, "--", "type", "\0"]]) {
    const result = await controller().run(args)
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "invalid_arguments")
  }
  for (const id of ["invalid", null,"11111111-1111-4111-8111-111111111111"]) {
    const result = await controller().run(["create"], { contextId: () => id })
    assert.equal(result.payload.code, "invalid_arguments")
  }
})
test("explicit controller CLI and typed private mode preserve the complete legacy lifecycle and optional label",async()=>{
  const f=await fixture(),facade=require(path.join(mcpRoot,"browser-context.cjs"))
  const created=await facade.run(["create","--mode","private"],f.options)
  assert.equal(created.exitCode,0)
  const id=created.payload.contextId
  assert.match(id,/^private-/)
  assert.equal((await facade.run(["keep",id],f.options)).exitCode,0)
  assert.equal((await facade.run(["run",id,"--","snapshot"],f.options)).exitCode,0)
  assert.equal((await facade.context({action:"discard",contextId:id},f.options)).exitCode,0)
  const labeled=await facade.context({action:"create",mode:"private",label:"Private control"},f.options)
  assert.equal(labeled.exitCode,0)
  assert.equal((await facade.command({contextId:labeled.payload.contextId,args:["snapshot"]},f.options)).exitCode,0)
  assert.equal((await facade.context({action:"discard",contextId:labeled.payload.contextId},f.options)).exitCode,0)
})
test("private facade preserves additive structured error resources without replacing legacy ownership resources",async()=>{
  const f=await fixture()
  const resources={disposition:"unknown",remainingTabIds:[7]}
  const response=await f.invoke(["create"],{execute:async()=>{throw Object.assign(Error("Owned typed error"),{code:"owned_error",resources})}})
  assert.equal(response.payload.code,"owned_error")
  assert.deepEqual(response.payload.resources.operation,resources)
  assert.ok(response.payload.resources.contextDirectory.startsWith(f.root))
})
test("private shell entry keeps the sole run export and emits its actual validation result",async t=>{
  const root=await mkTempRoot("desk-private-shell-")
  const result=await exec(process.execPath,[...resourceImports(),entry,"keep"],{
    cwd:root,env:{...process.env,HOME:root,DESK_BROWSER_STATE_DIR:root},
  }).catch(error=>error)
  assert.equal(result.code,1)
  assert.equal(JSON.parse(result.stdout).code,"invalid_arguments")
})
test("runtime preparation errors keep ordinary and non-Error diagnostics visible", async () => {
  const f = await fixture()
  for (const error of [new Error("owned failure"), "owned string failure"]) {
    const result = await f.invoke(["create"], { prepareBrowserRuntime: async () => { throw error } })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "private_browser_failed")
    assert.match(result.payload.message, /owned/)
  }
})
test("private parent creation errors are surfaced rather than treated as existing state", async () => {
  const f = await fixture()
  const file = path.join(f.root, "not-a-directory")
  put(file, "owned fixture")
  const result = await f.invoke(["create"], { prepareBrowserRuntime: async () => ({ ...await f.options.prepareBrowserRuntime(), stateRoot: file }) })
  assert.equal(result.exitCode, 1)
  assert.ok(["ENOTDIR", "ENOENT"].includes(result.payload.code))
})
test("non-ENOENT context inspection errors cannot masquerade as absence", async t => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  const original = fs.lstatSync
  const context = path.join(f.stateRoot, "private", A)
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (file === context) throw Object.assign(Error("owned inspection denied"), { code: "EACCES" })
    return original(file, ...args)
  })
  assert.equal((await f.invoke(["discard", A])).payload.code, "EACCES")
})
test("private control tolerates missing HOME and uses the shared default preparation", async t => {
  const f = await fixture()
  const web = require(path.join(mcpRoot, "web.cjs"))
  t.mock.method(web, "prepareBrowserRuntime", f.options.prepareBrowserRuntime)
  const made = await controller().run(["create"], {
    env: { ...f.options.env, HOME: undefined, USERPROFILE: f.root },
    execute: f.options.execute, socketRoot: f.options.socketRoot, browserExists: () => false,
  })
  assert.equal(made.exitCode, 0)
  for (const home of [{ HOME: undefined, USERPROFILE: f.root }, { HOME: undefined, USERPROFILE: undefined }]) {
    const kept = await f.invoke(["keep", made.payload.contextId], {
      env: { ...f.options.env, ...home }, prepareBrowserRuntime: undefined,
    })
    assert.equal(kept.exitCode, 0)
  }
})
test("default browser existence checks remain private and cover native Windows namespaces", async t => {
  const f = await fixture()
  const web = require(path.join(mcpRoot, "web.cjs"))
  t.mock.method(web, "prepareBrowserRuntime", f.options.prepareBrowserRuntime)
  const made = await controller().run(["create"])
  if (made.payload.resources?.socketDirectory && process.platform !== "win32") {
    console.log("RESOURCE native short namespace " + made.payload.resources.socketDirectory)
    t.after(() => removeTree(made.payload.resources.socketDirectory))
  }
  assert.equal(made.exitCode, 1)
  assert.equal(made.payload.code, "ENOENT")
  const original = fs.statSync
  t.mock.method(fs, "statSync", (file, ...args) => {
    if (/chrome|msedge|Microsoft Edge|Google Chrome/i.test(file)) throw Object.assign(Error("owned browser path absent"), { code: "ENOENT" })
    return original(file, ...args)
  })
  assert.equal((await f.invoke(["create"], { browserExists: undefined })).exitCode, 0)
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  const uid = Object.getOwnPropertyDescriptor(process, "getuid")
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined })
    let environment
    const execute = async (_node, _args, options) => {
      environment = options.env
      return { state: "running" }
    }
    const result = await f.invoke(["create"], { socketRoot: undefined, execute })
    assert.equal(result.exitCode, 0)
    const directory = result.payload.resources.socketDirectory
    console.log("RESOURCE native Windows temp namespace " + directory)
    t.after(() => removeTree(directory))
    assert.equal(path.dirname(directory), os.tmpdir(), "browser profiles must not inherit the deep context path")
    assert.match(path.basename(directory), /^dp-win-[0-9a-f]{16}$/)
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false)
    assert.deepEqual([environment.TMPDIR, environment.TMP, environment.TEMP], [directory, directory, directory])
    assert.equal(environment.LOCALAPPDATA, path.join(environment.USERPROFILE, "AppData", "Local"))
    assert.equal(environment.APPDATA, path.join(environment.USERPROFILE, "AppData", "Roaming"))
    for (const directory of [environment.LOCALAPPDATA, environment.APPDATA]) {
      assert.equal(fs.lstatSync(directory).isDirectory(), true)
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false)
    }
    const owner = JSON.parse(fs.readFileSync(path.join(directory, ".desk-private-owner")))
    assert.equal(owner.contextId, result.payload.contextId)
    assert.equal(owner.directory, result.payload.resources.contextDirectory)
    const kept = await f.invoke(["keep", result.payload.contextId], { socketRoot: undefined, execute })
    assert.equal(kept.exitCode, 0)
    assert.equal(kept.payload.resources.socketDirectory, directory)
  } finally {
    Object.defineProperty(process, "platform", platform)
    if (uid) Object.defineProperty(process, "getuid", uid)
    else Reflect.deleteProperty(process, "getuid")
  }
})
test("private creation uses an installed Edge channel when that is the existing selection", async () => {
  const f = await fixture()
  let executable
  const result = await f.invoke(["create"], {
    env: { ...f.options.env, PROGRAMFILES: "C:\\Program Files" },
    browserExists: file => {
      const found = /Microsoft Edge|msedge/i.test(file)
      if (found) executable = file
      return found
    },
  })
  assert.equal(result.exitCode, 0)
  assert.ok(result.payload.result.args.includes("msedge"))
  const config = JSON.parse(fs.readFileSync(result.payload.resources.configFile))
  assert.equal(config.browser.launchOptions.executablePath, executable)
})

test("Windows shell folders resolve inside the isolated private environment", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture()
  const helper = path.join(f.root, "shell-folders.exe")
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeskPrivateShellFolder {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHGetFolderPath(IntPtr hwnd, int csidl, IntPtr token, int flags, StringBuilder path);
  public static void Main() {
    foreach (int id in new int[] { 28, 26 }) {
      var buffer = new StringBuilder(260);
      int code = SHGetFolderPath(IntPtr.Zero, id, IntPtr.Zero, 0, buffer);
      var unverified = new StringBuilder(260);
      int unverifiedCode = SHGetFolderPath(IntPtr.Zero, id | 0x4000, IntPtr.Zero, 0, unverified);
      Console.WriteLine(id + "\\t" + code + "\\t" + buffer + "\\t" + unverifiedCode + "\\t" + unverified);
    }
  }
}
'@ -OutputAssembly '${helper.replaceAll("'", "''")}' -OutputType ConsoleApplication
`
  await exec(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: f.root, env: process.env, windowsHide: true, timeout: 30000,
  })
  const result = await f.invoke(["create"], { env: { ...process.env, ...f.options.env }, execute: async (_node, _args, options) => {
    const { stdout } = await exec(helper, [], {
      cwd: options.cwd, env: options.env, windowsHide: true, timeout: 15000,
    })
    const folders = stdout.trim().split(/\r?\n/).map(line => {
      const [id, code, folder] = line.split("\t")
      return { id: Number(id), code: Number(code), path: folder }
    })
    assert.deepEqual(folders.map(folder => folder.code), [0, 0], stdout)
    assert.deepEqual(folders.map(folder => path.normalize(folder.path)), [options.env.LOCALAPPDATA, options.env.APPDATA].map(directory => path.normalize(directory)))
    return { state: "running" }
  } })
  assert.equal(result.exitCode, 0, result.payload.message)
})

test("two fresh private creations isolate HOME/cwd/config/session and disable idle timeout", async () => {
  const f = await fixture()
  const a = await f.invoke(["create"])
  const b = await f.invoke(["create"])
  assert.equal(a.exitCode, 0)
  assert.equal(b.exitCode, 0)
  const id = a.payload.contextId
  assert.match(id, /^private-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(id, b.payload.contextId)
  assert.notEqual(a.payload.result.home, b.payload.result.home)
  assert.equal(a.payload.result.cwd, path.join(f.stateRoot, "private", id))
  assert.equal(a.payload.result.home, path.join(f.stateRoot, "private", id, "home"))
  assert.equal(a.payload.result.config, path.join(f.stateRoot, "private", id, "config"))
  assert.ok(a.payload.result.args.includes("--session=" + id))
  assert.ok(a.payload.result.args.includes("--idle-timeout=0"))
  assert.ok(!a.payload.result.args.includes("--persistent"))
  assert.deepEqual(a.payload.result.inherited, [])
  assert.doesNotMatch(a.payload.result.nodeOptions || "", /--not-allowed/)
  if (process.platform !== "win32") assert.equal(fs.statSync(a.payload.result.temp).mode & 0o777, 0o700)
})

test("private environment rejects caller preloads even when the test harness instruments the child", async () => {
  const f = await fixture()
  const instrumentation = path.join(f.root, "instrumentation.cjs")
  put(instrumentation, "process.env.NODE_OPTIONS=(process.env.NODE_OPTIONS||'')+' --require=owned-test-instrumentation';")
  let forwarded
  const result = await f.invoke(["create"], {
    contextId: () => A,
    execute: (node, args, opts) => {
      forwarded = opts.env.NODE_OPTIONS
      return f.options.execute(node, ["--require", instrumentation, ...args], opts)
    },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(forwarded, undefined)
  assert.deepEqual(result.payload.result.inherited, [])
  assert.doesNotMatch(result.payload.result.nodeOptions || "", /--not-allowed/)
})

test("independent keep/resume/run clients reuse the same context and never recreate a missing one", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  for (const verb of ["keep", "resume"]) assert.equal((await f.invoke([verb, A])).payload.state, "running")
  const run = await f.invoke(["run", A, "--", "snapshot"])
  const nextRun = await f.invoke(["run", A, "--", "snapshot"])
  assert.notEqual(run.payload.result.pid, nextRun.payload.result.pid)
  assert.equal(run.payload.result.home, path.join(f.stateRoot, "private", A, "home"))
  assert.ok(run.payload.result.args.includes("--session=" + A))
  f.change(A, { version: "2" })
  assert.equal((await f.invoke(["resume", A])).exitCode, 1)
  f.change(A, { version: "1", running: false })
  assert.equal((await f.invoke(["keep", A])).exitCode, 1)
  assert.equal((await f.invoke(["resume", B])).exitCode, 1)
  assert.equal(fs.existsSync(f.metadata(B)), false)
})

for (const flag of ["-s", "-s=other", "-sother", "--s=other", "--s", "--g", "--session", "--session=other", "--no-session", "-hsg", "-vsother", "-vg", "-g", "-g=true", "--global", "--no-global", "--cdp=x", "--extension", "--endpoint=x", "--persistent", "--profile=x", "--config=x", "--user-data-dir=x", "--browser=chrome", "--idle-timeout=1"]) {
  test("run rejects reserved spelling " + flag + " before preparation", async () => {
    let prepared = false
    const result = await controller().run(["run", A, "--", "snapshot", flag], {
      prepareBrowserRuntime: () => { prepared = true; throw Error("must not prepare") },
    })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "reserved_option")
    assert.equal(prepared, false)
  })
}
test("a genuine inner delimiter preserves literal page data including session-looking strings", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  const result = await f.invoke(["run", A, "--", "type", "--", "--session=" + B])
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.payload.result.args.slice(-3), ["type", "--", "--session=" + B])
})
for (const cmd of ["open", "attach", "close", "close-all", "kill-all", "delete-data", "install", "install-browser", "show", "tray"]) {
  test("run rejects lifecycle/global command " + cmd, async () => {
    assert.equal((await controller().run(["run", A, "--", cmd])).exitCode, 1)
  })
}
test("malformed/unknown IDs and symlink escapes fail without starting a runner", async () => {
  const f = await fixture()
  for (const args of [["resume", "../escape"], ["create", A], ["run", A, "snapshot"], ["discard", B]]) {
    const result = await f.invoke(args)
    assert.equal(result.exitCode, args[0] === "discard" ? 0 : 1)
    if (args[0] === "discard") assert.equal(result.payload.state, "absent")
  }
  fs.mkdirSync(path.join(f.stateRoot, "private"), { recursive: true })
  fs.symlinkSync(f.root, path.join(f.stateRoot, "private", A), "junction")
  assert.equal((await f.invoke(["resume", A])).exitCode, 1)
})

test("discard closes only A and verifies normal-stop metadata absence", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  await f.invoke(["create"], { contextId: () => B })
  assert.equal((await f.invoke(["discard", A])).payload.state, "discarded")
  assert.equal(fs.existsSync(f.metadata(A)), false)
  assert.equal((await f.invoke(["keep", B])).payload.state, "running")
  assert.equal((await f.invoke(["discard", A])).payload.state, "absent")
})
for (const operation of ["keep", "resume", "run", "discard"]) {
  for (const code of ["EMFILE", "EACCES", "ECONNRESET"]) {
    test(operation + " preserves lifecycle metadata and socket on " + code, async () => {
      const f = await fixture()
      assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
      f.change(A, { connectionErrors: [code] })
      const args = operation === "run" ? ["run", A, "--", "snapshot"] : [operation, A]
      const result = await f.invoke(args)
      assert.equal(result.exitCode, 1)
      assert.equal(fs.existsSync(f.metadata(A)), true)
      assert.equal(fs.existsSync(f.metadata(A) + ".unlinks"), false)
    })
  }
}
test("discard does not convert a later connection error into confirmed shutdown", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  f.change(A, { connectionErrors: [null, "EMFILE"] })
  const result = await f.invoke(["discard", A])
  // A single connected stop is safe; a second failed connection is not shutdown proof.
  if (result.exitCode === 0) assert.equal(Number(fs.readFileSync(f.metadata(A) + ".connections")), 1)
  else assert.equal(fs.existsSync(f.metadata(A)), true)
  assert.equal(fs.existsSync(f.metadata(A) + ".unlinks"), false)
})
test("discard requires a stop acknowledgement and retains the record on early close", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  f.change(A, { closeWithoutAck: true })
  const result = await f.invoke(["discard", A])
  assert.equal(result.exitCode, 1)
  assert.equal(fs.existsSync(f.metadata(A)), true)
})
test("discard retains stale metadata when post-ACK absence cannot be determined", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  f.change(A, { stale: true, connectionErrors: [null, "EACCES"] })
  const result = await f.invoke(["discard", A])
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "EACCES")
  assert.equal(fs.existsSync(f.metadata(A)), true)
  assert.equal(fs.existsSync(f.metadata(A) + ".unlinks"), false)
})
test("run uses its live connection rather than racing a second destructive connection", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  f.change(A, { connectionErrors: [null, "EMFILE"] })
  const result = await f.invoke(["run", A, "--", "snapshot"])
  assert.equal(result.exitCode, 0)
  assert.equal(Number(fs.readFileSync(f.metadata(A) + ".connections")), 1)
  assert.equal(fs.existsSync(f.metadata(A) + ".unlinks"), false)
})
test("confirmed stop deletes exact stale metadata but never sweeps ud-* or output", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  f.change(A, { stale: true })
  const output = path.join(path.dirname(f.metadata(A)), "ud-" + A + "-keep", "evidence.png")
  put(output, "evidence")
  assert.equal((await f.invoke(["discard", A])).payload.state, "discarded")
  assert.equal(fs.existsSync(f.metadata(A)), false)
  assert.equal(fs.readFileSync(output, "utf8"), "evidence")
})
for (const fields of [{ stopError: true }, { stillRunning: true }, { stale: true, cleanupError: true }, { probeError: true }]) {
  test("indeterminate cleanup remains visible " + JSON.stringify(fields), async () => {
    const f = await fixture()
    await f.invoke(["create"], { contextId: () => A })
    f.change(A, fields)
    const result = await f.invoke(["discard", A])
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.isError, true)
    assert.equal(fs.existsSync(f.metadata(A)), true)
  })
}
test("startup/JSON/transport errors fail and credential surfaces are redacted", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  for (const text of ["json-error", "transport-error"]) {
    const result = await f.invoke(["run", A, "--", "type", text])
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(JSON.stringify(result), /secret-value|user:password|token=abc/)
  }
  fs.writeFileSync(path.join(f.modules, "program.js"), "exports.program=async()=>{throw Error('startup failure')}")
  const result = await f.invoke(["create"], { contextId: () => B })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.contextId, B)
})
test("unowned socket metadata is rejected before upstream liveness can unlink it", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  f.change(A, { socketPath: "/unowned/foreign.sock" })
  assert.equal((await f.invoke(["keep", A])).exitCode, 1)
  assert.equal((await f.invoke(["discard", A])).exitCode, 1)
})
test("unsupported CLI module fails explicitly without private startup", async () => {
  const f = await fixture()
  fs.renameSync(path.join(f.modules, "program.js"), path.join(f.modules, "unsupported.js"))
  const result = await f.invoke(["create"], { contextId: () => A })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "unsupported_cli")
  assert.equal(fs.existsSync(f.metadata(A)), false)
})

test("native Unix short namespace is owner-private, deterministic, and below 103 bytes without PWTEST", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  let request
  const result = await f.invoke(["create"], { contextId: () => A, socketRoot: undefined, execute: async (node, args, opts) => {
    request = JSON.parse(args[1])
    assert.equal(opts.env.PWTEST_SOCKETS_DIR, undefined)
    return { state: "running" }
  } })
  assert.equal(result.exitCode, 0)
  const dir = result.payload.resources.socketDirectory
  console.log("RESOURCE native short namespace " + dir)
  t.after(() => removeTree(dir))
  assert.equal(fs.lstatSync(dir).isSymbolicLink(), false)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.ok(Buffer.byteLength(path.join(dir, "pw-12345678", "cli", "1234567890123456.sock")) <= 103)
  assert.equal(request.socketDir, dir)
  const kept = await f.invoke(["keep", A], { socketRoot: undefined, execute: async (node, args) => {
    assert.equal(JSON.parse(args[1]).socketDir, dir)
    return { state: "running" }
  } })
  assert.equal(kept.exitCode, 0)
})

test("unknown valid ID fails before preparing or starting a runtime", async () => {
  const f = await fixture()
  let prepared = false
  const result = await f.invoke(["keep", A], { prepareBrowserRuntime: () => { prepared = true; throw Error("unexpected preparation") } })
  assert.equal(result.payload.code, "context_absent")
  assert.equal(prepared, false)
})

test("normal page output preserves safe URLs while redacting nested credentials", async () => {
  const f = await fixture()
  const result = await f.invoke(["create"], { contextId: () => A, execute: async () => ({
    state: "running", result: { url: "https://example.test/page", Authorization: "Bearer secret-value",
      nested: { password: "hidden", connect: "https://user:pass@example.test/connect?token=abc" } },
  }) })
  assert.equal(result.exitCode, 0)
  assert.equal(result.payload.result.url, "https://example.test/page")
  assert.doesNotMatch(JSON.stringify(result), /hidden|secret-value|user:pass|token=abc/)
})

test("creation reports exact owned resources even when startup fails", async () => {
  const f = await fixture()
  fs.writeFileSync(path.join(f.modules, "program.js"), "exports.program=async()=>{throw Error('startup failure')}")
  const result = await f.invoke(["create"], { contextId: () => A })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.resources.contextDirectory, path.join(f.stateRoot, "private", A))
  assert.ok(fs.existsSync(result.payload.resources.socketDirectory))
})

test("symlinked registry parents fail before the maintained registry reads them", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  const home = path.join(f.stateRoot, "private", A, "home")
  fs.renameSync(path.join(home, "registry"), path.join(f.root, "foreign-registry"))
  fs.symlinkSync(path.join(f.root, "foreign-registry"), path.join(home, "registry"), "junction")
  assert.equal((await f.invoke(["keep", A])).payload.code, "unsafe_registry")
})

test("inherited PLAYWRIGHT_CLI_SESSION never selects another context", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  const result = await f.invoke(["run", A, "--", "snapshot"])
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.payload.result.inherited, [])
  assert.equal(result.payload.result.args.filter(a => a.startsWith("--session=")).join(), "--session=" + A)
})

for (const fields of [{ browser: { userDataDir: "/foreign/profile" } }, { cli: { persistent: true } }, { attached: true }]) {
  test("foreign profile/connection metadata fails before liveness " + JSON.stringify(fields), async () => {
    const f = await fixture()
    assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
    f.change(A, fields)
    assert.equal((await f.invoke(["keep", A])).payload.code, "unsafe_registry")
    assert.equal((await f.invoke(["discard", A])).payload.code, "unsafe_registry")
  })
}

test("ownership marker replacement cannot be resumed", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  const marker = path.join(f.stateRoot, "private", A, ".desk-private-owner")
  fs.writeFileSync(marker, "another owner")
  assert.equal((await f.invoke(["resume", A])).payload.code, "unsafe_path")
})

test("malformed but present metadata is an outstanding cleanup failure, not absent", async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  fs.writeFileSync(f.metadata(A), "{broken")
  const result = await f.invoke(["discard", A])
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "session_metadata_invalid")
  assert.equal(fs.readFileSync(f.metadata(A), "utf8"), "{broken")
})

test("symlinked exact metadata is rejected before a registry read", { skip: process.platform === "win32" ? "file symlinks require host privilege" : false }, async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  fs.renameSync(f.metadata(A), path.join(f.root, "foreign.session"))
  fs.symlinkSync(path.join(f.root, "foreign.session"), f.metadata(A))
  fs.appendFileSync(path.join(f.modules, "registry.js"), "\nexports.Registry.load=async()=>{throw Error('unsafe registry read happened')};")
  assert.equal((await f.invoke(["discard", A])).payload.code, "unsafe_registry")
})

test("a symlinked private parent cannot masquerade as an absent context", async () => {
  const f = await fixture()
  fs.symlinkSync(f.root, path.join(f.stateRoot, "private"), "junction")
  assert.equal((await f.invoke(["discard", A])).payload.code, "unsafe_path")
})

test("metadata cannot redirect the unlinking liveness helper at an ownership marker", async () => {
  const f = await fixture()
  const created = await f.invoke(["create"], { contextId: () => A })
  assert.equal(created.exitCode, 0)
  const marker = path.join(created.payload.resources.socketDirectory, ".desk-private-owner")
  f.change(A, { socketPath: marker })
  assert.equal((await f.invoke(["discard", A])).payload.code, "unsafe_registry")
  assert.equal(fs.existsSync(marker), true)
})

test("discard leaves a visible cleanup obligation if a stopped session leaves its socket", { skip: process.platform === "win32" }, async () => {
  const f = await fixture()
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  f.change(A, { leaveSocket: true })
  const result = await f.invoke(["discard", A])
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "cleanup_unconfirmed")
})

test("private creation uses an owned in-memory config rather than an inherited config", async () => {
  const f = await fixture()
  const result = await f.invoke(["create"], { contextId: () => A })
  assert.equal(result.exitCode, 0)
  const configFile = path.join(f.stateRoot, "private", A, "config", "browser.json")
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { browser: { isolated: true, launchOptions: { headless: true } } })
  assert.ok(result.payload.result.args.includes("--config=" + configFile))
  if (process.platform !== "win32") assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
})

test("existing user-only Chrome executable selection is carried through owned config", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture()
  const executable = "/forbidden/operator/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const result = await f.invoke(["create"], { contextId: () => A, browserExists: file => file === executable })
  assert.equal(result.exitCode, 0)
  const config = JSON.parse(fs.readFileSync(path.join(f.stateRoot, "private", A, "config", "browser.json")))
  assert.equal(config.browser.launchOptions.executablePath, executable)
  assert.ok(!result.payload.result.args.includes("--executable-path"))
})

for (const [file, source] of [
  ["registry.js", "exports.createClientInfo=undefined;"],
  ["registry.js", "exports.Registry=undefined;"],
  ["registry.js", "exports.Registry.load=undefined;"],
  ["session.js", "exports.Session=undefined;"],
  ["program.js", "exports.program=undefined;"],
  ["../utils/socketConnection.js", "exports.SocketConnection=undefined;"],
]) {
  test("runtime rejects unsupported CLI exports " + file + " " + source, async () => {
    const f = await fixture()
    fs.appendFileSync(path.join(f.modules, file), "\n" + source)
    const result = await f.invoke(["create"], { contextId: () => A })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "unsupported_cli")
  })
}
test("runtime creation refuses an existing session and never restarts it", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  const result = await f.invoke(["keep", A], {
    execute: (node, args, opts) => {
      const request = { ...JSON.parse(args[1]), operation: "create" }
      return f.options.execute(node, [args[0], JSON.stringify(request)], opts)
    },
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "context_exists")
  assert.equal(fs.existsSync(f.metadata(A)), true)
})
test("runtime startup handles absent optional browser arguments without inheriting a session", async () => {
  const f = await fixture()
  const result = await f.invoke(["create"], {
    contextId: () => A,
    execute: (node, args, opts) => {
      const request = { ...JSON.parse(args[1]), browserArgs: undefined }
      return f.options.execute(node, [args[0], JSON.stringify(request)], opts)
    },
  })
  assert.equal(result.exitCode, 0)
  assert.ok(result.payload.result.args.includes("--session=" + A))
})
test("runtime validates exact registry paths even without the optional registry enumeration export", async () => {
  const f = await fixture()
  fs.appendFileSync(path.join(f.modules, "registry.js"), "\nexports.baseDaemonDir=undefined;")
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  assert.equal((await f.invoke(["keep", A])).exitCode, 0)
})
for (const source of [
  "exports.program=async()=>{console.log('owned startup error');process.exitCode=1;};",
  "exports.program=async()=>{console.log(JSON.stringify({isError:true,error:'owned JSON error'}));};",
  "exports.program=async()=>{console.log(JSON.stringify({isError:true}));};",
]) {
  test("runtime preserves explicit upstream startup failure " + source, async () => {
    const f = await fixture()
    put(path.join(f.modules, "program.js"), source)
    const result = await f.invoke(["create"], { contextId: () => A })
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "upstream_failed")
  })
}
test("runtime never claims running when startup produced no session metadata", async () => {
  const f = await fixture()
  put(path.join(f.modules, "program.js"), "exports.program=async()=>{console.log('null')};")
  const result = await f.invoke(["create"], { contextId: () => A })
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "context_absent")
})
for (const operation of ["connection", "reply"]) {
  test("runtime " + operation + " timeout is an explicit retained cleanup obligation", async () => {
    const f = await fixture()
    await f.invoke(["create"], { contextId: () => A })
    f.control({ fastTimers: true, connectHang: operation === "connection" })
    if (operation === "reply") f.change(A, { noReply: true })
    const result = await f.invoke([operation === "reply" ? "discard" : "keep", A])
    assert.equal(result.exitCode, 1)
    assert.equal(result.payload.code, "session_unreachable")
    assert.equal(fs.existsSync(f.metadata(A)), true)
  })
}
test("runtime rejects a mismatched RPC response rather than accepting another command's result", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  f.change(A, { responseId: 2, stale: true })
  const result = await f.invoke(["discard", A])
  assert.equal(result.exitCode, 1)
  assert.match(result.payload.message, /Unexpected/)
  assert.equal(fs.existsSync(f.metadata(A)), true)
})
test("runtime requires the affirmative stop acknowledgement before stale metadata deletion", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  f.change(A, { stopAck: "not stopped", stale: true })
  const result = await f.invoke(["discard", A])
  assert.equal(result.exitCode, 1)
  assert.equal(result.payload.code, "cleanup_unconfirmed")
  assert.equal(fs.existsSync(f.metadata(A)), true)
})
test("runtime preserves ordinary text results and explicit tool errors", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  f.change(A, { runResponse: { text: "owned text result" } })
  assert.equal((await f.invoke(["run", A, "--", "snapshot"])).payload.result, "owned text result")
  f.change(A, { runResponse: { isError: true, text: "" } })
  const error = await f.invoke(["run", A, "--", "snapshot"])
  assert.equal(error.exitCode, 1)
  assert.equal(error.payload.code, "upstream_failed")
  assert.equal(error.payload.message, "Upstream command failed")
})
test("runtime uses maintained raw-command metadata and closes a failed parser connection", async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  put(path.join(f.modules, "help.json"), JSON.stringify({ booleanOptions: [], commands: { snapshot: { raw: true } } }))
  const result = await f.invoke(["run", A, "--", "snapshot"])
  assert.equal(result.exitCode, 0)
  assert.equal(result.payload.result.raw, true)
  put(path.join(f.modules, "minimist.js"), "exports.minimist=()=>{throw Error('owned parser error')};")
  const failed = await f.invoke(["run", A, "--", "snapshot"])
  assert.equal(failed.exitCode, 1)
  assert.match(failed.payload.message, /owned parser/)
  assert.equal(fs.existsSync(f.metadata(A)), true)
})
test("runtime validates a real owned Unix socket without unlinking it", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  const made = await f.invoke(["create"], { contextId: () => A, socketRoot: undefined })
  assert.equal(made.exitCode, 0)
  const directory = made.payload.resources.socketDirectory
  console.log("RESOURCE native short namespace " + directory)
  const socket = path.join(directory, "owned.sock")
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve) })
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await removeTree(directory)
  })
  f.change(A, { socketPath: socket })
  assert.equal((await f.invoke(["keep", A], { socketRoot: undefined })).exitCode, 0)
  assert.equal(fs.lstatSync(socket).isSocket(), true)
})
test("runtime rejects a non-socket resource even when its owned filename ends in sock", { skip: process.platform === "win32" }, async () => {
  const f = await fixture()
  await f.invoke(["create"], { contextId: () => A })
  const config = JSON.parse(fs.readFileSync(f.metadata(A)))
  put(config.socketPath, "owned non-socket")
  assert.equal((await f.invoke(["keep", A])).payload.code, "unsafe_registry")
})
test("runtime validates native Windows pipe identity without relying on Unix unlink", async () => {
  const f = await fixture()
  f.control({ platform: "win32" })
  assert.equal((await f.invoke(["create"], { contextId: () => A })).exitCode, 0)
  const valid = JSON.parse(fs.readFileSync(f.metadata(A))).socketPath
  assert.equal((await f.invoke(["keep", A])).exitCode, 0)
  for (const socketPath of [null, "foreign", "\\\\.\\pipe\\pw-foreign"]) {
    f.change(A, { socketPath })
    assert.equal((await f.invoke(["keep", A])).payload.code, "unsafe_registry")
  }
  f.change(A, { socketPath: valid })
  assert.equal((await f.invoke(["discard", A])).payload.state, "discarded")
})
