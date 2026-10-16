// These fixtures implement only the maintained CLI boundary, never a browser.
// Removing isolation, validation, liveness or cleanup verification must break these tests.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import { removeTree } from "../_remove_tree.js"

const require = createRequire(import.meta.url)
const entry = path.join(mcpRoot, "browser-private.cjs")
const A = "private-11111111-1111-4111-8111-111111111111"
const B = "private-22222222-2222-4222-8222-222222222222"
const exec = promisify(execFile)
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
exports.createClientInfo = () => ({ version:"1", workspaceDir:process.cwd(), daemonProfilesDir:path.join(process.env.HOME,"registry") });
exports.baseDaemonDir = () => path.join(process.env.HOME,"registry");
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
const transport=require(${JSON.stringify(path.join(modules, "fixtureTransport.js"))});
require("net").createConnection=(socketPath,connected)=>{
  const socket=new EventEmitter();
  socket.destroy=()=>{socket.destroyed=true;queueMicrotask(()=>socket.emit("close"));};
  socket.write=(text,callback)=>{
    const message=JSON.parse(text);
    const dir=path.join(process.env.HOME,"registry");
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
      queueMicrotask(()=>socket.emit("data",Buffer.from(JSON.stringify({id:message.id,result:"ok"})+"\\n")));
    } else {
      const args=message.params.args._;
      if(args.includes("transport-error")) {queueMicrotask(()=>socket.emit("error",Object.assign(Error("https://user:password@example.test/?token=abc"),{code:"ECONNRESET"})));return;}
      const result=args.includes("json-error")?{isError:true,text:"upstream command failed"}:{text:JSON.stringify({args:["--session="+config.name,"--json",...args],home:process.env.HOME,cwd:process.cwd(),pid:process.pid,inherited:[]})};
      queueMicrotask(()=>socket.emit("data",Buffer.from(JSON.stringify({id:message.id,result})+"\\n")));
    }
  };
  queueMicrotask(()=>{
    try {
      const dir=path.join(process.env.HOME,"registry");
      const file=fs.readdirSync(dir).filter(n=>n.endsWith(".session")).map(n=>path.join(dir,n)).find(f=>JSON.parse(fs.readFileSync(f)).socketPath===socketPath);
      if(!file || !transport.connect(file)) throw Object.assign(Error("fixture absent"),{code:"ENOENT"});
      connected();
    } catch(error) { socket.emit("error",error);socket.destroy(); }
  });
  return socket;
};
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
  put(path.join(modules, "help.json"), JSON.stringify({ booleanOptions: [], commands: {} }))
  put(path.join(modules, "program.js"), `
const fs=require("fs"),path=require("path"),r=require("./registry");
exports.program=async () => {
  const args=process.argv.slice(2), id=args.find(a=>a.startsWith("--session=")).slice(10);
  const c=r.createClientInfo(), file=path.join(c.daemonProfilesDir,id+".session");
  if(args.includes("open")) {
    const slash=String.fromCharCode(92),pipe=slash+slash+"."+slash+"pipe"+slash+"pw-test-cli-"+id;
    fs.mkdirSync(c.daemonProfilesDir,{recursive:true});
    fs.writeFileSync(file,JSON.stringify({ name:id,version:"1",workspaceDir:process.cwd(),
      socketPath:process.platform==="win32"?pipe:path.join(process.env.TMPDIR,"pw-test","cli","test.sock"),cli:{},browser:{browserName:"chromium",launchOptions:{}},running:true }));
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
      const result = await exec(node, ["--require", preload, ...args], { cwd: opts.cwd, env: opts.env })
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
  return { root, stateRoot, options, invoke, metadata, change, modules }
}

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
