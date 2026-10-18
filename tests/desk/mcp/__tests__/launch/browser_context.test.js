import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"
import { removeTree } from "../_remove_tree.js"
import vm from "node:vm"
import childProcess from "node:child_process"
import os from "node:os"
import {EventEmitter} from "node:events"

const require = createRequire(import.meta.url)
const A = "11111111-1111-4111-8111-111111111111"
const commonFile = path.join(mcpRoot, "browser-context-common.cjs")
test("shared parent utilities retain native error fields instead of flattening resource obligations", async () => {
  assert.ok(fs.existsSync(commonFile), "shared context utilities must exist")
  const common = require(commonFile)
  const original = Object.assign(new Error("native_discard_incomplete"), {
    code:"native_discard_incomplete", resources:{ contextId:A, remainingTabIds:[7] },
    nativeTransport:{version:1,contextId:A,sourceGeneration:"a".repeat(64),stage:"command",requestId:1},
    relatedErrors:[{code:"native_context_unavailable",message:"native_context_unavailable",resources:{contextId:A}}],
  })
  assert.deepEqual(common.errorPayload(original), {
    isError:true, code:original.code, message:original.message, resources:original.resources,
    nativeTransport:original.nativeTransport, relatedErrors:original.relatedErrors,
  })
})

test("shared parent computes distinct immutable namespaces without changing environment", async t => {
  const common = require(commonFile)
  const root = await mkTempRoot("desk-context-layout-")
  t.after(() => removeTree(root))
  const signed = common.layout(root, A, "signed-in", root)
  const privateOwner = common.layout(root, "private-"+A, "private", root)
  assert.equal(signed.root, path.join(root,"signed-in",A))
  assert.equal(signed.markerName, ".desk-context-owner")
  assert.equal(privateOwner.markerName, ".desk-private-owner")
  const source = {PATH:"/bin",HOME:"/operator",PROGRAMFILES:"/normal",LOCALAPPDATA:"/redirected",PLAYWRIGHT_CLI_SESSION:"default"}
  const before = {...source}
  const env = common.environment(source,signed.root,signed.socketDir,process.execPath)
  assert.deepEqual(source,before)
  assert.equal(env.HOME,path.join(signed.root,"home"))
  assert.equal(env.PLAYWRIGHT_CLI_SESSION,undefined)
  assert.equal(env.PROGRAMFILES,undefined)
  assert.equal(common.modeOf(A),"signed-in")
  assert.equal(common.modeOf("private-"+A),"private")
  assert.throws(()=>common.modeOf("default"),{code:"invalid_arguments"})
  assert.match(common.generateId("signed-in"),/^[0-9a-f-]{36}$/)
  assert.match(common.generateId("private"),/^private-[0-9a-f-]{36}$/)
})

test("controller validates discriminated inputs before any runtime preparation", async () => {
  const file = path.join(mcpRoot,"browser-context.cjs")
  assert.ok(fs.existsSync(file),"explicit controller must exist")
  const controller = require(file)
  let calls = 0
  const options = {prepareBrowserRuntime(){calls++;throw Error("must not prepare invalid input")}}
  for (const input of [
    {}, {action:"create"}, {action:"create",label:" "}, {action:"create",label:"x\n"},
    {action:"create",label:"x".repeat(121)}, {action:"create",label:"😀".repeat(61)},
    {action:"create",label:"work",contextId:A}, {action:"create",label:"work",other:true},
    {action:"keep"},{action:"keep",contextId:A,mode:"private"},
    {action:"resume",contextId:"default"},{action:"discard",contextId:A,label:"work"},
  ]) {
    const r = await controller.context(input,options)
    assert.equal(r.exitCode,1,JSON.stringify(input))
    assert.equal(r.payload.code,"invalid_arguments")
  }
  for (const input of [
    {},{contextId:A,args:[]},{contextId:A,args:["snapshot"],mode:"signed-in"},
    {contextId:A,args:["open"]},{contextId:A,args:["click","e1","-sother"]},
    {contextId:A,args:["click","e1","--no-session"]},
    {contextId:A,args:["snapshot","--json"]},{contextId:A,args:["eval","\0"]},
    {contextId:A,args:["eval","x".repeat(65537)]},
    {contextId:A,args:["eval",...Array(256).fill("x")]},
  ]) assert.equal((await controller.command(input,options)).exitCode,1)
  for (const args of [
    ["create","--label","work","--label","other"],["create","--mode=private"],
    ["create","--label"],["keep",A,"extra"],["run",A,"snapshot"],
  ]) assert.equal((await controller.run(args,options)).exitCode,1)
  assert.equal(calls,0)
})

