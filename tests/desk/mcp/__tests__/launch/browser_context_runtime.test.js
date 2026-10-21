import {test} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {createRequire} from "node:module"
import os from "node:os"
import vm from "node:vm"
import net from "node:net"
import {EventEmitter} from "node:events"
import childProcess,{execFile} from "node:child_process"
import {promisify} from "node:util"
import {pathToFileURL} from "node:url"
import http from "node:http"
import {createBrowserExtension} from "../../../../../plugins/desk/browser-extension/context-engine.mjs"
import {startNativeProvider} from "../../../../../plugins/desk/mcp/src/browser/native-provider.mjs"
import {createNativeUpdateProof} from "../../../../../plugins/desk/mcp/src/browser/native-update-proof.mjs"
import {NativeCommandTransport} from "../../../../../plugins/desk/mcp/src/browser/native-transport.mjs"
import {readNativeAncestry} from "../../../../../plugins/desk/mcp/src/browser/native-host.mjs"
import {mcpRoot} from "./_mcp_handshake.js"
import {mkTempRoot} from "../_temp_roots.js"
import {removeTree} from "../_remove_tree.js"
import {protectWindowsPaths,assertWindowsAclAvailable} from "../../../../../plugins/desk/mcp/src/factory/windows-acl.js"
const require = createRequire(import.meta.url)
test("fresh worker refuses unknown modes before loading CLI modules", async () => {
  const file = path.join(mcpRoot,"browser-context-runtime.cjs")
  assert.ok(fs.existsSync(file),"shared maintained CLI worker must exist")
  await assert.rejects(require(file).main({mode:"automatic"}),{code:"invalid_arguments"})
})

