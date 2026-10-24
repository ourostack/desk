// Actual controller/worker logic with only the maintained CLI, socket and OS
// process-observation boundaries replaced. No browser or authentication data.
import {test} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import {createRequire} from "node:module"
import {mkTempRoot} from "../_temp_roots.js"
import {removeTree} from "../_remove_tree.js"
import {mcpRoot} from "./_mcp_handshake.js"
import {processStartReaders} from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

const require = createRequire(import.meta.url)
const common = require(path.join(mcpRoot,"browser-context-common.cjs"))
const ID = "11111111-1111-4111-8111-111111111111"

async function workerFixture(t) {
  const root = await mkTempRoot("desk-managed-recovery-")
  t.after(()=>removeTree(root))
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
    startError:false,spawnError:false,afterSpawnError:false,replacementAlive:false,replacementPid:123457,launches:0,stopWithoutAck:false,
    connectionErrors:[],socketPaths:[],deletes:0,deleteBlocked:false,onProcessRead:null}
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
  const fakeProcess = {...process,platform:"win32",argv:[],stdout:{write(){}},umask:()=>63,
    kill(pid){if(state.unknown)throw Object.assign(Error("unknown"),{code:"EPERM"})
      if(!(pid===123456?state.generation:pid===state.replacementPid&&state.replacementAlive))throw Object.assign(Error("absent"),{code:"ESRCH"})}}
  const reader = {async readProcessStart(pid){state.processReads++;if(state.onProcessRead)state.onProcessRead();return state.unknown?null:
    pid===123456?state.generation:pid===state.replacementPid&&state.replacementAlive?"fixture:replacement:"+state.launches:null}}
  t.mock.method(processStartReaders,process.platform,reader.readProcessStart)
  class Session {
    isCompatible(){return true}
    async deleteSessionConfig(){
      state.deletes++
      if(state.deleteBlocked)return
      fs.unlinkSync(sessionFile)
      state.entry=null
    }
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
    fakeProcess.stdout.write(JSON.stringify(Object.hasOwn(state,"acknowledgement")?state.acknowledgement:result))
  }
  const module = {exports:{}}
  const {loadTemplate}=require("./fixtures/native-template-loader.cjs")
  loadTemplate(path.join(mcpRoot,"browser-context-runtime.cjs"),{
    module,exports:module.exports,__dirname:mcpRoot,process:fakeProcess,Date:Clock,
    Buffer,Promise,setTimeout:(f)=>setTimeout(f,1),clearTimeout,
    require(name){
      if(name==="fs")return fsBoundary
      if(name==="net")return {createConnection(_path,connected){
        state.socketPaths.push(_path)
        const handlers={}
        const socket={on(event,handler){handlers[event]=handler;return socket},destroy(){}}
        const error=state.connectionErrors.shift()
        queueMicrotask(()=>error?handlers.error(Object.assign(Error("owned socket unavailable"),{code:error})):connected())
        return socket
      }}
      if(name===path.join(root,"cli/registry.js"))return registry
      if(name===path.join(root,"cli/session.js"))return {Session}
      if(name===path.join(root,"cli/program.js"))return {program}
      if(name===path.join(root,"utils/socketConnection.js"))return {SocketConnection:Connection}
      return require(name.startsWith("./")?path.join(mcpRoot,name):name)
    },
  },{execution:"function"})
  const request={contextId:ID,mode:"signed-in",backend:"managed",root,cliDir:path.join(root,"cli"),
    socketDir:root,browserArgs:[]}
  return {root,state,receipt,configFile,sessionFile,installEntry,process:fakeProcess,
    retainDiscard:()=>common.atomicJson(path.join(root,".managed-discard.json"),
      {version:1,contextId:ID,profile:common.profileIdentity(root)}),
    invoke:(operation,overrides={})=>module.exports.main({...request,operation,...overrides})}
}

test("managed recovery honors the OS reader's live generation before discarding",async t=>{
  const f=await workerFixture(t)
  f.retainDiscard()
  f.state.entry=null
  fs.unlinkSync(f.sessionFile)
  t.mock.method(processStartReaders,process.platform,async()=>"fixture:original")
  await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
})