test("explicit private controller facade retains the legacy absent-discard semantics", async t => {
  const root = await mkTempRoot("desk-context-absent-")
  t.after(()=>removeTree(root))
  const controller = require(path.join(mcpRoot,"browser-context.cjs"))
  const result = await controller.context({action:"discard",contextId:"private-"+A},{
    env:{DESK_BROWSER_STATE_DIR:root,HOME:root},prepareBrowserRuntime(){throw Error("absent private must not prepare")},
  })
  assert.equal(result.exitCode,0)
  assert.equal(result.payload.mode,"private")
  assert.equal(result.payload.state,"absent")
})

test("normal runtime facade no longer loads the retired page proxy or legacy profile-token route",()=>{
  const module={exports:{}}
  vm.runInNewContext(fs.readFileSync(path.join(mcpRoot,"web.cjs"),"utf8"),{
    module,__dirname:mcpRoot,process,
    require:name=>{
      assert.ok(!["./web-proxy.cjs","./web-real-profile.cjs","./web-extension-credential.cjs"].includes(name),
        "retired MCP route is not a default dependency: "+name)
      return require(name.startsWith(".")?path.join(mcpRoot,name):name)
    },
  })
  assert.equal(typeof module.exports.prepareBrowserRuntime,"function")
  assert.equal(typeof module.exports.refresh,"function")
})

test("a signalled worker cannot turn already-written running JSON into success or an original native failure",async t=>{
  const common=require(commonFile)
  t.mock.method(childProcess,"execFile",(_node,_args,_options,callback)=>{
    callback(Object.assign(Error("terminated"),{signal:"SIGTERM"}),JSON.stringify({state:"running",result:"not confirmed"}),"")
  })
  await assert.rejects(common.execute(process.execPath,[],{mode:"signed-in",cwd:process.cwd(),env:{}}),error=>{
    assert.equal(error.code,"runner_failed")
    assert.equal(error.resources.disposition,"unknown")
    return true
  })
})

test("unparseable or non-object signed worker JSON names the unknown disposition rather than supplying a success fallback",async t=>{
  const common=require(commonFile)
  for(const stdout of ["not-json","null","[]","true"]) {
    t.mock.method(childProcess,"execFile",(_node,_args,_options,callback)=>callback(null,stdout,"private diagnostic"))
    await assert.rejects(common.execute(process.execPath,[],{mode:"signed-in",cwd:process.cwd(),env:{}}),error=>{
      assert.equal(error.code,"runner_failed")
      assert.equal(error.resources.disposition,"unknown")
      assert.equal(error.message.includes("private diagnostic"),false)
      return true
    })
  }
})

test("normal parent entry files parse as ES5 before selecting a compatible worker runtime",()=>{
  const owner=Object.keys(require.cache).find(file=>/[/\\]nyc[/\\]index\.js$/.test(file))||
    require.resolve("nyc",{paths:[mcpRoot]})
  const parser=createRequire(owner)("@babel/parser")
  const allowed=new Set(("File Program Directive DirectiveLiteral Identifier ExpressionStatement EmptyStatement BlockStatement "+
    "VariableDeclaration VariableDeclarator FunctionDeclaration FunctionExpression ReturnStatement IfStatement ThrowStatement TryStatement CatchClause "+
    "ForStatement ForInStatement WhileStatement DoWhileStatement SwitchStatement SwitchCase BreakStatement ContinueStatement "+
    "CallExpression NewExpression MemberExpression ObjectExpression ObjectProperty ArrayExpression ThisExpression "+
    "AssignmentExpression BinaryExpression LogicalExpression UnaryExpression UpdateExpression ConditionalExpression SequenceExpression "+
    "StringLiteral NumericLiteral BooleanLiteral NullLiteral RegExpLiteral CommentLine CommentBlock").split(" "))
  function visit(value) {
    if(!value||typeof value!=="object")return
    if(Array.isArray(value)){value.forEach(visit);return}
    if(value.type) {
      assert.ok(allowed.has(value.type),"post-ES5 syntax "+value.type)
      assert.ok(!value.async&&!value.generator&&!value.optional&&!value.computed||
        (value.type==="MemberExpression"&&!value.async&&!value.generator&&!value.optional),"post-ES5 function/member syntax")
      if(value.type==="VariableDeclaration")assert.equal(value.kind,"var")
      if(value.type==="RegExpLiteral")assert.match(value.flags,/^[gim]*$/)
      if(value.type==="NumericLiteral")assert.doesNotMatch(value.extra?.raw||"",/[_n]|^0[box]/i)
      if(value.operator)assert.notEqual(value.operator,"**")
    }
    for(const [key,child]of Object.entries(value))if(!["loc","extra","start","end"].includes(key))visit(child)
  }
  for(const name of ["browser-context-common.cjs","browser-context.cjs","browser-context-mcp.cjs","browser-private.cjs","web.cjs"])
    visit(parser.parse(fs.readFileSync(path.join(mcpRoot,name),"utf8"),{sourceType:"script"}))
})