test("actual maintained daemon options can reach native acquisition using the strict owner config alone", async t => {
  const root = await mkTempRoot("desk-F-profile-route-")
  t.after(()=>removeTree(root))
  const home = path.join(root,"native-home"), info = os.userInfo()
  t.mock.method(os,"userInfo",()=>({...info,homedir:home}))
  const put = (file,value) => {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
    fs.writeFileSync(file,typeof value === "string" ? value : JSON.stringify(value),{mode:0o600})
  }
  const actualCli = require("./fixtures/playwright-native-error-transport.cjs").cliDirectory()
  assert.ok(actualCli,"requires admitted maintained source")
  const input = require("./fixtures/playwright-native-error-transport.cjs").read()
  const lib = path.join(root,"generation/node_modules/playwright-core/lib")
  put(path.join(lib,"coreBundle.js"),fs.readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs",import.meta.url),"utf8")+input.core)
  put(path.join(lib,"tools/cli-client/session.js"),input.sessionSource)
  const patch = require(path.join(mcpRoot,"web-playwright-patch.cjs"))
  const installed = {dir:path.join(root,"generation"),version:"owned-F-route",core:null}
  patch.apply(installed)
  assert.equal(patch.readRevision(installed),4)
  const app = path.join(home,"Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
  put(app,"owned observation fixture, never launched")
  const discovery = require(path.join(mcpRoot,"web-browser-discovery.cjs"))
  const candidates = discovery.browserPaths("msedge",process.platform,process.env)
  const observedFs = Object.create(fs)
  observedFs.existsSync = file => candidates.includes(String(file)) ? process.platform !== "darwin" : fs.existsSync(file)
  observedFs.realpathSync = file => candidates.includes(String(file)) && process.platform !== "darwin" ? app : fs.realpathSync(file)
  const id = "11111111-1111-4111-8111-111111111111"
  const record = {version:1,contextId:id,label:"Route qualification",channel:"msedge",
    userDataDir:path.join(root,"profile"),profileDirName:"Default",nativeReadyFile:path.join(root,"ready.json"),
    extensionId:"a".repeat(32),sourceDigest:"b".repeat(64)}
  const config = {extension:true,browser:{browserName:"chromium",userDataDir:record.userDataDir,
    launchOptions:{channel:"msedge"}},deskNativeContext:record}
  const configFile = path.join(root,"owner/config/browser.json")
  put(configFile,config)
  const {loadTemplate} = require("./fixtures/native-template-loader.cjs")
  const module = {exports:{}}
  const credential = loadTemplate(path.join(lib,"desk-extension-credential.cjs"),{
    module,__dirname:lib,process,Buffer,setTimeout,clearTimeout,
    require:name=>name === "fs" ? observedFs : require(name),
  })
  const core = fs.readFileSync(path.resolve(actualCli,"../../coreBundle.js"),"utf8")
  function region(text,start,end) {
    const at = text.indexOf(start);assert.ok(at>=0)
    return text.slice(at,text.indexOf(end,at))
  }
  const resolver = region(core,"function resolveExtensionOptions(","\nasync function validateBrowserConfig(")
  const browserParam = region(core,"function resolveBrowserParam(","\nfunction configFromCLIOptions(")
  const patched = fs.readFileSync(path.join(lib,"coreBundle.js"),"utf8")
  const browser = region(patched,"async function createBrowser(config,","\nasync function connectToBrowserEndpoint(")
  let acquisitions = 0
  const create = vm.runInNewContext(resolver+"\n"+browserParam+"\n"+browser+"\ncreateBrowser",{
    process:{env:{}},envToString:value=>value,
    require:name=>{assert.equal(name,"./desk-extension-credential.cjs");return credential},
    async createExtensionBrowser(){acquisitions++;throw Object.assign(new Error("owned acquisition checkpoint"),{code:"ACQUISITION_REACHED"})},
  })
  await assert.rejects(create(config,{}, {browser:"msedge",profileDirName:"Default"},{}),{code:"ACQUISITION_REACHED"})
  assert.equal(acquisitions,1)
  let rejected
  try { await create(config,{}, {browser:"msedge",extension:true,persistent:true,config:configFile,idleTimeout:0},{}) }
  catch(error) { rejected = error }
  assert.equal(acquisitions,2,
    "strict native owner config must supply its profile to actual CLI acquisition; observed "+(rejected?.code || "no error"))
})

  // Exercise the actual Registry, persistent metadata producer, C client and E4
  // codec. Only process/Chrome/HTTP/socket resources are virtual. In particular,
  // no positive .session is written by a test-owned metadata implementation.
  function exactRegion(source, begin, end) {
    const first = source.indexOf(begin), last = source.indexOf(end,first)
    assert.ok(first >= 0 && last > first,begin)
    return source.slice(first,last)
  }
  const plain = value => JSON.parse(JSON.stringify(value))
  async function signedWorkerFixture(t, options = {}) {
    const root = await mkTempRoot("desk-F-signed-worker-")
    t.after(()=>removeTree(root))
    const actualCli = require("./fixtures/playwright-native-error-transport.cjs").cliDirectory()
    assert.ok(actualCli,"requires the admitted actual maintained library")
    const input = require("./fixtures/playwright-native-error-transport.cjs").read()
    const home = path.join(root,"native-home"), user = os.userInfo()
    t.mock.method(os,"userInfo",()=>({...user,homedir:home}))
    const put = (file,value) => {
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
      fs.writeFileSync(file,typeof value === "string" ? value : JSON.stringify(value),{mode:0o600})
    }
    const installed = {dir:path.join(root,"generation"),version:"owned-F-component",core:null}
    const lib = path.join(installed.dir,"node_modules/playwright-core/lib")
    const original = fs.readFileSync(path.resolve(actualCli,"../../coreBundle.js"),"utf8")
    put(path.join(lib,"coreBundle.js"),original)
    put(path.join(lib,"tools/cli-client/session.js"),input.sessionSource)
    for(const name of ["registry.js","help.json","minimist.js"])
      put(path.join(lib,"tools/cli-client",name),fs.readFileSync(path.join(actualCli,name),"utf8"))
    put(path.join(lib,"tools/utils/socketConnection.js"),fs.readFileSync(path.resolve(actualCli,"../utils/socketConnection.js"),"utf8"))
    put(path.join(lib,"package.js"),fs.readFileSync(path.resolve(actualCli,"../../package.js"),"utf8"))
    put(path.resolve(lib,"../package.json"),fs.readFileSync(path.resolve(actualCli,"../../../package.json"),"utf8"))
    const patch = require(path.join(mcpRoot,"web-playwright-patch.cjs"))
    patch.apply(installed)
    assert.equal(patch.readRevision(installed),4)
    const app = path.join(home,"Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
    put(app,"owned executable observation only, never started")
    const realStat=fs.statSync
    const systemBrowsers=["msedge","chrome"].flatMap(channel=>require(path.join(mcpRoot,"web-browser-discovery.cjs")).browserPaths(channel,process.platform,process.env))
    const selectedBrowser=require(path.join(mcpRoot,"web-browser-discovery.cjs")).browserPaths("msedge",process.platform,process.env)[0]
    t.mock.method(fs,"statSync",(file,...args)=>{
      if(process.platform!=="darwin" && String(file)===selectedBrowser) return realStat(app,...args)
      if(systemBrowsers.includes(String(file)) && !String(file).startsWith(root+path.sep))
        throw Object.assign(Error("unavailable owned observation"),{code:"ENOENT"})
      return realStat(file,...args)
    })
    const realpath=fs.realpathSync
    t.mock.method(fs,"realpathSync",(file,...args)=>process.platform!=="darwin" && String(file)===selectedBrowser ? realpath(app,...args) : realpath(file,...args))
    const stateRoot = path.join(root,"browser")
    const installedNativeRoot = path.join(stateRoot,"native-owned")
    const common = require(path.join(mcpRoot,"browser-context-common.cjs"))
    const native = require(path.join(mcpRoot,"web-native-messaging.cjs"))
    const id = "11111111-1111-4111-8111-111111111111"
    const l = common.layout(stateRoot,id,"signed-in",options.socketRoot)
    const privateDirectories = [stateRoot,installedNativeRoot,l.parent,l.root,...[".playwright","home","config","cache","data","state","runtime","local","roaming"].map(n=>path.join(l.root,n)),l.socketDir,
      ...(process.platform === "win32" ? ["AppData","AppData/Local","AppData/Roaming"].map(n=>path.join(l.root,"home",n)) : [])]
    for (const d of privateDirectories)
      fs.mkdirSync(d,{recursive:true,mode:0o700})
    t.diagnostic("RESOURCE signed socket "+l.socketDir)
    t.after(()=>removeTree(l.socketDir))
    const owner = {contextId:id,directory:l.root}
    put(path.join(l.root,l.markerName),owner);put(path.join(l.socketDir,l.markerName),owner)
    const declarationRoot=path.join(root,"plugins/context")
    const normalEnv={...process.env,HOME:home,DESK_PLUGIN_ROOT:declarationRoot}
    put(path.join(declarationRoot,"plugin.json"),{name:"context",desk:{browser:{channel:"msedge",profileAccountDomain:"example.test"}}})
    const userDataDir=require(path.join(mcpRoot,"web-real-profile.cjs")).userDataDir("msedge",process.platform,normalEnv,home)
    put(path.join(userDataDir,"Local State"),{profile:{info_cache:{"Profile 17":{user_name:"owner@example.test"}}}})
    const distribution=await import(pathToFileURL(path.join(mcpRoot,"native-messaging-install.mjs")).href)
    const verified=await distribution.verifyNativeDistribution(path.dirname(mcpRoot))
    const nativeReadyFile=path.join(stateRoot,"native-owned/state/native-provider-"+
      require("crypto").createHash("sha256").update(app+"\0"+path.join(userDataDir,"Profile 17")).digest("hex")+".json")
    const selection = {channel:"msedge",userDataDir,profileDirName:"Profile 17",
      nativeReadyFile,extensionId:verified.extensionId,sourceDigest:verified.extensionSourceDigest,
      browserExecutable:app}
    const record = {version:1,contextId:id,label:"Actual maintained worker",...selection}
    delete record.browserExecutable
    const config = {extension:true,browser:{browserName:"chromium",userDataDir:selection.userDataDir,
      launchOptions:{channel:"msedge"}},deskNativeContext:record}
    put(l.configFile,config)
    if (process.platform === "win32") await protectWindowsPaths([
      ...privateDirectories,
    ].map(path=>({path,kind:"directory",created:true})).concat([
      path.join(l.root,l.markerName),path.join(l.socketDir,l.markerName),l.configFile,
    ].map(path=>({path,kind:"file",created:true}))))
    if (process.platform === "win32") for (const directory of privateDirectories) native.privatePath(directory,true)
    // Normal installation provisions this ancestor before the entry starts.
    // Readiness reservation protects its immediate state parent, not ancestors.
    native.privatePath(installedNativeRoot,true)
    const inventoryModule = await import(pathToFileURL(path.join(mcpRoot,"src/browser/native-owner-inventory.mjs")).href)
    const inventory = inventoryModule.createNativeOwnerInventory({browserStateRoot:stateRoot,cliDir:actualCli,binding:selection,
      socketRoot:options.socketRoot})
    const descriptor = inventory.descriptor(id)
    const core = fs.readFileSync(path.join(lib,"coreBundle.js"),"utf8")
    const generated = exactRegion(core,"async function saveSessionFile(","\nvar import_fs67, import_net10, import_path63;")
    // The actual upstream writer has no modes. Run it under the actual worker's
    // child-only creation policy, not a permission-returning filesystem double.
    const writer = path.join(root,"metadata-writer.cjs")
    put(writer,`const fs=require("fs"),path=require("path"),{createHash}=require("crypto");
  const request=JSON.parse(process.argv[2]);process.umask(0o077);
  const {createClientInfo}=require(${JSON.stringify(path.join(actualCli,"registry.js"))});
  const info=createClientInfo();
  const import_fs67={default:fs},import_path63={default:path},import_fs3={default:fs},import_os2={default:require("os")},import_path3={default:path},UNIX_SOCKET_PATH_MAX=103;
  const calculateSha1=value=>createHash("sha1").update(value).digest("hex");
  ${exactRegion(core,"function sanitizeForFilePath(s) {","\nfunction trimLongString(")}
  ${exactRegion(core,"function makeSocketPath(","\nvar import_fs3,")}
  ${generated}
  const metadata=request.metadata||createSessionConfig(info,request.id,{browserName:"chromium",userDataDir:request.userDataDir},{ownership:"attached",persistent:true});
  saveSessionFile(info,metadata).then(()=>console.log(JSON.stringify({info,metadata})));
  `)
    const generation = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(installed.dir,"playwright-patch.json"))).digest("hex")
    const normalMask = process.umask()
    const execution = await promisify(execFile)(process.execPath,[writer,JSON.stringify({id,socketPath:descriptor.socketPath,
      userDataDir:selection.userDataDir,sourceGeneration:generation})],{cwd:l.root,env:common.environment(process.env,l.root,l.socketDir,process.execPath)})
    assert.equal(process.umask(),normalMask,"normal parent mask unchanged")
    const produced = JSON.parse(execution.stdout)
    assert.equal(produced.info.daemonProfilesDir,descriptor.daemonProfilesDir)
    assert.equal(produced.info.workspaceDir,l.root)
    assert.equal(produced.metadata.attached,true)
    assert.equal(produced.metadata.cli.persistent,true)
    // This fixture writes metadata first; normal launch protects this leaf
    // while opening the error log, before the upstream metadata writer runs.
    if (process.platform === "win32") await protectWindowsPaths([
      {path:descriptor.daemonProfilesDir,kind:"directory",created:true},
    ])
    native.privatePath(descriptor.daemonProfilesDir,true)
    for (let current = path.dirname(descriptor.sessionFile);current !== l.root;current = path.dirname(current)) {
      if (process.platform === "win32") native.privatePath(current,true,false)
      else assert.equal(fs.statSync(current).mode & 0o077,0,"actual generated private directory "+current)
    }
    if (process.platform === "win32") native.readPrivateJson(descriptor.sessionFile,{anchor:l.root})
    else assert.equal(fs.statSync(descriptor.sessionFile).mode & 0o077,0)
    // Make actual stamp generation, not an invented current-client correlation.
    const observedFs = Object.create(fs)
    const candidates = require(path.join(mcpRoot,"web-browser-discovery.cjs")).browserPaths("msedge",process.platform,process.env)
    observedFs.existsSync = file => candidates.includes(String(file)) && process.platform !== "darwin" ? true :
      path.resolve(String(file)).startsWith(root+path.sep) && fs.existsSync(file)
    observedFs.realpathSync = file => candidates.includes(String(file)) && process.platform !== "darwin" ? app : fs.realpathSync(file)
    const proc = Object.assign(new EventEmitter(),{platform:process.platform,pid:process.pid,execPath:process.execPath,
      nextTick:process.nextTick.bind(process),
      getuid:process.getuid?.bind(process),env:common.environment(process.env,l.root,l.socketDir,process.execPath),cwd:()=>l.root,
      stdout:{write(){return true}},stderr:{write(){return true}},umask(value){assert.equal(value,0o077)}}
    )
    const module = {exports:{}}
    vm.runInNewContext(fs.readFileSync(path.join(mcpRoot,"web-native-messaging.cjs"),"utf8"),{
      module,__dirname:mcpRoot,process:proc,Buffer,URL,setTimeout,clearTimeout,
      require:name=>name==="http"?observedHttp:require(name.startsWith(".")?path.join(mcpRoot,name):name),
      Function:function(){return async()=>({readNativeAncestry:pid=>readNativeAncestry(pid,{
        processReader:async current=>structuredClone(chain.find(row=>row.pid===current)),
      })})},
    })
    // The normal parent now uses C before allocating a new owner. Give it the
    // same actual C code / owned ancestry+HTTP resources as the worker, rather
    // than attempting to attest the virtual browser's PIDs on the real host.
    t.mock.method(native,"attestNativeContext",(record,selection)=>
      module.exports.attestNativeContext(record,selection))
    const templates = new Map(),templateContexts = new Map()
    function template(name,dir=lib) {
      name=path.basename(name)
      const key=path.join(dir,name)
      if (templates.has(key)) return templates.get(key)
      const context = {
        module:{exports:{}},__dirname:dir,process:proc,Buffer,setTimeout,clearTimeout,
        require:name=>name === "fs" ? observedFs : name===path.join(mcpRoot,"web-native-messaging.cjs") ? module.exports :
          name.startsWith("./desk-") || name === path.join(dir,"desk-extension-credential.cjs") ? template(name,dir) : require(name),
      }
      const value = require("./fixtures/native-template-loader.cjs").loadTemplate(key,context)
      templateContexts.set(key,context)
      templates.set(key,value);return value
    }
    const codec = template("desk-native-error-transport.cjs")
    const scope = codec.forDaemon({...config,configFile:l.configFile},id)
    assert.equal(codec.sessionStamp(scope).sourceGeneration,generation)
    const chain = [1,2,3].map((n,i)=>({pid:810003-i,parentPid:810002-i,startIdentity:"F-owned-"+n,owner:String(process.getuid?.()||"fixture"),executable:i===2?app:path.join(root,"native-"+n)}))
    let active=true, error, wire, nativeFailure, acknowledged="ok",provider,nativeResponse,stopEffect
    const socketStates=new Map([[descriptor.socketPath,{...descriptor,id,get active(){return active},set active(value){active=value}}]])
    const methods=[],requests=[],replies=[]
    const observedHttp = {request(_options,cb) {
      const request = new EventEmitter()
      request.destroy=()=>{}
      request.end=bytes=>queueMicrotask(async()=>{
        const {operation,payload}=JSON.parse(bytes), response=new EventEmitter()
        response.destroy=()=>{};response.statusCode=200
        let value
        if(operation==="dispatch")methods.push(payload.method)
        try {
          if(nativeFailure)throw nativeFailure
          value=await provider.invoke(operation,payload)
          if(operation==="dispatch"&&payload.method==="context.discard"&&nativeResponse)value=nativeResponse(value)
          if(options.selfExit && operation==="dispatch" && payload.method==="context.discard")
            socketStates.get(inventory.layout(payload.contextId).socketPath).active=false
        }catch(error){
          response.statusCode=409;cb(response);response.emit("data",Buffer.from(JSON.stringify({ok:false,error:{code:error.code,resources:error.resources}})));response.emit("end");return
        }
        cb(response);response.emit("data",Buffer.from(JSON.stringify({ok:true,result:value})));response.emit("end")
      });return request
    }}
    const registrySource=fs.readFileSync(path.join(actualCli,"registry.js"),"utf8")
    let registryModule
    function freshRegistry(){
      registryModule={exports:{}}
      vm.runInNewContext(registrySource,{module:registryModule,process:proc,Buffer,
        require:name=>name==="os"?{homedir:()=>proc.env.HOME}:name==="../../package"?require(path.resolve(actualCli,"../../package.js")):require(name)})
    }
    freshRegistry()
    const utils=require(path.resolve(actualCli,"../../utilsBundle.js"))
    const configApi=vm.runInNewContext(
      exactRegion(core,"// packages/playwright-core/src/tools/mcp/configIni.ts","\n// packages/playwright-core/src/tools/mcp/log.ts")+
      "\ninit_config2();({resolveCLIConfigForCLI,resolveExtensionOptions,deskNativeConfigPresent})",{
        process:proc,require:name=>name==="./utilsBundle"?utils:name==="fs"?observedFs:require(name),
        __toESM:value=>({default:value}),
        __esm:object=>{let done=false;return()=>{if(!done){done=true;Object.values(object)[0]()}}},
        init_fileUtils(){},init_inprocess(){},
      })
    let launchError,launchAction,launchSuccess=false
    const launchTrace=[],launchStarted=Date.now()
    const recordLaunch=(phase,details={})=>launchTrace.push({phase,ms:Date.now()-launchStarted,...details})
    const launchCalls=[]
    const acquisition=vm.runInNewContext(
      exactRegion(core,"async function createBrowserWithInfo(","\nasync function connectToBrowserEndpoint(")+
      exactRegion(core,"function browserInfo(browser, config) {","\nasync function createIsolatedBrowser(")+"\ncreateBrowserWithInfo",{
        require:name=>{assert.equal(name,"./desk-extension-credential.cjs");return template("desk-extension-credential.cjs")},
        resolveExtensionOptions:configApi.resolveExtensionOptions,
        createExtensionBrowser:async(...args)=>{launchCalls.push(args);if(launchSuccess){
          recordLaunch("native-acquisition-start")
          const browser=await createNative(...args);recordLaunch("native-acquisition-complete")
          ownerBrowsers.set(args[5].contextId,browser);return browser
        }
          throw launchError || Object.assign(Error("owned unavailable resource"),{code:"NATIVE_REQUEST_TIMEOUT"})},
      })
    function virtualSpawn(_node,args) {
      recordLaunch("session-spawn")
      const child=new EventEmitter()
      child.stdout=new EventEmitter();child.stdout.destroy=()=>{};child.unref=()=>{};child.pid=810017
      const program=utils.program.createCommand()
      const previous=proc.stdout,previousError=proc.stderr
      const previousNative=coreNativeProcess.stdout,previousNativeError=coreNativeProcess.stderr
      proc.stdout=coreNativeProcess.stdout={write:(bytes,callback)=>{
        recordLaunch("stdout-write",{bytes:Buffer.byteLength(bytes),pidField:/"pid"\s*:/.test(String(bytes))})
        queueMicrotask(()=>{
          recordLaunch("stdout-delivery",{listeners:child.stdout.listenerCount("data")})
          child.stdout.emit("data",Buffer.from(bytes))
        })
        callback?.();return true
      }}
      proc.stderr=coreNativeProcess.stderr={write(){return true}}
      const decorate=vm.runInNewContext(
        exactRegion(core,"function decorateProgram3(program4) {","\nfunction defaultConfigFile(")+"\ndecorateProgram3",{
          require:name=>{assert.equal(name,"./desk-native-error-transport.cjs");return codec},
          process:proc,numberParser:Number,setupExitWatchdog(){},
          createClientInfo:registryModule.exports.createClientInfo,guessClientName:()=>"owned F Session",
          deskNativeConfigPresent:configApi.deskNativeConfigPresent,
          resolveCLIConfigForCLI:configApi.resolveCLIConfigForCLI,
          createBrowserWithInfo:acquisition,startCliDaemonServer:(...args)=>{
            recordLaunch("daemon-start")
            const state=socketStates.get(inventory.layout(args[0]).socketPath)
            return (state.daemon||=createDaemon(state))(...args)
          },gracefullyProcessExitDoNotHang(){},
        })
      decorate(program)
      queueMicrotask(()=>{launchAction=program.parseAsync(args.slice(1),{from:"user"}).finally(()=>{
        recordLaunch("program-settled")
        proc.stdout=previous;proc.stderr=previousError
        coreNativeProcess.stdout=previousNative;coreNativeProcess.stderr=previousNativeError
      })})
      return child
    }
    t.after(async()=>{await launchAction})
    const actualSocket = require(path.resolve(actualCli,"../utils/socketConnection.js"))
    const sessionModule={exports:{}}
    vm.runInNewContext(fs.readFileSync(path.join(lib,"tools/cli-client/session.js"),"utf8"),{
      module:sessionModule,process:proc,Buffer,setTimeout,clearTimeout,
      require:name=>name==="./registry"?registryModule.exports:name==="../../package"?require(path.resolve(actualCli,"../../package.js")):
        name==="../utils/socketConnection"?actualSocket:name==="../../desk-native-error-transport.cjs"?codec:
        name==="../../coreBundle.js"?{tools:configApi}:name==="child_process"?{spawn:virtualSpawn}:require(name),
    })
    // The real transformed Backend, Context and Response execute here; the
    // tool's browser/HTTP resource operation is the only injected failure.
    function actualClass(name) {
      return exactRegion(core,"    "+name+" = class", "\n    };")+"\n    };"
    }
    const contextTypes=vm.runInNewContext("var Context,Response4;\n"+actualClass("Context")+actualClass("Response4")+
      "\n({Context,Response4})",{
        process:proc,testDebug(){},disposeAll:async list=>{for(const item of list)await item.dispose()},
        sanitizeUnicode:value=>value, substituteSecrets:value=>value,
      })
    const Backend=vm.runInNewContext("var import_events29,z5,debug10,backendDebug,BrowserBackend;\n"+
      exactRegion(core,"var init_browserBackend = __esm({","\n// packages/playwright-core/src/tools/backend/common.ts")+
      "\ninit_browserBackend();BrowserBackend",{
        require:name=>name==="./desk-native-error-transport.cjs"?codec:name==="events"?{EventEmitter}:{z:{},debug:()=>()=>{}},
        __esm:object=>()=>Object.values(object)[0](),init_context(){},init_response(){},init_sessionLog(){},
        ...contextTypes,formatRejectionReason:String,Buffer,
      })
    const browserContext=new EventEmitter()
    browserContext.browser=()=>null;browserContext.isClosed=()=>false
    browserContext.debugger={pausedDetails:()=>undefined}
    let related
    const commandSource=exactRegion(core,"// packages/playwright-core/src/tools/cli-daemon/command.ts",
      "\n// packages/playwright-core/src/tools/cli-client/minimist.ts")+
      exactRegion(core,"// packages/playwright-core/src/tools/cli-daemon/commands.ts",
      "\n// packages/playwright-core/src/tools/trace/traceSnapshot.ts")
    const commandApi=vm.runInNewContext(commandSource+"\ninit_commands();({commands,parseCommand})",{
      require:name=>{assert.equal(name,"./utilsBundle");return require(path.resolve(actualCli,"../../utilsBundle.js"))},
      __esm:object=>{let done=false;return()=>{if(!done){done=true;Object.values(object)[0]()}}},
    })
    const toolNames=[...new Set(Object.values(commandApi.commands).map(c=>c.toolName).filter(n=>typeof n==="string"))]
    const ownerBrowsers=new Map()
    const tools=toolNames.map(name=>({schema:{name,inputSchema:{parse:value=>value}},handle:async(context,args,response)=>{
      if(related)proc.emit("unhandledRejection",related)
      if(error)throw error
      const browser=ownerBrowsers.get(context.config.deskNativeContext.contextId)
      if(name==="browser_evaluate"&&browser){
        if(!browser.session){
          await browser.command("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:false,flatten:true})
          browser.session=browser.events.find(event=>event.method==="Target.attachedToTarget").params.sessionId
        }
        const result=await browser.command("Runtime.evaluate",{expression:"("+args.function+")()"},browser.session)
        response.addTextResult(JSON.stringify(result.result.value))
      }else response.addTextResult(JSON.stringify({url:"https://ordinary.example/page",args}))
    }}))
    function createDaemon(state) {
    const actorFs=Object.create(fs),actorPromises=Object.create(fs.promises)
    Object.defineProperty(actorFs,"promises",{value:actorPromises})
    actorPromises.writeFile=async(file,data,...args)=>{
      if(file===state.sessionFile&&!fs.existsSync(file)) {
        recordLaunch("metadata-writer-start")
        const imports=[]
        for(let i=0;i<process.execArgv.length;i++)if(process.execArgv[i]==="--import"&&process.execArgv[i+1]?.startsWith("data:"))
          imports.push("--import",process.execArgv[++i])
        await promisify(execFile)(process.execPath,[...imports,writer,JSON.stringify({metadata:JSON.parse(data)})],{
          cwd:state.directory,env:common.environment(normalEnv,state.directory,state.socketDirectory,process.execPath)})
        recordLaunch("metadata-writer-complete")
        return
      }
      return fs.promises.writeFile(file,data,...args)
    }
    return vm.runInNewContext(
      exactRegion(core,"function sanitizeForFilePath(s) {","\nfunction trimLongString(")+
      exactRegion(core,"function makeSocketPath(","\nvar import_fs3,")+
      exactRegion(core,"async function startCliDaemonServer(","\nvar import_fs67, import_net10, import_path63;")+
      "\nstartCliDaemonServer",{
        process:proc,AbortController,Date,Buffer,require:name=>{assert.equal(name,"./desk-native-error-transport.cjs");return codec},
        commands:commandApi.commands,parseCommand:commandApi.parseCommand,
        BrowserBackend:Backend,browserTools:tools,
        socketExists:async()=>false,UNIX_SOCKET_PATH_MAX:103,
        calculateSha1:value=>require("crypto").createHash("sha1").update(value).digest("hex"),
        import_fs3:{default:actorFs},import_path3:{default:path},import_os2:{default:{tmpdir:()=>state.socketDirectory}},
        import_fs67:{default:actorFs},import_path63:{default:path},
        import_net10:{default:{createServer:callback=>{
          const server=new EventEmitter()
          server.listen=(_file,cb)=>{recordLaunch("daemon-listen");state.accept=callback;cb()}
          return server
        }}},
        SocketConnection:actualSocket.SocketConnection,decorateServer(){},monitorSocketPath:async()=>{},
        gracefullyProcessExitDoNotHang:(_code,callback)=>{state.active=false;callback?.()},
      })
    }
    const daemon=createDaemon(socketStates.get(descriptor.socketPath))
    socketStates.get(descriptor.socketPath).daemon=daemon
    const restoreGenerationDiagnostic=require("./fixtures/native-template-loader.cjs").observeNextVerifyGeneration(
      templateContexts.get(path.join(lib,"desk-extension-credential.cjs")),
      "signedWorkerFixture.initial-daemon",
      value=>t.diagnostic("DESK_NATIVE_GENERATION_DIAGNOSTIC_V1 "+JSON.stringify(value)))
    try {
      await daemon(id,browserContext,{browserName:"chromium",userDataDir:selection.userDataDir},
        {...config,configFile:l.configFile},produced.info,{cwd:l.root},{ownership:"attached",persistent:true,exitOnClose:true})
    } finally { restoreGenerationDiagnostic() }
    t.after(()=>{browserContext.removeAllListeners();proc.removeAllListeners()})
    const realLstat=fs.promises.lstat
    t.mock.method(fs.promises,"lstat",async(file,...args)=>socketStates.has(file)?
      socketStates.get(file).active||options.remainingSocketNode?{isSocket:()=>true,isSymbolicLink:()=>false,uid:process.getuid?.()}:Promise.reject(Object.assign(Error("absent"),{code:"ENOENT"})):realLstat(file,...args))
    t.mock.method(net,"createConnection",(file,connected)=>{
      const state=socketStates.get(file)
      assert.ok(state,"only explicit owned derived sockets")
      const socket=new EventEmitter()
      socket.destroy=()=>{if(!socket.destroyed){socket.destroyed=true;queueMicrotask(()=>socket.emit("close"))}}
      const peer=new EventEmitter()
      peer.destroy=()=>socket.destroy()
      peer.write=(bytes,cb)=>{replies.push(JSON.parse(bytes));queueMicrotask(()=>socket.emit("data",Buffer.from(bytes)));cb?.();return true}
      socket.write=(bytes,cb)=>{
        const request=JSON.parse(bytes);requests.push(request);cb()
        if(request.method==="stop")stopEffect?.()
        if(wire || (request.method==="stop" && acknowledged!=="ok")) {
          queueMicrotask(()=>socket.emit("data",Buffer.from(JSON.stringify(wire || {id:request.id,result:acknowledged})+"\n")))
        }else queueMicrotask(()=>peer.emit("data",Buffer.from(bytes)))
        return true
      }
      state.accept(peer)
      queueMicrotask(()=>{if(state.active){connected?.();socket.emit("connect")}else socket.emit("error",Object.assign(Error("unreachable"),{code:options.remainingSocketNode?"ECONNREFUSED":"ENOENT"}))})
      return socket
    })
    const event=()=>{const listeners=new Set();return{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),
      emit:(...args)=>{for(const fn of [...listeners])fn(...args)}}}
    const tabs=new Map([[1,{id:1,windowId:7,groupId:-1,active:true,url:"manual-peer"}]]),groups=new Map(),virtualSockets=[],relays=[]
    const runtimes=new Map(),attached=new Set()
    function pair() {
      const server=new EventEmitter(),client={readyState:1}
      server.readyState=1
      server.send=bytes=>queueMicrotask(()=>{
        if(!client.onmessage)recordLaunch("client-message-before-listener")
        client.onmessage?.({data:bytes})
      })
      client.send=bytes=>queueMicrotask(()=>{
        if(!server.listenerCount("message"))recordLaunch("server-message-before-listener")
        server.emit("message",Buffer.from(bytes))
      })
      function close(){
        if(client.readyState===3)return
        client.readyState=server.readyState=3
        queueMicrotask(()=>{server.emit("close",1000,Buffer.from("owned closed"));client.onclose?.()})
      }
      server.close=client.close=close
      virtualSockets.push(client)
      return{server,client}
    }
    let nextTab=7,nextGroup=30
    const api={
      tabs:{onCreated:event(),onRemoved:event(),onUpdated:event(),onDetached:event(),
        async get(id){if(!tabs.has(id))throw Error("No tab");return{...tabs.get(id)}},
        async query(query){return[...tabs.values()].filter(tab=>query.groupId===undefined||tab.groupId===query.groupId).map(tab=>({...tab}))},
        async create(data){const tab={id:nextTab++,windowId:7,groupId:-1,active:false,...data};tabs.set(tab.id,tab);api.tabs.onCreated.emit({...tab});return{...tab}},
        async group({groupId,tabIds}){const id=groupId??nextGroup++;if(!groups.has(id))groups.set(id,{id,windowId:7});for(const tabId of tabIds){tabs.get(tabId).groupId=id;api.tabs.onUpdated.emit(tabId,{groupId:id},{...tabs.get(tabId)})}return id},
        async remove(id){tabs.delete(id);api.tabs.onRemoved.emit(id,{windowId:7,isWindowClosing:false})},
        async update(){assert.fail("No browser focus")},async ungroup(){assert.fail("No foreign ungroup")}},
      tabGroups:{async get(id){return{...groups.get(id)}},async update(id,value){Object.assign(groups.get(id),value);return{...groups.get(id)}}},
      windows:{async getAll(){return[{id:7,type:"normal"}]},async create(){assert.fail("No new window")},async update(){assert.fail("No focus")}},
      debugger:{onEvent:event(),onDetach:event(),async attach({tabId}){attached.add(tabId)},async detach({tabId}){attached.delete(tabId);api.debugger.onDetach.emit({tabId},"target_closed")},
        async getTargets(){return[...attached].map(tabId=>({tabId,attached:true}))},
        async sendCommand({tabId},method,params={}){
          if(method==="Target.getTargetInfo")return{targetInfo:{targetId:"owned-"+tabId,type:"page",url:"about:blank",title:"owned"}}
          if(method==="Runtime.evaluate"){
            if(!runtimes.has(tabId)){const field={value:""};runtimes.set(tabId,{document:{querySelector:()=>field}})}
            return{result:{type:"string",value:vm.runInNewContext(params.expression,runtimes.get(tabId))}}
          }
          return{}
        }},
      runtime:{id:selection.extensionId,getURL:name=>"chrome-extension://"+selection.extensionId+"/"+name,
        connectNative(host){
          assert.equal(host,"com.ourostack.desk.browser")
          return{onMessage:event(),onDisconnect:event(),disconnect(){},
            postMessage(message){if(message.event==="ready")nativeReady=structuredClone(message)}}
        },
        async getContexts(){return[{documentUrl:api.runtime.getURL("token.html")}]},async sendMessage(){return{token:"d".repeat(64)}}},
      offscreen:{async createDocument(){assert.fail("No token page")}},
      action:{async setBadgeText(){},async setBadgeBackgroundColor(){},async setTitle(){}},
    }
    class Socket{static OPEN=1}
    const engine=createBrowserExtension(api,{WebSocket:Socket,sourceDigest:selection.sourceDigest,openSocket:async endpoint=>{
      const relay=relays.find(relay=>endpoint===relay.host+relay.extensionPath)
      if(relay){
        try {
          const sockets=pair();relay.delegate.onConnection({},new URL(endpoint),sockets.server)
          return sockets.client
        }catch(error){t.diagnostic("owned virtual relay resource failed: "+error.name+" "+String(error.message).replace(/[a-z]+:\/\/\S+/gi,"<url>"));throw error}
      }
      const socket={readyState:1,send(){},close(){socket.readyState=3;socket.onclose?.()}}
      virtualSockets.push(socket);return socket
    }})
    let nativeReady,transport,providerStarted=false
    const startupMethods=[]
    await engine.start()
    transport=new NativeCommandTransport({send:async request=>{
      if(!providerStarted)startupMethods.push(request.method)
      transport.receive(await engine.dispatch(request))
    }})
    t.mock.method(http,"createServer",()=>{
      const server=new EventEmitter()
      server.listen=(_port,_host,callback)=>{queueMicrotask(callback);return server}
      server.address=()=>({port:38123})
      server.close=callback=>{queueMicrotask(()=>{callback?.();server.emit("close")});return server}
      server.unref=()=>server
      return server
    })
    const providerConfig={version:1,extensionId:selection.extensionId,extensionOrigin:"chrome-extension://"+selection.extensionId+"/",
      extensionSourceDigest:selection.sourceDigest,runtimeExecutable:chain[0].executable,entryExecutable:chain[1].executable,
      browserExecutable:app,expectedBrowser:chain[2],channel:selection.channel,userDataDir:selection.userDataDir,
      profileDirName:selection.profileDirName,profileRoot:path.join(selection.userDataDir,selection.profileDirName),
      pluginDirs:[declarationRoot],nativeReadyFile:selection.nativeReadyFile,browserStateRoot:stateRoot,cliDir:actualCli}
    const proof=createNativeUpdateProof(providerConfig)
    provider=await startNativeProvider({config:providerConfig,ready:nativeReady,
      onAdmitted:proof.onAdmitted,verifyContinuity:proof.verifyContinuity,
      chain,transport,inventory,processReader:async pid=>structuredClone(chain.find(row=>row.pid===pid)),
      resolveSelection:async()=>({...selection,profileRoot:providerConfig.profileRoot}),readProfileToken:async()=>"d".repeat(64)})
    providerStarted=true
    assert.deepEqual(startupMethods,["transition.capture","transition.release"],"actual normal D ordinary handoff after healthy C admission")
    t.after(async()=>{
      for(const state of socketStates.values())
        await engine.dispatch({id:"cleanup-"+state.id,method:"context.discard",contextId:state.id,params:{profileToken:"d".repeat(64),sourceDigest:selection.sourceDigest}})
      engine.stop()
      await provider.close()
      assert.ok(virtualSockets.every(socket=>socket.readyState===3))
      assert.ok(tabs.has(1),"manual peer preserved")
    })
    let clock=0,nextTimer=1
    const timers=new Map(),browsers=[]
    const setTimer=(callback,ms)=>{const id=nextTimer++;timers.set(id,{callback,due:clock+ms});return id}
    const clearTimer=id=>timers.delete(id)
    function advance(ms){clock+=ms;for(const [id,timer]of [...timers])if(timer.due<=clock){timers.delete(id);timer.callback()}}
    let nonce="22222222-2222-4222-8222-222222222222"
    class WSServer{
      constructor(delegate){this.delegate=delegate;this.host="ws://127.0.0.1:"+(38124+relays.length);this.extensionPath="/extension/"+nonce;relays.push(this)}
      async listen(){return this.host}
      async close(){this.closed=true}
    }
    const coreNativeProcess={...proc,stdout:proc.stdout,stderr:proc.stderr}
    const relayHelper=require("./fixtures/native-template-loader.cjs").loadTemplate(path.join(lib,"desk-native-relay.cjs"),{
      module:{exports:{}},__dirname:lib,process:coreNativeProcess,Buffer,setTimeout:setTimer,clearTimeout:clearTimer,
      require:name=>name===path.join(lib,"desk-extension-credential.cjs")?template("desk-extension-credential.cjs"):require(name),
    })
    const createNative=vm.runInNewContext("var ManualPromise,BrowserModel,ExtensionProtocolV2,CDPRelayServer,ExtensionConnection;\n"+
      actualClass("ManualPromise")+actualClass("BrowserModel")+actualClass("ExtensionProtocolV2")+actualClass("ExtensionConnection")+actualClass("CDPRelayServer")+
      exactRegion(core,"async function createExtensionBrowser(","\nvar import_path60, debug16, debugLogger3;")+"\ncreateExtensionBrowser",{
        require:name=>name==="./desk-extension-credential.cjs"?template("desk-extension-credential.cjs"):
          name==="./desk-native-relay.cjs"?relayHelper:require(name),
        process:coreNativeProcess,Buffer,URL,WSServer,VERSION:2,ws3:{OPEN:1},
        crypto:{randomUUID:()=>{nonce=options.relayNonce || require("crypto").randomUUID();return nonce}},extensionConnectionTimeout:30000,monotonicTime:()=>clock,
        debugLogger2(){},debugLogger3(){},logUnhandledError(){},
        raceAgainstDeadline:async(callback,deadline)=>{
          let timer
          const result=await Promise.race([Promise.resolve().then(callback).then(()=>({timedOut:false})),
            new Promise(resolve=>{timer=setTimer(()=>resolve({timedOut:true}),deadline-clock)})])
          clearTimer(timer);return result
        },
        playwright:{chromium:{async connectOverCDP(endpoint){
          const relay=relays.find(relay=>endpoint.startsWith(relay.host+"/")),sockets=pair()
          const callbacks=new Map(),events=[]
          let requestId=0
          sockets.client.onmessage=({data})=>{const message=JSON.parse(data);if(message.id){const cb=callbacks.get(message.id);callbacks.delete(message.id);message.error?cb.reject(Error(message.error.message)):cb.resolve(message.result)}else events.push(message)}
          relay.delegate.onConnection({},new URL(endpoint),sockets.server)
          const browser=new EventEmitter()
          browser._guid="owned-"+browsers.length
          const context=new EventEmitter()
          context.browser=()=>browser;context.isClosed=()=>false;context.debugger={pausedDetails:()=>undefined}
          browser.contexts=()=>[context]
          browser.bind=async()=>({endpoint:"owned-only"})
          browser.close=async()=>{sockets.client.close();browser.emit("disconnected");context.emit("close")}
          browser.command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++requestId;callbacks.set(id,{resolve,reject});sockets.client.send(JSON.stringify({id,method,params,sessionId}))})
          browser.events=events;browsers.push(browser);return browser
        }}},
      })
    // The source-owned E helper resolves only the fixed canonical C module.
    // Its C client is real; ancestry and HTTP are the resource doubles above.
    if(options.nativeAcquisition){
      const browser=await createNative(selection.channel,undefined,selection.userDataDir,selection.profileDirName,"owned F component",record)
      ownerBrowsers.set(id,browser)
    }else if(!options.skipNative)await provider.invoke("dispatch",{contextId:id,method:"context.create",params:{label:record.label,
      relayUrl:"ws://127.0.0.1:38124/extension/"+nonce}})
    t.after(async()=>{for(const browser of browsers)await browser.close();for(const socket of virtualSockets)socket.close();assert.equal(timers.size,0)})
    methods.length=0
    const canonical=path.join(mcpRoot,"browser-context-runtime.cjs")
    let code = fs.readFileSync(canonical,"utf8")
    if(process.env.NYC_CONFIG) {
      const owner=Object.keys(require.cache).find(file=>/[/\\]nyc[/\\]index\.js$/.test(file))
      assert.ok(owner,"running standard NYC instrumenter")
      const nyc=new (require(owner))(JSON.parse(process.env.NYC_CONFIG))
      if(nyc.exclude.shouldInstrument(canonical)){
        const instrumenter=nyc.instrumenter()
        code=instrumenter.instrumentSync(code,canonical,{registerMap(){}})
        assert.ok(global.__coverage__,"ordinary NYC collector already initialized by normal module imports")
        const existing=global.__coverage__[canonical],generated=instrumenter.lastFileCoverage()
        if(existing)for(const key of ["statementMap","fnMap","branchMap"])
          assert.deepEqual(plain(generated[key]),plain(existing[key]),"unaltered canonical Istanbul positions")
      }
    }
    const request={mode:"signed-in",operation:"keep",contextId:id,root:l.root,stateRoot,socketDir:l.socketDir,socketRoot:options.socketRoot,
      installed,selection,cliDir:actualCli,args:[]}
    function workerRequire(name) {
        if(name==="./browser-context-common.cjs") return common
        if(name==="./web-native-messaging.cjs") return module.exports
        if(name===path.join(actualCli,"registry.js") || name===path.join(lib,"tools/cli-client/registry.js")) return registryModule.exports
        if(name===path.join(actualCli,"session.js") || name===path.join(lib,"tools/cli-client/session.js")) return sessionModule.exports
        if(name===path.join(lib,"tools/cli-client/program.js")) return require(path.join(actualCli,"program.js"))
        if(name.endsWith("/lib/desk-native-error-transport.cjs")) return template("desk-native-error-transport.cjs",path.dirname(name))
        if(name.startsWith("./")) return require(path.join(mcpRoot,name))
        return require(name)
    }
    function workerInstance(module,process,main) {
      vm.runInNewContext(code,{module,__dirname:mcpRoot,process,Buffer,setTimeout,clearTimeout,__coverage__:global.__coverage__,
        require:Object.assign(workerRequire.bind(null),{main}),
      },{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})
      return module.exports
    }
    const worker={exports:{}}
    workerInstance(worker,proc,null)
    function operation(extra) {
      const op={...request,...extra}
      if(op.contextId!==id) {
        const descriptor=inventory.descriptor(op.contextId)
        if(!socketStates.has(descriptor.socketPath)){
          socketStates.set(descriptor.socketPath,{...descriptor,id:op.contextId,active:true})
          t.diagnostic("RESOURCE signed socket "+descriptor.socketDirectory)
          t.after(()=>removeTree(descriptor.socketDirectory))
        }
      }
      proc.env=common.environment(normalEnv,op.root,op.socketDir,process.execPath)
      proc.cwd=()=>op.root
      freshRegistry()
      return op
    }
    return {root,l,id,descriptor,request,inventory,codec,scope,methods,requests,replies,put,launchCalls,tabs,groups,browsers,advance,
      async transfer(tabId) {
        tabs.get(tabId).groupId=999
        api.tabs.onUpdated.emit(tabId,{groupId:999},{...tabs.get(tabId)})
        await new Promise(setImmediate)
      },
      controllerOptions:{env:normalEnv,prepareBrowserRuntime:async()=>({nodePath:process.execPath,stateRoot,installed})},
      entry(extra) {
        return new Promise(resolve=>{
          const op=operation(extra),module={exports:{}},execution=Object.assign(new EventEmitter(),proc)
          execution._events=Object.create(null)
          execution.argv=[process.execPath,path.join(mcpRoot,"browser-context-runtime.cjs"),JSON.stringify(op)]
          execution.stdout={write:bytes=>{resolve(JSON.parse(bytes));return true}}
          workerInstance(module,execution,module)
        })
      },
      run:extra=>worker.exports.main(operation(extra)).catch(error=>{
        if(launchCalls.length)t.diagnostic("owned launch phases "+JSON.stringify(launchTrace))
        throw error
      }),
      setError:value=>{error=value},setLaunchError:value=>{launchError=value},setLaunchSuccess:()=>{launchSuccess=true},
      setRelated:value=>{related=value},setWire:value=>{wire=value},setActive:value=>{active=value},
      setNativeFailure:value=>{nativeFailure=value},setAck:value=>{acknowledged=value},
      setNativeResponse:value=>{nativeResponse=value},setStopEffect:value=>{stopEffect=value},
      setWorkerPlatform:value=>{proc.platform=value},
      newClientGeneration() {
        const newer={dir:path.join(root,"new-selected-generation"),version:"owned-F-next",core:null}
        const newerLib=path.join(newer.dir,"node_modules/playwright-core/lib")
        put(path.join(newerLib,"coreBundle.js"),original)
        put(path.join(newerLib,"tools/cli-client/session.js"),input.sessionSource)
        patch.apply(newer);assert.equal(patch.readRevision(newer),4)
        return newer
      },
      async originalError(resources) {
        nativeFailure={code:"native_discard_incomplete",resources}
        try {await module.exports.providerRequest("http://127.0.0.1:38123/provider/"+"c".repeat(64),"dispatch",{contextId:id,method:"context.discard"})}
        catch(value){return value}finally{nativeFailure=undefined}
      }}
  }

  test("signed worker keeps actual privately generated persistent metadata without replacement",async t=>{
    const f=await signedWorkerFixture(t)
    const before=fs.readFileSync(f.descriptor.sessionFile)
    const result=await f.run()
    assert.equal(result.state,"running")
    assert.deepEqual(f.methods,["context.resume"])
    assert.deepEqual(fs.readFileSync(f.descriptor.sessionFile),before)
    assert.equal((await f.inventory.inspectOwner(f.id)).cli,"active")
  })

  test("signed worker inventory retains the normal-parent socket root after owner environment isolation",async t=>{
    const socketRoot=fs.mkdtempSync(path.join(process.platform==="darwin"?"/private/tmp":os.tmpdir(),"df-"))
    t.after(()=>removeTree(socketRoot))
    const f=await signedWorkerFixture(t,{socketRoot})
    assert.equal((await f.run()).state,"running")
  })

  test("signed page command honors real minimist inner delimiter and current help schema",async t=>{
    const f=await signedWorkerFixture(t)
    const result=await f.run({operation:"run",args:["fill","e1","--","--session=page-data"]})
    assert.deepEqual(plain(f.requests[0].params.args._),["fill","e1","--session=page-data"])
    assert.equal(JSON.parse(result.result.result).url,"https://ordinary.example/page")
    assert.equal(f.requests[0].params.json,true)
    assert.equal(f.requests[0].params.raw,false)
  })

  test("actual C error crosses transformed Core and F SocketConnection without losing original resource fields",async t=>{
    const f=await signedWorkerFixture(t)
    const resources={contextId:f.id,disposition:"unknown",closedTabIds:[7],remainingTabIds:[8],
      unknownRevokedTabs:[{tabId:9,windowId:3}]}
    const original=await f.originalError(resources)
    f.setError(original)
    f.setRelated(await f.originalError({contextId:f.id,disposition:"retained"}))
    await assert.rejects(f.run({operation:"run",args:["snapshot"]}),error=>{
      assert.equal(error.code,"native_discard_incomplete",JSON.stringify(f.replies))
      assert.deepEqual(plain(error.resources),resources)
      assert.deepEqual(plain(error.nativeTransport),{version:1,contextId:f.id,
        sourceGeneration:f.codec.sessionStamp(f.scope).sourceGeneration,stage:"command",requestId:1})
      assert.equal(error.relatedErrors.length,1)
      assert.equal(error.relatedErrors[0].code,"native_discard_incomplete")
      return true
    })
    assert.ok(fs.existsSync(f.descriptor.sessionFile),"error resources never authorize metadata deletion")
  })

  test("signed discard requires status, preserves manual peers and independently proves exact CLI absence",async t=>{
    const f=await signedWorkerFixture(t)
    const before=fs.readFileSync(f.descriptor.sessionFile)
    const result=await f.run({operation:"discard"})
    assert.equal(result.state,"discarded")
    assert.deepEqual(plain(result.result.releasedRevokedTabs),[])
    assert.deepEqual(plain(result.result.absentTabIds),[7])
    assert.deepEqual(f.methods,["context.status","context.discard"])
    assert.deepEqual(f.requests.map(r=>r.method),["stop"])
    assert.deepEqual(fs.readFileSync(f.descriptor.sessionFile),before)
    await assert.rejects(f.run({operation:"discard"}),{code:"native_context_unavailable"})
    assert.deepEqual(f.methods,["context.status","context.discard","context.status"])
    assert.equal(f.tabs.has(1),true)
  })

  test("signed parent retires only a confirmed discarded owner and preserves its evidence and peers",async t=>{
    const f=await signedWorkerFixture(t)
    const before=fs.readFileSync(f.descriptor.sessionFile)
    const peer=path.join(f.request.stateRoot,"signed-in","22222222-2222-4222-8222-222222222222")
    f.put(path.join(peer,"retained-evidence"),"peer is untouched")
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const result=await controller.context({action:"discard",contextId:f.id},{
      ...f.controllerOptions,
      execute:(_node,args)=>f.run(JSON.parse(args[1])),
    })
    assert.equal(result.exitCode,0,JSON.stringify(result.payload))
    assert.equal(result.payload.state,"discarded")
    assert.equal(fs.existsSync(f.l.root),false,"confirmed terminal owner must leave active inventory")
    const retired=result.payload.contextResources.retiredDirectory
    assert.equal(typeof retired,"string")
    assert.ok(retired.startsWith(path.join(f.request.stateRoot,"artifacts")+path.sep))
    assert.deepEqual(fs.readFileSync(path.join(retired,path.relative(f.l.root,f.descriptor.sessionFile))),before)
    assert.equal(fs.readFileSync(path.join(peer,"retained-evidence"),"utf8"),"peer is untouched")
    assert.equal(f.tabs.has(1),true)
    assert.deepEqual(f.methods,["context.status","context.discard"])
    assert.deepEqual(f.requests.map(request=>request.method),["stop"])
  })

  for(const changed of ["config","session"])
    test("signed parent reports changed "+changed+" evidence after retirement without rolling it back",async t=>{
      const f=await signedWorkerFixture(t)
      const target=changed==="config"?f.l.configFile:f.descriptor.sessionFile
      const rename=fs.promises.rename.bind(fs.promises)
      t.mock.method(fs.promises,"rename",async(from,to)=>{
        if(from===f.l.root) {
          const value=JSON.parse(fs.readFileSync(target))
          value.unexpectedMutation=true
          fs.writeFileSync(target,JSON.stringify(value))
        }
        return rename(from,to)
      })
      const controller=require(path.join(mcpRoot,"browser-context.cjs"))
      const result=await controller.context({action:"discard",contextId:f.id},{
        ...f.controllerOptions,
        execute:(_node,args)=>f.run(JSON.parse(args[1])),
      })
      assert.equal(result.exitCode,1,"post-move evidence changes cannot become confirmed retirement")
      assert.equal(result.payload.code,"cleanup_unconfirmed")
      assert.equal(fs.existsSync(f.l.root),false,"do not roll unknown state back into active inventory")
      const retired=result.payload.contextResources.retiredDirectory
      assert.equal(typeof retired,"string")
      assert.equal(JSON.parse(fs.readFileSync(path.join(retired,path.relative(f.l.root,target)))).unexpectedMutation,true)
    })

  for(const changed of ["native-generation","cli-reappears","metadata","worker-error"])
    test("signed parent retains active owner when "+changed+" prevents confirmed retirement",async t=>{
      const f=await signedWorkerFixture(t)
      if(changed==="worker-error")f.setNativeFailure({code:"native_context_busy",resources:{contextId:f.id,disposition:"unknown"}})
      const controller=require(path.join(mcpRoot,"browser-context.cjs"))
      const result=await controller.context({action:"discard",contextId:f.id},{
        ...f.controllerOptions,
        async execute(_node,args) {
          const result=await f.run(JSON.parse(args[1]))
          if(changed==="native-generation") {
            const ready=JSON.parse(fs.readFileSync(f.request.selection.nativeReadyFile))
            ready.generation="33333333-3333-4333-8333-333333333333"
            f.put(f.request.selection.nativeReadyFile,ready)
          }
          if(changed==="cli-reappears")f.setActive(true)
          if(changed==="metadata") {
            const value=JSON.parse(fs.readFileSync(f.descriptor.sessionFile))
            value.timestamp++
            f.put(f.descriptor.sessionFile,value)
          }
          return result
        },
      })
      assert.equal(result.exitCode,1,JSON.stringify(result.payload))
      assert.equal(fs.existsSync(f.l.root),true,"uncertain owner must stay in active inventory")
      assert.equal(result.payload.contextResources.retiredDirectory,undefined)
      assert.ok(fs.existsSync(f.descriptor.sessionFile))
    })

  test("signed parent reports the reserved artifact after a failed retirement move",async t=>{
    const f=await signedWorkerFixture(t)
    const rename=fs.promises.rename.bind(fs.promises)
    t.mock.method(fs.promises,"rename",(from,to)=>{
      if(from===f.l.root)throw Object.assign(Error("owned retirement move denied"),{code:"EACCES"})
      return rename(from,to)
    })
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const result=await controller.context({action:"discard",contextId:f.id},{
      ...f.controllerOptions,
      execute:(_node,args)=>f.run(JSON.parse(args[1])),
    })
    assert.equal(result.exitCode,1)
    assert.equal(result.payload.code,"EACCES")
    assert.equal(result.payload.contextResources.nativeDisposition.discarded,true)
    assert.equal(fs.existsSync(f.l.root),true)
    assert.equal(result.payload.contextResources.retiredDirectory,undefined)
    const reservation=result.payload.contextResources.retirementArtifactDirectory
    assert.equal(typeof reservation,"string","an unsuccessful move must not hide its retained reservation")
    assert.deepEqual(fs.readdirSync(reservation),[])
  })

  test("signed parent refuses confirmation when the artifact reservation changes during the move",async t=>{
    const f=await signedWorkerFixture(t)
    const rename=fs.promises.rename.bind(fs.promises)
    t.mock.method(fs.promises,"rename",async(from,to)=>{
      if(from===f.l.root) {
        const reservation=path.dirname(to)
        await rename(reservation,reservation+"-changed")
        await fs.promises.mkdir(reservation,{mode:0o700})
      }
      return rename(from,to)
    })
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const result=await controller.context({action:"discard",contextId:f.id},{
      ...f.controllerOptions,
      execute:(_node,args)=>f.run(JSON.parse(args[1])),
    })
    assert.equal(result.exitCode,1,"a different artifact parent cannot confirm retirement")
    assert.equal(result.payload.code,"cleanup_unconfirmed")
    assert.equal(fs.existsSync(f.l.root),false)
    assert.ok(fs.existsSync(result.payload.contextResources.retiredDirectory))
  })

  test("signed parent refuses unknown owner evidence before dispatching discard",async t=>{
    const f=await signedWorkerFixture(t)
    const metadata=JSON.parse(fs.readFileSync(f.descriptor.sessionFile))
    metadata.timestamp=0
    f.put(f.descriptor.sessionFile,metadata)
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    let executions=0
    const result=await controller.context({action:"discard",contextId:f.id},{
      ...f.controllerOptions,execute:()=>{executions++;assert.fail("unknown owner must not dispatch")},
    })
    assert.equal(result.exitCode,1)
    assert.equal(result.payload.code,"cleanup_unconfirmed")
    assert.equal(executions,0)
    assert.deepEqual(f.methods,[])
    assert.equal(fs.existsSync(f.l.root),true)
  })

  test("signed parent rejects a crossed native retirement result",async t=>{
    const f=await signedWorkerFixture(t)
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const result=await controller.context({action:"discard",contextId:f.id},{
      ...f.controllerOptions,
      execute:()=>({state:"discarded",result:{contextId:"22222222-2222-4222-8222-222222222222",discarded:true}}),
    })
    assert.equal(result.exitCode,1)
    assert.equal(result.payload.code,"cleanup_unconfirmed")
    assert.equal(fs.existsSync(f.l.root),true)
    assert.deepEqual(f.methods,[])
  })

  test("signed parent rechecks CLI absence after artifact reservation",async t=>{
    const f=await signedWorkerFixture(t)
    const mkdir=fs.promises.mkdir.bind(fs.promises)
    t.mock.method(fs.promises,"mkdir",async(dir,...args)=>{
      const result=await mkdir(dir,...args)
      if(String(dir).startsWith(path.join(f.request.stateRoot,"artifacts")+path.sep))f.setActive(true)
      return result
    })
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const result=await controller.context({action:"discard",contextId:f.id},{
      ...f.controllerOptions,execute:(_node,args)=>f.run(JSON.parse(args[1])),
    })
    assert.equal(result.exitCode,1)
    assert.equal(result.payload.code,"cleanup_unconfirmed")
    assert.equal(fs.existsSync(f.l.root),true)
    assert.equal(typeof result.payload.contextResources.retirementArtifactDirectory,"string")
    assert.equal(result.payload.contextResources.retiredDirectory,undefined)
  })

  for(const fault of ["native-generation","active-owner","stat-denied"])
    test("signed parent refuses post-move "+fault+" uncertainty",async t=>{
      const f=await signedWorkerFixture(t)
      const rename=fs.promises.rename.bind(fs.promises),lstat=fs.lstatSync.bind(fs)
      let moved=false
      t.mock.method(fs.promises,"rename",async(from,to)=>{
        const result=await rename(from,to)
        if(from===f.l.root) {
          moved=true
          if(fault==="native-generation") {
            const ready=JSON.parse(fs.readFileSync(f.request.selection.nativeReadyFile))
            ready.generation="33333333-3333-4333-8333-333333333333"
            f.put(f.request.selection.nativeReadyFile,ready)
          }
          if(fault==="active-owner")f.put(path.join(f.l.root,"unknown-owner"),"never remove or adopt this")
        }
        return result
      })
      t.mock.method(fs,"lstatSync",(file,...args)=>{
        if(moved && file===f.l.root && fault==="stat-denied")
          throw Object.assign(Error("owned post-move observation denied"),{code:"EACCES"})
        return lstat(file,...args)
      })
      const controller=require(path.join(mcpRoot,"browser-context.cjs"))
      const result=await controller.context({action:"discard",contextId:f.id},{
        ...f.controllerOptions,execute:(_node,args)=>f.run(JSON.parse(args[1])),
      })
      assert.equal(result.exitCode,1)
      assert.equal(result.payload.code,fault==="stat-denied"?"EACCES":"cleanup_unconfirmed")
      assert.ok(fs.existsSync(result.payload.contextResources.retiredDirectory))
      if(fault==="active-owner")
        assert.equal(fs.readFileSync(path.join(f.l.root,"unknown-owner"),"utf8"),"never remove or adopt this")
    })

  test("signed parent rejects malformed worker output before retirement",async t=>{
    const f=await signedWorkerFixture(t)
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    for(const output of [null,{isError:true,state:"discarded"},{state:"running"}]) {
      const result=await controller.context({action:"discard",contextId:f.id},{
        ...f.controllerOptions,execute:()=>output,
      })
      assert.equal(result.exitCode,1)
      assert.equal(result.payload.code,"runner_failed")
      assert.equal(fs.existsSync(f.l.root),true)
      assert.equal(result.payload.contextResources.retiredDirectory,undefined)
    }
    assert.deepEqual(f.methods,[])
  })

  test("signed parent serializes same-owner page work and terminal retirement",async t=>{
    const f=await signedWorkerFixture(t)
    const native=require(path.join(mcpRoot,"web-native-messaging.cjs"))
    let release,entered,prepared
    const held=new Promise(resolve=>{release=resolve})
    const firstEntered=new Promise(resolve=>{entered=resolve})
    const secondPrepared=new Promise(resolve=>{prepared=resolve})
    const privatePath=native.privatePath
    let preparations=0,executions=0
    t.mock.method(native,"privatePath",(file,...args)=>{
      const result=privatePath(file,...args)
      if(file===f.l.socketDir && ++preparations===2)prepared()
      return result
    })
    const controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const options={...f.controllerOptions,async execute(_node,args) {
      executions++
      if(executions===1){entered();await held}
      return f.run(JSON.parse(args[1]))
    }}
    const first=controller.context({action:"keep",contextId:f.id},options)
    await firstEntered
    const second=controller.context({action:"discard",contextId:f.id},options)
    try {
      await secondPrepared
      await new Promise(setImmediate)
      assert.equal(executions,1,"same owner cannot dispatch while its other operation holds the lock")
    } finally {release()}
    const results=await Promise.all([first,second])
    assert.deepEqual(results.map(result=>result.exitCode),[0,0],JSON.stringify(results))
    assert.equal(executions,2)
    assert.equal(fs.existsSync(f.l.root),false)
  })

  for(const invalid of ["ok",{isError:true,discarded:true,closedTabIds:[7],absentTabIds:[7]}])
    test("signed socket error arm is never a stop receipt: "+JSON.stringify(invalid),async t=>{
      const f=await signedWorkerFixture(t)
      f.setWire({id:1,error:invalid})
      await assert.rejects(f.run({operation:"discard"}),{code:"NATIVE_ERROR_TRANSPORT_UNCONFIRMED"})
      assert.equal((await f.inventory.inspectOwner(f.id)).cli,"active")
      assert.ok(fs.existsSync(f.descriptor.sessionFile))
    })

  test("signed worker refuses missing persistent stamp without native resume or replacement",async t=>{
    const f=await signedWorkerFixture(t)
    const metadata=JSON.parse(fs.readFileSync(f.descriptor.sessionFile))
    delete metadata.deskNativeErrorTransport
    f.put(f.descriptor.sessionFile,metadata)
    await assert.rejects(f.run(),{code:"NATIVE_ERROR_TRANSPORT_UNCONFIRMED"})
    assert.deepEqual(f.methods,[])
  })

