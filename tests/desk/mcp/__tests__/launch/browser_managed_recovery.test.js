// Actual controller/worker logic with only the maintained CLI, socket and OS
// process-observation boundaries replaced. No browser or authentication data.
import {test} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import {createRequire} from "node:module"
import {mkTempRoot} from "../_temp_roots.js"
import {mcpRoot} from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const common = require(path.join(mcpRoot,"browser-context-common.cjs"))
const ID = "11111111-1111-4111-8111-111111111111"

async function workerFixture() {
  const root = await mkTempRoot("desk-managed-recovery-")
  console.log("RESOURCE managed recovery fixture "+root)
  fs.chmodSync(root,0o700)
  for (const name of ["profile","config","registry"]) fs.mkdirSync(path.join(root,name),{mode:0o700})
  common.marker(root,JSON.stringify({contextId:ID,directory:root,backend:"managed"}),true,".desk-context-owner")
  const config = {browser:{browserName:"chromium",isolated:false,userDataDir:path.join(root,"profile"),
    launchOptions:{headless:false,chromiumSandbox:true,executablePath:"/fixture/edge",channel:"msedge"}}}
  const configFile = path.join(root,"config/browser.json")
  fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600})
  const receipt = path.join(root,".managed-daemon.json")
  fs.writeFileSync(receipt,JSON.stringify({version:1,contextId:ID,pid:123456,started:"fixture:original"}),{mode:0o600})
  const sessionFile = path.join(root,"registry",ID+".session")
  const state = {entry:null,receiptReads:0,starts:0,stops:0,processReads:0,generation:null,unknown:false,
    startError:false,spawnError:false,afterSpawnError:false,replacementAlive:false,replacementPid:123457,launches:0,stopWithoutAck:false}
  const info = {daemonProfilesDir:path.dirname(sessionFile)}
  function installEntry() {
    const browser = JSON.parse(fs.readFileSync(configFile)).browser
    state.entry = {file:sessionFile,daemonDir:info.daemonProfilesDir,
      config:{name:ID,workspaceDir:root,browser,cli:{persistent:true},socketPath:"\\\\.\\pipe\\pw-"+ID}}
    fs.writeFileSync(sessionFile,JSON.stringify(state.entry.config),{mode:0o600})
  }
  installEntry()
  const fsBoundary = Object.create(fs)
  fsBoundary.readFileSync = (file,...args) => {
    if(file===receipt)state.receiptReads++
    return fs.readFileSync(file,...args)
  }
  let tick=0
  class Clock extends Date { static now(){return tick+=10000} }
  const fakeProcess = {...process,platform:"win32",argv:[],stdout:{write(){}},
    kill(pid){if(state.unknown)throw Object.assign(Error("unknown"),{code:"EPERM"})
      if(!(pid===123456?state.generation:pid===state.replacementPid&&state.replacementAlive))throw Object.assign(Error("absent"),{code:"ESRCH"})}}
  const reader = {async readProcessStart(pid){state.processReads++;return state.unknown?null:
    pid===123456?state.generation:pid===state.replacementPid&&state.replacementAlive?"fixture:replacement:"+state.launches:null}}
  class Session {
    isCompatible(){return true}
    static async startDaemon(){
      if(state.spawnError)throw Error("unknown replacement launch")
      state.replacementAlive=true
      state.replacementPid=123456+(++state.launches)
      return {pid:state.replacementPid}
    }
  }
  class Connection {
    constructor(socket){this.socket=socket}
    close(){this.socket.destroy()}
    async send(message){
      assert.equal(message.method,"stop")
      state.stops++
      state.replacementAlive=false
      state.entry=null
      fs.unlinkSync(sessionFile)
      queueMicrotask(()=>state.stopWithoutAck?this.onclose():this.onmessage({id:1,result:"ok"}))
    }
  }
  const registry = {createClientInfo:()=>info,baseDaemonDir:()=>info.daemonProfilesDir,
    Registry:{load:async()=>({entry:()=>state.entry})}}
  const program = async()=>{
    state.starts++
    if(state.startError)throw Error("replacement rejected")
    const result=await Session.startDaemon()
    if(state.afterSpawnError){state.replacementAlive=false;throw Error("replacement exited")}
    installEntry()
    fakeProcess.stdout.write(JSON.stringify(result))
  }
  const source = fs.readFileSync(path.join(mcpRoot,"browser-context-runtime.cjs"),"utf8")
  const needle = 'return import(require("url").pathToFileURL(path.join(__dirname,"src/readiness/process-start.js")).href);'
  assert.equal(source.split(needle).length,2,"instrument only the OS observer boundary")
  const module = {exports:{}}
  vm.runInNewContext(source.replace(needle,"return Promise.resolve(testProcessReader);"),{
    module,exports:module.exports,__dirname:mcpRoot,process:fakeProcess,Date:Clock,
    testProcessReader:reader,Buffer,Promise,setTimeout:(f)=>setTimeout(f,1),clearTimeout,
    require(name){
      if(name==="fs")return fsBoundary
      if(name==="net")return {createConnection(_path,connected){
        const socket={on(){},destroy(){}}
        queueMicrotask(connected)
        return socket
      }}
      if(name===path.join(root,"cli/registry.js"))return registry
      if(name===path.join(root,"cli/session.js"))return {Session}
      if(name===path.join(root,"cli/program.js"))return {program}
      if(name===path.join(root,"utils/socketConnection.js"))return {SocketConnection:Connection}
      return require(name.startsWith("./")?path.join(mcpRoot,name):name)
    },
  })
  const request={contextId:ID,mode:"signed-in",backend:"managed",root,cliDir:path.join(root,"cli"),
    socketDir:root,browserArgs:[]}
  return {root,state,receipt,configFile,sessionFile,installEntry,
    invoke:operation=>module.exports.main({...request,operation})}
}