// Actual shell code and actual Node selector/reexec; only process resources and
// the owned candidate filesystem are virtualized. Canonical maps are unaltered.
function entrySource(file) {
  const canonical=path.join(mcpRoot,file)
  let source=fs.readFileSync(canonical,"utf8")
  if(process.env.NYC_CONFIG){
    const owner=Object.keys(require.cache).find(name=>/[/\\]nyc[/\\]index\.js$/.test(name))
    const instrumenter=new(require(owner))(JSON.parse(process.env.NYC_CONFIG)).instrumenter()
    source=instrumenter.instrumentSync(source,canonical,{registerMap(){}})
    const existing=global.__coverage__?.[canonical],generated=instrumenter.lastFileCoverage()
    if(existing)for(const key of ["statementMap","fnMap","branchMap"])assert.deepEqual(generated[key],existing[key])
  }
  return source
}
function ownedNodeProbe(file) {
  fs.mkdirSync(path.dirname(file),{recursive:true})
  if(process.platform==="win32"){
    fs.copyFileSync(process.execPath,file)
    return
  }
  fs.writeFileSync(file,"#!"+process.execPath+"\n"+
    `const fs=require("fs"),cp=require("child_process");fs.writeFileSync(${JSON.stringify(file+".generation")},JSON.stringify({pid:process.pid,start:cp.execFileSync("/bin/ps",["-p",String(process.pid),"-o","lstart="],{encoding:"utf8"}).trim()}));console.log(process.version+" "+process.versions.modules);`)
  fs.chmodSync(file,0o700)
}
function ownedRuntime(root) {
  const windows=process.platform==="win32"
  const node=path.join(root,windows?"nvm/v22.23.3/node.exe":".nvm/versions/node/v22.23.3/bin/node")
  const env={HOME:root,PATH:"",DESK_NODE_SYSTEM_PREFIX:root}
  for(const key of Object.keys(process.env))
    if(/^(SYSTEMROOT|WINDIR|NODE_OPTIONS)$/i.test(key))env[key]=process.env[key]
  if(windows)Object.assign(env,{NVM_HOME:path.join(root,"nvm"),ProgramFiles:path.join(root,"program-files"),
    "ProgramFiles(x86)":path.join(root,"program-files-x86")})
  return{node,env}
}
async function controllerEntry(t,{candidate=false,spawnError=false,current=false,prefix=true}={}) {
  const root=await mkTempRoot("desk-F-shell-")
  t.after(()=>removeTree(root))
  const {node,env}=ownedRuntime(root)
  if(!prefix)delete env.DESK_NODE_SYSTEM_PREFIX
  if(candidate)ownedNodeProbe(node)
  if(candidate){
    const spawnSync=childProcess.spawnSync
    t.mock.method(childProcess,"spawnSync",(file,args,options)=>{
      const started=Date.now(),result=spawnSync(file,args,options)
      if(file===node&&args.length===2&&args[0]==="-e"&&
          args[1]==='process.stdout.write(process.version + " " + process.versions.modules)')
        t.diagnostic("OWNED_BROWSER_NODE_PROBE "+JSON.stringify({
          program:"node_version_abi",elapsedMs:Date.now()-started,timeoutMs:options.timeout,
          status:result.status,signal:result.signal,errorCode:result.error?.code||null,
          stdoutBytes:Buffer.byteLength(result.stdout||""),stderrBytes:Buffer.byteLength(result.stderr||""),
          validVersionAbi:/^v(\d+\.\d+\.\d+)\S*\s+(\d+)$/.test((result.stdout||"").trim()),
          preloadPresent:Boolean(options.env.NODE_OPTIONS),
          inheritedPreloadUnchanged:options.env.NODE_OPTIONS===process.env.NODE_OPTIONS,
        }))
      return result
    })
  }
  const module={exports:{}},calls=[],output=[]
  const proc=Object.assign(new EventEmitter(),{env,
    platform:process.platform,arch:process.arch,version:current?process.version:"v16.20.2",
    versions:process.versions,execPath:current?process.execPath:path.join(root,"old/node"),
    argv:[process.execPath,path.join(mcpRoot,"browser-context.cjs"),"create"],stdout:{write:bytes=>output.push(bytes)},stderr:{write(){}}})
  const req=Object.assign(name=>{
    if(name==="os")return{...os,homedir:()=>root}
    if(name==="child_process")return{spawn:(node,args,options)=>{
      calls.push({node,args,options})
      if(spawnError)throw Error("Owned spawn failed")
      const child=new EventEmitter();child.kill=()=>{}
      queueMicrotask(()=>child.emit("exit",7,null));return child
    }}
    return require(name.startsWith(".")?path.join(mcpRoot,name):name)
  },{main:module})
  vm.runInNewContext(entrySource("browser-context.cjs"),{module,require:req,__dirname:mcpRoot,
    __filename:path.join(mcpRoot,"browser-context.cjs"),process:proc,Buffer,__coverage__:global.__coverage__})
  await new Promise(setImmediate)
  if(fs.existsSync(node+".generation"))t.diagnostic("E4_FIX_CHILD "+fs.readFileSync(node+".generation","utf8"))
  return{proc,calls,payload:output.length?JSON.parse(output.join("")):null,node}
}
test("controller shell refuses an incompatible Node before interpreting browser arguments",async t=>{
  const result=await controllerEntry(t)
  assert.equal(result.payload.code,"node_missing")
  assert.equal(result.proc.exitCode,1)
  assert.deepEqual(result.calls,[])
})
test("controller shell reexecutes the selected compatible runtime with fixed entry and exact argv",async t=>{
  const result=await controllerEntry(t,{candidate:true})
  assert.equal(result.payload,null)
  assert.equal(result.proc.exitCode,7)
  assert.equal(result.calls.length,1)
  assert.equal(result.calls[0].node,result.node)
  assert.deepEqual(Array.from(result.calls[0].args),[path.join(mcpRoot,"browser-context.cjs"),"create"])
})
test("controller shell reports selected-child spawn failure without interpreting arguments or allocating",async t=>{
  const result=await controllerEntry(t,{candidate:true,spawnError:true})
  assert.equal(result.payload.code,"node_spawn_failed")
  assert.equal(result.proc.exitCode,1)
})
test("controller shell on a compatible runtime preserves normal argument validation",async t=>{
  const result=await controllerEntry(t,{current:true,prefix:false})
  assert.equal(result.payload.code,"invalid_arguments")
  assert.equal(result.proc.exitCode,1)
  assert.deepEqual(result.calls,[])
})
test("controller bounds serialized input, rejects invalid create modes, and common layout rejects crossed namespaces",async()=>{
  const controller=require(path.join(mcpRoot,"browser-context.cjs"))
  const common=require(commonFile)
  assert.throws(()=>common.layout("/owned",A,"private"),{code:"invalid_arguments"})
  for(const mode of ["automatic",null,false])
    assert.equal((await controller.context({action:"create",mode,label:"Owned"})).payload.code,"invalid_arguments")
  const oversized=await controller.command({contextId:A,args:["eval",...Array(20).fill("x".repeat(65536))]})
  assert.equal(oversized.payload.message,"Context request is too large")
  for(const argv of [null,[4],["create","\0"]])
    assert.equal((await controller.run(argv)).payload.code,"invalid_arguments")
})
test("frontend reexec uses the normal default process resources and propagates selected-child exit",async t=>{
  const root=await mkTempRoot("desk-F-frontend-default-resources-")
  t.after(()=>removeTree(root))
  const {node,env}=ownedRuntime(root)
  ownedNodeProbe(node)
  const module={exports:{}},calls=[]
  const proc=Object.assign(new EventEmitter(),{env,
    platform:process.platform,arch:process.arch,version:"v16.20.2",versions:process.versions,execPath:path.join(root,"old/node"),
    stdin:{},stdout:{write(){}},stderr:{write(){}},kill(){assert.fail("no signal exit")}})
  const req=name=>name==="child_process"?{spawn:(...args)=>{
    calls.push(args);const child=new EventEmitter();child.kill=()=>{}
    queueMicrotask(()=>child.emit("exit",9,null));return child
  }}:require(name.startsWith(".")?path.join(mcpRoot,name):name)
  vm.runInNewContext(entrySource("browser-context-mcp.cjs"),{module,require:req,__dirname:mcpRoot,
    __filename:path.join(mcpRoot,"browser-context-mcp.cjs"),process:proc,__coverage__:global.__coverage__})
  await module.exports.run()
  if(fs.existsSync(node+".generation"))t.diagnostic("E4_FIX_CHILD "+fs.readFileSync(node+".generation","utf8"))
  assert.equal(proc.exitCode,9)
  assert.equal(calls[0][0],node)
  assert.deepEqual(Array.from(calls[0][1]),[path.join(mcpRoot,"browser-context-mcp.cjs")])
})
test("signed default options never bypass the normal parent preparation resource boundary",async t=>{
  const web=require(path.join(mcpRoot,"web.cjs")),controller=require(path.join(mcpRoot,"browser-context.cjs"))
  let prepared=0
  t.mock.method(web,"prepareBrowserRuntime",async()=>{prepared++;throw Object.assign(Error("Owned preparation unavailable"),{code:"OWNED_UNAVAILABLE"})})
  const result=await controller.context({action:"create",label:"Owned default resource"})
  assert.equal(result.payload.code,"OWNED_UNAVAILABLE")
  assert.equal(Object.hasOwn(result.payload,"contextResources"),false)
  assert.equal(prepared,1)
})