test("original C error deep-equals its privacy projection through Core, worker JSON, execFile, controller and actual SDK MCP",async t=>{
  const f=await signedWorkerFixture(t)
  const resources={contextId:f.id,disposition:"unknown",remainingTabIds:[8],
    unknownRevokedTabs:[{tabId:9,windowId:3}],privateUrl:"https://private.invalid/?token=fixture"}
  const original=await f.originalError(resources)
  f.setError(original)
  f.setRelated(await f.originalError({contextId:f.id,disposition:"retained",remainingTabIds:[9]}))
  const common=require(path.join(mcpRoot,"browser-context-common.cjs"))
  const controller=require(path.join(mcpRoot,"browser-context.cjs"))
  const beforeHome=process.env.HOME,mask=process.umask()
  let children=0
  t.mock.method(childProcess,"execFile",(node,args,options,callback)=>{
    children++
    assert.equal(node,process.execPath)
    assert.equal(options.cwd,f.l.root)
    assert.equal(options.env.HOME,path.join(f.l.root,"home"))
    assert.equal(options.env.NODE_OPTIONS,undefined)
    f.entry(JSON.parse(args[1])).then(payload=>{
      callback(payload.isError?Object.assign(Error("selected worker exited 1"),{code:1}):null,JSON.stringify(payload),"")
    })
    return new EventEmitter()
  })
  const sdk=name=>import(pathToFileURL(path.join(mcpRoot,"node_modules/@modelcontextprotocol/sdk/dist/esm",name)).href)
  const {startContextMcpServer}=await import(pathToFileURL(path.join(mcpRoot,"src/browser/context-mcp.js")).href)
  const {Client}=await sdk("client/index.js"),{InMemoryTransport}=await sdk("inMemory.js")
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair()
  const server=await startContextMcpServer({tools:require(path.join(mcpRoot,"web-catalog.json")).tools,
    controller:{context:input=>controller.context(input,f.controllerOptions),command:input=>controller.command(input,f.controllerOptions)},
    transport:serverTransport})
  const client=new Client({name:"two-agent shared transport",version:"1"})
  t.after(async()=>{await client.close();await server.close()})
  await client.connect(clientTransport)
  const result=await client.callTool({name:"browser_command",arguments:{contextId:f.id,args:["snapshot"]}})
  assert.equal(result.isError,true)
  const payload=JSON.parse(result.content[0].text)
  assert.equal(payload.code,"native_discard_incomplete",JSON.stringify(payload))
  const projected=f.codec.project(original,f.scope,{stage:"command",requestId:1})
  assert.deepEqual(payload.resources,plain(projected.resources))
  assert.deepEqual(payload.nativeTransport,{version:1,contextId:f.id,
    sourceGeneration:projected.sourceGeneration,stage:"command",requestId:1})
  assert.deepEqual(payload.relatedErrors,[{code:"native_discard_incomplete",message:"native_discard_incomplete",
    resources:{contextId:f.id,disposition:"retained",remainingTabIds:[9]}}])
  assert.equal(payload.contextId,f.id)
  assert.equal(payload.contextResources.contextDirectory,f.l.root)
  assert.equal(children,1)
  assert.equal(process.env.HOME,beforeHome);assert.equal(process.umask(),mask)
  assert.equal(JSON.stringify(payload).includes("private.invalid"),false)
  assert.equal(typeof common.execute,"function")
})