test("MB-2 rejected replacement start retains explicit sign-in provenance and can finish after proven absence",async()=>{
  const f=await workerFixture()
  f.state.startError=true
  await assert.rejects(f.invoke("finish-sign-in"),/replacement rejected/)
  f.state.startError=false
  const result=await f.invoke("finish-sign-in")
  assert.equal(result.state,"running")
  assert.equal(result.result.previousPages,"closed-without-replay")
  assert.equal(f.state.starts,2)
  assert.equal(f.state.stops,1)
})

test("MB-2 config publication failure preserves valid interactive config and a retryable handoff",async t=>{
  const f=await workerFixture()
  const rename=fs.renameSync
  let failed=false
  t.mock.method(fs,"renameSync",(from,to)=>{
    if(to===f.configFile&&!failed){failed=true;throw Object.assign(Error("publish failed"),{code:"EIO"})}
    return rename(from,to)
  })
  await assert.rejects(f.invoke("finish-sign-in"),{code:"EIO"})
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).browser.launchOptions.headless,false)
  assert.equal(f.state.starts,0)
  assert.ok(fs.readdirSync(path.dirname(f.configFile)).some(name=>name.startsWith("browser.json.pending-")))
  assert.equal((await f.invoke("finish-sign-in")).state,"running")
})

test("MB-2 lost completion publication reconciles the live replacement without a second start",async t=>{
  const f=await workerFixture()
  const rename=fs.renameSync
  let failed=false
  t.mock.method(fs,"renameSync",(from,to)=>{
    if(to===path.join(f.root,".managed-sign-in-handoff.json")&&!failed&&
        JSON.parse(fs.readFileSync(from)).phase==="completed"){
      failed=true
      throw Object.assign(Error("completion publication interrupted"),{code:"EIO"})
    }
    return rename(from,to)
  })
  await assert.rejects(f.invoke("finish-sign-in"),{code:"EIO"})
  assert.equal(f.state.starts,1)
  f.state.unknown=true
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  assert.equal(f.state.starts,1)
  f.state.unknown=false
  const result=await f.invoke("finish-sign-in")
  assert.equal(result.state,"running")
  assert.equal(f.state.starts,1,"reconciliation must not replay browser startup")
})

test("MB-2 pending launch with unknown replacement generation cannot be retried or used for normal work",async()=>{
  const f=await workerFixture()
  f.state.spawnError=true
  await assert.rejects(f.invoke("finish-sign-in"))
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  await assert.rejects(f.invoke("resume"),{code:"sign_in_incomplete"})
  assert.equal(f.state.starts,1)
})

test("MB-2 known replacement exit permits only explicit completion after fresh absence proof",async()=>{
  const f=await workerFixture()
  f.state.afterSpawnError=true
  await assert.rejects(f.invoke("finish-sign-in"),/replacement exited/)
  const before=f.state.processReads
  f.state.afterSpawnError=false
  assert.equal((await f.invoke("finish-sign-in")).state,"running")
  assert.ok(f.state.processReads>before)
  assert.equal(f.state.starts,2)
  assert.equal(fs.existsSync(path.join(f.root,".managed-sign-in-daemon.json")),true)
})

for(const change of ["replacement-profile","singleton-lock","unknown-liveness"]){
  test("MB-2 incomplete handoff fails closed on "+change,async()=>{
    const f=await workerFixture()
    f.state.startError=true
    await assert.rejects(f.invoke("finish-sign-in"),/replacement rejected/)
    if(change==="replacement-profile"){
      fs.renameSync(path.join(f.root,"profile"),path.join(f.root,"original-profile"))
      fs.mkdirSync(path.join(f.root,"profile"),{mode:0o700})
    }else if(change==="singleton-lock"){
      fs.writeFileSync(path.join(f.root,"profile/SingletonLock"),"fixture lock")
    }else f.state.unknown=true
    f.state.startError=false
    await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
    assert.equal(f.state.starts,1)
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
  })
}

test("MB-1 missing session metadata after lost stop acknowledgement still proves the exact daemon exited",async()=>{
  const f=await workerFixture()
  f.state.stopWithoutAck=true
  await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
  assert.equal(fs.existsSync(f.sessionFile),false)
  const before=f.state.receiptReads
  const result=await f.invoke("discard")
  assert.equal(result.state,"discarded")
  assert.ok(f.state.receiptReads>before,"metadata absence must consult the retained daemon receipt")
  assert.equal(f.state.stops,1,"retry must reconcile, not replay stop")
})

for(const condition of ["same-generation-live","unknown-liveness"]){
  test("MB-1 metadata absence fails closed with "+condition,async()=>{
    const f=await workerFixture()
    f.state.entry=null
    fs.unlinkSync(f.sessionFile)
    if(condition==="same-generation-live")f.state.generation="fixture:original"
    else f.state.unknown=true
    await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
    assert.ok(f.state.receiptReads>0)
  })
}