test("MB-2 rejected replacement start retains explicit sign-in provenance and can finish after proven absence",async t=>{
  const f=await workerFixture(t)
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
  const f=await workerFixture(t)
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
  const f=await workerFixture(t)
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

test("MB-2 pending launch with unknown replacement generation cannot be retried or used for normal work",async t=>{
  const f=await workerFixture(t)
  f.state.spawnError=true
  await assert.rejects(f.invoke("finish-sign-in"))
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  await assert.rejects(f.invoke("resume"),{code:"sign_in_incomplete"})
  assert.equal(f.state.starts,1)
})

test("MB-2 known replacement exit permits only explicit completion after fresh absence proof",async t=>{
  const f=await workerFixture(t)
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
  test("MB-2 incomplete handoff fails closed on "+change,async t=>{
    const f=await workerFixture(t)
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

test("MB-1 missing session metadata after lost stop acknowledgement still proves the exact daemon exited",async t=>{
  const f=await workerFixture(t)
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
  test("MB-1 metadata absence fails closed with "+condition,async t=>{
    const f=await workerFixture(t)
    f.state.entry=null
    fs.unlinkSync(f.sessionFile)
    if(condition==="same-generation-live")f.state.generation="fixture:original"
    else f.state.unknown=true
    await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
    assert.ok(f.state.receiptReads>0)
  })
}

for(const code of ["ENOENT","ECONNREFUSED"]){
  test("managed discard reconciles stale metadata after exact daemon exit and "+code,async t=>{
    const f=await workerFixture(t)
    f.retainDiscard()
    f.state.connectionErrors.push(code)
    assert.equal((await f.invoke("discard")).state,"discarded")
    assert.equal(fs.existsSync(f.sessionFile),false)
    assert.ok(f.state.processReads>0)
    assert.ok(f.state.receiptReads>0)
    assert.equal(f.state.deletes,1)
    assert.equal(f.state.stops,0)
    assert.equal(f.state.starts,0)
  })
}

for(const condition of ["same-generation-live","unknown-liveness","invalid-receipt","profile-in-use","changed-session"]){
  test("stale managed metadata is retained when "+condition,async t=>{
    const f=await workerFixture(t)
    f.retainDiscard()
    f.state.connectionErrors.push("ECONNREFUSED")
    if(condition==="same-generation-live")f.state.generation="fixture:original"
    else if(condition==="unknown-liveness")f.state.unknown=true
    else if(condition==="invalid-receipt")fs.writeFileSync(f.receipt,JSON.stringify({version:0,contextId:ID}))
    else if(condition==="profile-in-use")fs.writeFileSync(path.join(f.root,"profile/SingletonLock"),"owned active fixture")
    else f.state.onProcessRead=()=>fs.appendFileSync(f.sessionFile," ")
    await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
    assert.equal(fs.existsSync(f.sessionFile),true)
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
    assert.equal(f.state.deletes,0)
    assert.equal(f.state.starts,0)
  })
}

test("stale managed metadata cleanup can retry a failed metadata removal without replaying stop",async t=>{
  const f=await workerFixture(t)
  f.retainDiscard()
  f.state.connectionErrors.push("ECONNREFUSED")
  f.state.deleteBlocked=true
  await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
  assert.equal(fs.existsSync(f.sessionFile),true)
  f.state.deleteBlocked=false
  f.state.connectionErrors.push("ECONNREFUSED")
  assert.equal((await f.invoke("discard")).state,"discarded")
  assert.equal(f.state.deletes,2)
  assert.equal(f.state.stops,0)
})

for(const code of ["EACCES","ETIMEDOUT"]){
  test("managed discard preserves metadata after ambiguous socket failure "+code,async t=>{
    const f=await workerFixture(t)
    f.retainDiscard()
    f.state.connectionErrors.push(code)
    await assert.rejects(f.invoke("discard"),{code})
    assert.equal(fs.existsSync(f.sessionFile),true)
    assert.equal(f.state.deletes,0)
    assert.equal(f.state.receiptReads,0)
  })
}

test("explicit sign-in handoff reconciles stale original metadata before starting its replacement",async t=>{
  const f=await workerFixture(t)
  f.state.connectionErrors.push("ECONNREFUSED")
  assert.equal((await f.invoke("finish-sign-in")).state,"running")
  assert.equal(f.state.deletes,1)
  assert.equal(f.state.stops,0)
  assert.equal(f.state.starts,1)
})

function retainHandoff(f,phase,overrides={}){
  const original={version:1,contextId:ID,pid:123456,started:"fixture:original"}
  common.atomicJson(path.join(f.root,".managed-sign-in-handoff.json"),{version:1,contextId:ID,phase,
    profile:common.profileIdentity(f.root),originalDaemon:original,
    ...(phase==="starting"?{launchPreviousDaemon:original}:{}),...overrides})
  return original
}

test("managed session validation rejects changed launch bindings before connection",async t=>{
  const f=await workerFixture(t)
  f.state.entry.config.browser.launchOptions.headless=true
  fs.writeFileSync(f.sessionFile,JSON.stringify(f.state.entry.config),{mode:0o600})
  await assert.rejects(f.invoke("resume"),{code:"unsafe_registry"})
  assert.equal(f.state.socketPaths.length,0)
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
})

for(const acknowledgement of [null,{pid:999999}]){
  test("replacement acknowledgement "+JSON.stringify(acknowledgement)+" cannot replace the retained daemon identity",async t=>{
    const f=await workerFixture(t)
    f.state.acknowledgement=acknowledgement
    await assert.rejects(f.invoke("finish-sign-in"),{code:"startup_unconfirmed"})
    assert.equal(f.state.starts,1)
    assert.equal((await f.invoke("finish-sign-in")).state,"running")
    assert.equal(f.state.starts,1,"explicit reconciliation must not start another browser")
  })
}

test("discard cannot erase a profile after an unconfirmed replacement launch",async t=>{
  const f=await workerFixture(t)
  f.state.spawnError=true
  await assert.rejects(f.invoke("finish-sign-in"))
  await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
  assert.equal(f.state.starts,1)
})

for(const receipt of ["absent","missing-profile"]){
  test("stale metadata requires retained cleanup identity when receipt is "+receipt,async t=>{
    const f=await workerFixture(t)
    if(receipt==="missing-profile")
      common.atomicJson(path.join(f.root,".managed-discard.json"),{version:1,contextId:ID})
    f.state.connectionErrors.push("ECONNREFUSED")
    await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
    assert.equal(fs.existsSync(f.sessionFile),true)
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
  })
}

test("an existing Unix socket remains a cleanup obligation after daemon exit",
  {skip:process.platform==="win32"},async t=>{
    const f=await workerFixture(t),original=path.join(f.root,"open.sock"),stale=path.join(f.root,"stale.sock")
    const server=net.createServer()
    t.after(()=>server.listening?new Promise(resolve=>server.close(resolve)):undefined)
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(original,resolve)})
    fs.renameSync(original,stale)
    await new Promise(resolve=>server.close(resolve))
    f.process.platform=process.platform
    f.state.entry.config.socketPath=stale
    fs.writeFileSync(f.sessionFile,JSON.stringify(f.state.entry.config),{mode:0o600})
    f.retainDiscard()
    f.state.connectionErrors.push("ECONNREFUSED")
    await assert.rejects(f.invoke("discard"),{code:"cleanup_unconfirmed"})
    assert.deepEqual(f.state.socketPaths,[stale])
    assert.equal(fs.lstatSync(stale).isSocket(),true)
    assert.equal(fs.existsSync(f.sessionFile),true)
  })

test("sign-in completion requires the original interactive daemon receipt",async t=>{
  const f=await workerFixture(t)
  fs.unlinkSync(f.receipt)
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  assert.equal(fs.existsSync(f.sessionFile),true)
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
  assert.equal(f.state.starts,0)
})

test("an unknown handoff phase is refused without a replacement start",async t=>{
  const f=await workerFixture(t)
  retainHandoff(f,"unknown")
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  assert.equal(f.state.starts,0)
  assert.equal(fs.existsSync(f.sessionFile),true)
})

for(const archived of ["original","different"]){
  test("sign-in archival preserves a retained "+archived+" daemon receipt",async t=>{
    const f=await workerFixture(t),file=path.join(f.root,".managed-sign-in-daemon.json")
    const value={version:1,contextId:ID,pid:archived==="original"?123456:654321,started:"fixture:original"}
    common.atomicJson(file,value)
    if(archived==="different")await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
    else assert.equal((await f.invoke("finish-sign-in")).state,"running")
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),value)
    assert.equal(f.state.starts,archived==="original"?1:0)
  })
}

test("a ready handoff never overwrites an unexpected remaining session",async t=>{
  const f=await workerFixture(t)
  retainHandoff(f,"ready")
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  assert.equal(fs.existsSync(f.sessionFile),true)
  assert.equal(f.state.starts,0)
})

for(const condition of ["invalid-pid","missing-start","unknown-generation"]){
  test("starting handoff preserves the profile with "+condition,async t=>{
    const f=await workerFixture(t)
    retainHandoff(f,"starting")
    common.atomicJson(f.receipt,{version:1,contextId:ID,pid:condition==="invalid-pid"?0:123457,
      started:condition==="missing-start"?"":"fixture:replacement:1"})
    await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
    assert.equal(f.state.starts,0)
  })
}

for(const acknowledgement of [null,{pid:0}]){
  test("fresh creation retains the context after invalid daemon acknowledgement "+JSON.stringify(acknowledgement),async t=>{
    const f=await workerFixture(t)
    f.state.entry=null
    fs.unlinkSync(f.sessionFile)
    fs.unlinkSync(f.receipt)
    f.state.acknowledgement=acknowledgement
    await assert.rejects(f.invoke("create"),{code:"startup_unconfirmed"})
    assert.equal(fs.existsSync(f.receipt),false)
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
  })
}

test("fresh creation refuses to attest an unobservable daemon generation",async t=>{
  const f=await workerFixture(t)
  f.state.entry=null
  fs.unlinkSync(f.sessionFile)
  fs.unlinkSync(f.receipt)
  f.state.unknown=true
  await assert.rejects(f.invoke("create"),{code:"startup_unconfirmed"})
  assert.equal(fs.existsSync(f.receipt),false)
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
})

test("replacement publication cannot overwrite a daemon receipt changed during launch",async t=>{
  const f=await workerFixture(t)
  f.state.onProcessRead=()=>{
    if(f.state.replacementAlive)
      fs.writeFileSync(f.receipt,JSON.stringify({version:1,contextId:ID,pid:999999,started:"fixture:changed"}))
  }
  await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).pid,999999)
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
})

test("a reused PID proves only the original daemon exited and is never treated as its live generation",async t=>{
  const f=await workerFixture(t)
  f.retainDiscard()
  f.state.generation="fixture:unrelated-new-generation"
  f.state.connectionErrors.push("ECONNREFUSED")
  assert.equal((await f.invoke("discard")).state,"discarded")
  assert.equal(fs.existsSync(f.sessionFile),false)
  assert.equal(f.state.starts,0)
})

test("an inspection error without a code remains unknown rather than daemon absence",async t=>{
  const f=await workerFixture(t)
  f.state.entry=null
  fs.unlinkSync(f.sessionFile)
  f.state.unknown=true
  t.mock.method(f.process,"kill",()=>{throw Error("OS observation failed")})
  await assert.rejects(f.invoke("discard"),error=>
    error.code==="cleanup_unconfirmed"&&error.resources.daemonDisposition==="unknown"&&
    error.resources.inspectionCode==="unavailable")
  assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
})

test("unknown backend bindings refuse before maintained modules execute",async t=>{
  const f=await workerFixture(t)
  await assert.rejects(f.invoke("resume",{backend:"foreign"}),{code:"invalid_arguments"})
  await assert.rejects(f.invoke("resume",{mode:"private",contextId:"private-"+ID}),{code:"invalid_arguments"})
  assert.equal(f.state.socketPaths.length,0)
  assert.equal(f.state.starts,0)
})

for(const condition of ["lost-acknowledgement","same-daemon-live","unknown-inspection"]){
  test("sign-in completion cannot advance after "+condition+" during shutdown",async t=>{
    const f=await workerFixture(t)
    if(condition==="lost-acknowledgement")f.state.stopWithoutAck=true
    else if(condition==="same-daemon-live")f.state.generation="fixture:original"
    else f.state.unknown=true
    await assert.rejects(f.invoke("finish-sign-in"),{code:"cleanup_unconfirmed"})
    assert.equal(fs.existsSync(path.join(f.root,"profile")),true)
    assert.equal(JSON.parse(fs.readFileSync(f.configFile)).browser.launchOptions.headless,false)
    assert.equal(f.state.starts,0)
    assert.equal(common.readManagedState(f.root,".managed-sign-in-handoff.json",ID).phase,"stopping")
  })
}