test("signed creation refuses an existing actual Registry entry before Session launch or native mutation",async t=>{
  const f=await signedWorkerFixture(t)
  await assert.rejects(f.run({operation:"create"}),{code:"context_exists"})
  assert.equal(f.launchCalls.length,0)
  assert.deepEqual(f.methods,[])
})

test("actual transformed Session carries original acquisition error through F executable JSON without recreating or deleting owner state",async t=>{
  const f=await signedWorkerFixture(t)
  fs.unlinkSync(f.descriptor.sessionFile)
  const error=await f.originalError({contextId:f.id,disposition:"unknown",remainingTabIds:[8]})
  f.setLaunchError(error)
  const result=await f.entry({operation:"create"})
  assert.equal(result.isError,true)
  assert.equal(result.code,error.code)
  assert.deepEqual(result.resources,plain(error.resources))
  assert.equal(result.nativeTransport.stage,"launch.acquire")
  assert.equal(result.nativeTransport.requestId,null)
  assert.equal(result.nativeTransport.sourceGeneration,f.codec.sessionStamp(f.scope).sourceGeneration)
  assert.equal(f.launchCalls.length,1)
  assert.equal(f.launchCalls[0][3],"Profile 17")
  assert.equal(f.launchCalls[0][5].contextId,f.id)
  assert.ok(fs.existsSync(f.l.configFile))
  assert.ok(fs.existsSync(path.join(f.l.root,".desk-context-owner")))
  assert.equal(fs.existsSync(f.descriptor.sessionFile),false)
})

