import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"
import { removeTree } from "../_remove_tree.js"

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