test("current qualified client decodes a retained daemon against its persistent old generation stamp",async t=>{
  const f=await signedWorkerFixture(t)
  const stamp=JSON.parse(fs.readFileSync(f.descriptor.sessionFile)).deskNativeErrorTransport
  const newer=f.newClientGeneration()
  const newStamp=require("crypto").createHash("sha256").update(fs.readFileSync(path.join(newer.dir,"playwright-patch.json"))).digest("hex")
  assert.notEqual(newStamp,stamp.sourceGeneration)
  f.setError(await f.originalError({contextId:f.id,disposition:"retained",remainingTabIds:[8]}))
  await assert.rejects(f.run({operation:"run",args:["snapshot"],installed:newer}),error=>{
    assert.equal(error.code,"native_discard_incomplete")
    assert.equal(error.nativeTransport.sourceGeneration,stamp.sourceGeneration)
    return true
  })
  assert.deepEqual(JSON.parse(fs.readFileSync(f.descriptor.sessionFile)).deskNativeErrorTransport,stamp)
})

test("actual native transferred tab is released, never reported absent or closed by F discard",async t=>{
  const f=await signedWorkerFixture(t)
  await f.transfer(7)
  const result=await f.run({operation:"discard"})
  assert.equal(result.state,"discarded")
  assert.deepEqual(plain(result.result.closedTabIds),[])
  assert.deepEqual(plain(result.result.absentTabIds),[])
  assert.deepEqual(plain(result.result.releasedRevokedTabs),[{tabId:7,windowId:7}])
  assert.equal(f.tabs.get(7).groupId,999)
  assert.ok(f.tabs.has(1))
})

test("actual acquired native Core remains usable beyond handshake deadline through explicit keep, resume, page and discard",async t=>{
  const f=await signedWorkerFixture(t,{nativeAcquisition:true})
  const browser=f.browsers[0]
  await browser.command("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:false,flatten:true})
  const session=browser.events.find(event=>event.method==="Target.attachedToTarget").params.sessionId
  await browser.command("Runtime.evaluate",{expression:'document.querySelector("input").value = "before-deadline"'},session)
  f.advance(40001)
  assert.equal((await f.run({operation:"keep"})).state,"running")
  assert.equal((await f.run({operation:"resume"})).state,"running")
  assert.equal((await browser.command("Runtime.evaluate",{expression:'document.querySelector("input").value'},session)).result.value,"before-deadline")
  assert.equal((await f.run({operation:"run",args:["snapshot"]})).state,"running")
  assert.equal((await f.run({operation:"discard"})).state,"discarded")
  assert.ok(f.tabs.has(1))
})

for (const relayNonce of [undefined,"0a112233-4455-4677-8899-aabbccddeeff"])
test("fixed internal attach creates through actual Session, Commander, native Core, C and kernel before F reports running"+
  (relayNonce ? " with newline-prefixed encoded nonce" : ""),async t=>{
  const f=await signedWorkerFixture(t,{skipNative:true,relayNonce})
  fs.unlinkSync(f.descriptor.sessionFile)
  f.setLaunchSuccess()
  const result=await f.run({operation:"create"})
  assert.equal(result.state,"running")
  assert.equal(f.launchCalls.length,1)
  assert.equal(f.launchCalls[0][3],"Profile 17")
  assert.equal(f.launchCalls[0][5].contextId,f.id)
  const metadata=JSON.parse(fs.readFileSync(f.descriptor.sessionFile))
  assert.equal(metadata.attached,true);assert.equal(metadata.cli.persistent,true)
  assert.equal(metadata.deskNativeErrorTransport.contextId,f.id)
  assert.equal((await f.inventory.inspectOwner(f.id)).cli,"active")
  assert.equal((await f.run({operation:"discard"})).state,"discarded")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})

test("positive native disposition remains a named obligation when independent CLI acknowledgement is not exact ok",async t=>{
  const f=await signedWorkerFixture(t)
  f.setAck({discarded:true,closedTabIds:[7],absentTabIds:[7]})
  const result=await f.entry({operation:"discard"})
  assert.equal(result.isError,true)
  assert.equal(result.code,"cleanup_unconfirmed")
  assert.equal(result.contextResources.nativeDisposition.discarded,true)
  assert.deepEqual(result.contextResources.nativeDisposition.closedTabIds,[7])
  assert.equal(result.contextResources.cliDisposition,"unknown")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
  assert.equal((await f.inventory.inspectOwner(f.id)).cli,"active")
})

test("current native discard plus exact last-tab CLI absence succeeds without inventing a stop acknowledgement",async t=>{
  const f=await signedWorkerFixture(t,{selfExit:true})
  const result=await f.run({operation:"discard"})
  assert.equal(result.state,"discarded")
  assert.equal(result.result.discarded,true)
  assert.equal(f.requests.length,0,"no stop request or fabricated acknowledgement after verified self-exit")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})

test("remaining refused socket node is unknown after positive native close, never an absence shortcut",async t=>{
  const f=await signedWorkerFixture(t,{selfExit:true,remainingSocketNode:true})
  const result=await f.entry({operation:"discard"})
  assert.equal(result.isError,true)
  assert.equal(result.contextResources.nativeDisposition.discarded,true)
  assert.equal(result.contextResources.cliDisposition,"unknown")
  assert.equal((await f.inventory.inspectOwner(f.id)).cli,"unknown")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})

test("fresh signed child refuses an unqualified generation before executing any maintained module",async t=>{
  const root=await mkTempRoot("desk-F-unqualified-child-")
  t.after(()=>removeTree(root))
  const cliDir=path.join(root,"unknown/lib/tools/cli-client"),effect=path.join(root,"loaded")
  fs.mkdirSync(cliDir,{recursive:true})
  fs.writeFileSync(path.join(cliDir,"registry.js"),`require("fs").writeFileSync(${JSON.stringify(effect)},"unqualified code executed");exports.createClientInfo=()=>({});`)
  const mask=process.umask()
  const result=await promisify(execFile)(process.execPath,[path.join(mcpRoot,"browser-context-runtime.cjs"),JSON.stringify({
    mode:"signed-in",contextId:"11111111-1111-4111-8111-111111111111",installed:{dir:path.join(root,"unknown")},cliDir,
  })],{cwd:root,env:{...process.env,HOME:root}}).catch(error=>({stdout:error.stdout}))
  assert.equal(JSON.parse(result.stdout).code,"unsupported_cli")
  assert.equal(fs.existsSync(effect),false)
  assert.equal(process.umask(),mask)
})

test("signed page result without maintained text is unconfirmed, not a ready or successful result",async t=>{
  const f=await signedWorkerFixture(t)
  f.setWire({id:1,result:{}})
  const result=await f.entry({operation:"run",args:["snapshot"]})
  assert.equal(result.isError,true)
  assert.equal(result.code,"runner_failed")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
  assert.equal(f.tabs.has(7),true)
})

test("keep and resume refuse an absent CLI before asking native resume, without replacing its retained group",async t=>{
  const f=await signedWorkerFixture(t)
  f.setActive(false)
  for(const operation of ["keep","resume","run"]) {
    await assert.rejects(f.run({operation,args:["snapshot"]}),{code:"context_absent"})
  }
  assert.deepEqual(f.methods,[])
  assert.ok(f.tabs.has(7))
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})

test("signed worker refuses a malformed actual help schema by name before parsing page argv",async t=>{
  const f=await signedWorkerFixture(t)
  const cliDir=path.join(f.request.installed.dir,"node_modules/playwright-core/lib/tools/cli-client")
  const helpFile=path.join(cliDir,"help.json"),help=JSON.parse(fs.readFileSync(helpFile))
  delete help.booleanOptions
  f.put(helpFile,help)
  await assert.rejects(f.run({operation:"run",args:["snapshot"],cliDir}),{code:"unsupported_cli"})
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})
test("signed parser uses current maintained flags, argument bounds, raw command bit and exact socket result arms",async t=>{
  const f=await signedWorkerFixture(t)
  const help=require(path.join(f.request.cliDir,"help.json")),common=require(path.join(mcpRoot,"browser-context-common.cjs"))
  for(const[name,command]of Object.entries(help.commands)){
    try{common.validatePageArgs([name],"signed-in")}catch{continue}
    assert.ok(Object.keys(command.flags).every(flag=>!flag.startsWith("no-")),"ordinary maintained negations use their actual base boolean key")
  }
  for(const args of [["snapshot","--unrecognized"],["snapshot","--no-unrecognized"],["snapshot","first","extra"]])
    await assert.rejects(f.run({operation:"run",args}),{code:"invalid_arguments"})
  await f.run({operation:"run",args:["snapshot","--no-boxes"]})
  assert.equal(f.requests.at(-1).params.args.boxes,false)
  await f.run({operation:"run",args:["cookie-list"]})
  assert.equal(f.requests.at(-1).params.raw,true,"maintained command raw bit, not caller --raw")
  for(const wire of [{id:1,error:"ok",result:"ok"},{id:1}]){
    f.setWire(wire)
    await assert.rejects(f.run({operation:"run",args:["snapshot"]}),{code:"cleanup_unconfirmed"})
  }
  const cliDir=path.join(f.request.installed.dir,"node_modules/playwright-core/lib/tools/cli-client")
  const helpFile=path.join(cliDir,"help.json"),original=JSON.parse(fs.readFileSync(helpFile))
  for(const amend of [
    help=>{delete help.commands.snapshot},
    help=>{delete help.commands.snapshot.flags},
    help=>{help.commands.snapshot.args=null},
    help=>{help.commands=null},
    help=>{help.commands=4},
    ()=>null,
  ]){
    const help=structuredClone(original),next=amend(help)
    f.put(helpFile,next===null?null:help);delete require.cache[helpFile]
    await assert.rejects(f.run({operation:"run",args:["snapshot"],cliDir}),{code:"unsupported_cli"})
  }
})
test("signed worker refuses crossed namespace and immutable owner layout before native dispatch",async t=>{
  const f=await signedWorkerFixture(t)
  await assert.rejects(f.run({mode:"private"}),{code:"invalid_arguments"})
  await assert.rejects(f.run({root:f.root}),{code:"NATIVE_OWNER_INVALID"})
  await assert.rejects(f.run({socketDir:f.root}),{code:"NATIVE_OWNER_INVALID"})
  f.setWorkerPlatform("win32")
  await assert.rejects(f.run({root:f.root}),{code:"NATIVE_OWNER_INVALID"})
  assert.deepEqual(f.methods,[])
})
test("worker independently rejects a compatible-inventory metadata race before resuming native custody",async t=>{
  const f=await signedWorkerFixture(t),read=fs.promises.readFile
  let reads=0
  t.mock.method(fs.promises,"readFile",async(file,...args)=>{
    const bytes=await read(file,...args)
    if(String(file)===f.descriptor.sessionFile&&++reads===2){
      const metadata=JSON.parse(bytes);metadata.version="99.0.0"
      return JSON.stringify(metadata)
    }
    return bytes
  })
  await assert.rejects(f.run(),{code:"session_incompatible"})
  assert.deepEqual(f.methods,[])
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})
for(const result of [null,{contextId:"22222222-2222-4222-8222-222222222222",discarded:true},{discarded:false}])
  test("native transport success without the exact current-context discard result is never a receipt: "+JSON.stringify(result),async t=>{
    const f=await signedWorkerFixture(t)
    f.setNativeResponse(()=>result)
    await assert.rejects(f.run({operation:"discard"}),{code:"cleanup_unconfirmed"})
    assert.equal(f.requests.length,0)
    assert.ok(fs.existsSync(f.descriptor.sessionFile))
  })
test("metadata changed by a peer after native close stays unknown and never authorizes CLI stop",async t=>{
  const f=await signedWorkerFixture(t)
  f.setNativeResponse(value=>{
    const metadata=JSON.parse(fs.readFileSync(f.descriptor.sessionFile));metadata.timestamp++
    f.put(f.descriptor.sessionFile,metadata);return value
  })
  const result=await f.entry({operation:"discard"})
  assert.equal(result.code,"cleanup_unconfirmed")
  assert.equal(result.contextResources.nativeDisposition.discarded,true)
  assert.equal(f.requests.length,0)
})
test("exact stop acknowledgement with a still-live socket is bounded unknown, not disposal",async t=>{
  const f=await signedWorkerFixture(t)
  f.setWire({id:1,result:"ok"})
  const result=await f.entry({operation:"discard"})
  assert.equal(result.code,"cleanup_unconfirmed")
  assert.equal(result.contextResources.cliDisposition,"unknown")
  assert.equal(result.resources.native.discarded,true)
  assert.equal(result.resources.cli.disposition,"unknown")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})
test("metadata changed at stop cannot be re-anchored by an otherwise exact acknowledgement and absence",async t=>{
  const f=await signedWorkerFixture(t)
  f.setStopEffect(()=>{
    const metadata=JSON.parse(fs.readFileSync(f.descriptor.sessionFile));metadata.timestamp++
    f.put(f.descriptor.sessionFile,metadata)
  })
  const result=await f.entry({operation:"discard"})
  assert.equal(result.code,"cleanup_unconfirmed")
  assert.equal(result.contextResources.cliDisposition,"unknown")
  assert.ok(fs.existsSync(f.descriptor.sessionFile))
})
  test("normal parent refuses an unqualified generation before selecting a profile or allocating an owner",async t=>{
    const f=await signedWorkerFixture(t),controller=require(path.join(mcpRoot,"browser-context.cjs"))
    fs.appendFileSync(path.join(f.request.installed.dir,"node_modules/playwright-core/lib/coreBundle.js"),"\n// owned integrity corruption\n")
    const result=await controller.context({action:"create",label:"No allocation"},f.controllerOptions)
    assert.equal(result.payload.code,"unsupported_cli")
    assert.equal(Object.hasOwn(result.payload,"contextResources"),false)
  })
  test("normal parent preflights current native readiness and refuses every mismatched binding or non-private file before allocation",async t=>{
    const f=await signedWorkerFixture(t),controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const file=f.request.selection.nativeReadyFile,original=JSON.parse(fs.readFileSync(file))
    for(const amend of [
      ready=>{ready.profileRoot=f.root},
      ready=>{ready.extensionId="a".repeat(32)},
      ready=>{ready.sourceDigest="0".repeat(64)},
      ready=>{delete ready.browser},
      ready=>{ready.browser.executable=f.root},
    ]){
      const ready=structuredClone(original);amend(ready);f.put(file,ready)
      const result=await controller.context({action:"create",label:"No allocation"},f.controllerOptions)
      assert.equal(result.payload.code,"NATIVE_READY_INVALID")
      assert.equal(Object.hasOwn(result.payload,"contextResources"),false)
    }
    f.put(file,original)
    if(process.platform==="win32"){
      const script="$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;"+
        "$item=Get-Item -LiteralPath $p -Force;$acl=$item.GetAccessControl('Access,Owner');"+
        "$everyone=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');"+
        "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'Read','Allow')));"+
        "$item.SetAccessControl($acl)"
      childProcess.execFileSync(assertWindowsAclAvailable(),["-NoProfile","-NonInteractive","-Command",script],{
        input:JSON.stringify(file),encoding:"utf8",timeout:5000,maxBuffer:16384,windowsHide:true,
      })
    }else fs.chmodSync(file,0o644)
    assert.throws(()=>require(path.join(mcpRoot,"web-native-messaging.cjs")).privatePath(file,false),{code:"NATIVE_PRIVATE_PATH_INVALID"})
    assert.equal((await controller.context({action:"create",label:"No allocation"},f.controllerOptions)).payload.code,"NATIVE_PRIVATE_PATH_INVALID")
    if(process.platform==="win32")await protectWindowsPaths([{path:file,kind:"file",created:true}])
    else fs.chmodSync(file,0o600)
  })
  test("normal parent never rebinds an existing strict owner config to another handle or normal selection",async t=>{
    const f=await signedWorkerFixture(t),controller=require(path.join(mcpRoot,"browser-context.cjs"))
    const original=JSON.parse(fs.readFileSync(f.l.configFile))
    for(const [key,value]of [["contextId","22222222-2222-4222-8222-222222222222"],["sourceDigest","0".repeat(64)]]){
      const config=structuredClone(original);config.deskNativeContext[key]=value;f.put(f.l.configFile,config)
      const result=await controller.context({action:"keep",contextId:f.id},f.controllerOptions)
      assert.equal(result.payload.code,"NATIVE_OWNER_BINDING_MISMATCH")
      assert.equal(result.payload.contextResources.contextDirectory,f.l.root)
    }
  })
  test("normal parent validates plain worker success shape independently of native and keeps the named context resources",async t=>{
    const f=await signedWorkerFixture(t),controller=require(path.join(mcpRoot,"browser-context.cjs"))
    for(const worker of [null,{isError:true},{state:"absent"}]){
      const result=await controller.context({action:"keep",contextId:f.id},{...f.controllerOptions,execute:async()=>worker})
      assert.equal(result.payload.code,"runner_failed")
      assert.equal(result.payload.contextResources.contextDirectory,f.l.root)
    }
    const discard=await controller.context({action:"discard",contextId:f.id},{...f.controllerOptions,execute:async()=>({state:"running"})})
    assert.equal(discard.payload.code,"runner_failed")
    assert.ok(fs.existsSync(f.descriptor.sessionFile))
  })
test("two actual agent handles on one SDK connection keep independent native Core DOM models and only discard their own group",async t=>{
  const f=await signedWorkerFixture(t,{skipNative:true})
  f.setLaunchSuccess()
  const controller=require(path.join(mcpRoot,"browser-context.cjs"))
  t.mock.method(childProcess,"execFile",(node,args,options,callback)=>{
    assert.equal(args[0],path.join(mcpRoot,"browser-context-runtime.cjs"))
    const request=JSON.parse(args[1])
    assert.equal(options.cwd,request.root)
    assert.equal(options.env.HOME,path.join(request.root,"home"))
    const owner=JSON.parse(fs.readFileSync(path.join(request.root,".desk-context-owner")))
    assert.deepEqual(owner,{contextId:request.contextId,directory:request.root})
    assert.equal(JSON.parse(fs.readFileSync(path.join(request.root,"config/browser.json"))).deskNativeContext.contextId,request.contextId)
    f.entry(request).then(payload=>callback(payload.isError?Object.assign(Error("owned worker failure"),{code:1}):null,JSON.stringify(payload),""))
    return new EventEmitter()
  })
  const sdk=name=>import(pathToFileURL(path.join(mcpRoot,"node_modules/@modelcontextprotocol/sdk/dist/esm",name)).href)
  const {startContextMcpServer}=await import(pathToFileURL(path.join(mcpRoot,"src/browser/context-mcp.js")).href)
  const {Client}=await sdk("client/index.js"),{InMemoryTransport}=await sdk("inMemory.js")
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair()
  const server=await startContextMcpServer({tools:require(path.join(mcpRoot,"web-catalog.json")).tools,
    controller:{context:input=>controller.context(input,f.controllerOptions),command:input=>controller.command(input,f.controllerOptions)},
    transport:serverTransport})
  const client=new Client({name:"shared parent and child transport",version:"1"})
  t.after(async()=>{await client.close();await server.close()})
  await client.connect(clientTransport)
  async function call(name,input) {
    const result=await client.callTool({name,arguments:input})
    const payload=JSON.parse(result.content[0].text)
    assert.equal(result.isError,false,JSON.stringify(payload))
    return payload
  }
  const a=await call("browser_context",{action:"create",label:"Agent A: form comparison"})
  const b=await call("browser_context",{action:"create",label:"Agent B: renewal research"})
  assert.notEqual(a.contextId,b.contextId)
  assert.match(a.contextId,/^[0-9a-f-]{36}$/)
  assert.match(b.contextId,/^[0-9a-f-]{36}$/)
  for(const [owner,value]of [[a,"agent-a"],[b,"agent-b"]])
    await call("browser_command",{contextId:owner.contextId,args:["eval",`() => document.querySelector("input").value = "${value}"`]})
  f.advance(45000)
  for(const [owner,value]of [[b,"agent-b"],[a,"agent-a"]]){
    const result=await call("browser_command",{contextId:owner.contextId,args:["eval",'() => document.querySelector("input").value']})
    assert.equal(JSON.parse(result.result.result),value)
  }
  assert.deepEqual([...f.groups.values()].map(group=>group.title).sort(),["Agent A: form comparison","Agent B: renewal research"])
  const retiredA=await call("browser_context",{action:"discard",contextId:a.contextId})
  assert.equal(retiredA.state,"discarded")
  const peer=await call("browser_command",{contextId:b.contextId,args:["eval",'() => document.querySelector("input").value']})
  assert.equal(JSON.parse(peer.result.result),"agent-b")
  assert.equal((await call("browser_context",{action:"keep",contextId:b.contextId})).state,"running")
  const retiredB=await call("browser_context",{action:"discard",contextId:b.contextId})
  assert.equal(retiredB.state,"discarded")
  for(const [owner,discarded]of [[a,retiredA],[b,retiredB]]){
    const layout=f.inventory.layout(owner.contextId)
    assert.equal(fs.existsSync(layout.directory),false,"terminal owner leaves active inventory")
    const directory=discarded.contextResources.retiredDirectory
    const sessionFile=path.join(directory,path.relative(layout.directory,layout.sessionFile))
    if(process.platform==="win32"){
      const native=require(path.join(mcpRoot,"web-native-messaging.cjs"))
      native.privatePath(path.dirname(sessionFile),true)
      native.readPrivateJson(sessionFile,{anchor:directory})
    }else assert.equal(fs.statSync(sessionFile).mode&0o077,0,"retained maintained metadata stays private")
    assert.equal(JSON.parse(fs.readFileSync(sessionFile)).deskNativeErrorTransport.contextId,owner.contextId)
  }
  assert.deepEqual([...f.tabs.keys()],[1],"manual peer survives both explicit dispositions")
})
