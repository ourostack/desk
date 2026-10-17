import {test} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {createRequire} from "node:module"
import {pathToFileURL} from "node:url"
import vm from "node:vm"
import {PassThrough} from "node:stream"
import {mcpRoot,makeIsolatedHome,isolatedEnv} from "./_mcp_handshake.js"
import {openSession} from "./_mcp_session.js"
import {mkTempRoot} from "../_temp_roots.js"
import {removeTree} from "../_remove_tree.js"
const require = createRequire(import.meta.url)
const sdk = name => import(pathToFileURL(path.join(mcpRoot,"node_modules/@modelcontextprotocol/sdk/dist/esm",name)).href)
test("browser catalog exposes object-root discoverable explicit context tools, never legacy page tools", async () => {
  const tools = JSON.parse(fs.readFileSync(path.join(mcpRoot,"web-catalog.json"))).tools
  assert.deepEqual(tools.map(t=>t.name),["browser_context","browser_command"])
  const {ToolSchema,ListToolsResultSchema} = await sdk("types.js")
  assert.equal(ListToolsResultSchema.safeParse({tools}).success,true)
  for (const tool of tools) assert.equal(ToolSchema.safeParse(tool).success,true)
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties),["action","mode","contextId","label"])
})

test("standard SDK memory client keeps explicit handles and rejects invalid calls without browser allocation", async t => {
  const file = path.join(mcpRoot,"src/browser/context-mcp.js")
  assert.ok(fs.existsSync(file),"thin SDK frontend must exist")
  const {startContextMcpServer} = await import(pathToFileURL(file).href)
  const {Client} = await sdk("client/index.js")
  const {InMemoryTransport} = await sdk("inMemory.js")
  const root = await mkTempRoot("desk-context-mcp-")
  t.after(()=>removeTree(root))
  const actual = require(path.join(mcpRoot,"browser-context.cjs"))
  let prepared = 0
  const options = {env:{HOME:root,DESK_BROWSER_STATE_DIR:root},prepareBrowserRuntime(){prepared++;throw Error("handshake must not acquire")}}
  const controller = {
    context: input=>actual.context(input,options),
    command: input=>actual.command(input,options),
  }
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair()
  const server = await startContextMcpServer({tools:JSON.parse(fs.readFileSync(path.join(mcpRoot,"web-catalog.json"))).tools,
    controller,transport:serverTransport})
  const client = new Client({name:"context fixture",version:"1"})
  t.after(async()=>{await client.close();await server.close()})
  await client.connect(clientTransport)
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(x=>x.name),["browser_context","browser_command"])
  assert.equal(prepared,0)
  const invalid = await client.callTool({name:"browser_context",arguments:{action:"create"}})
  assert.equal(invalid.isError,true)
  assert.equal(JSON.parse(invalid.content[0].text).code,"invalid_arguments")
  for (const id of ["private-11111111-1111-4111-8111-111111111111","private-22222222-2222-4222-8222-222222222222"]) {
    const result = await client.callTool({name:"browser_context",arguments:{action:"discard",contextId:id}})
    assert.equal(result.isError,false)
    assert.equal(JSON.parse(result.content[0].text).contextId,id)
  }
  const unknown = await client.callTool({name:"browser_click",arguments:{}})
  assert.equal(unknown.isError,true)
  assert.equal(prepared,0)
})

test("old-Node missing-root inline launcher preserves the exact two healthy schemas", () => {
  const declaration = JSON.parse(fs.readFileSync(path.join(mcpRoot,"../.mcp.json"))).mcpServers["desk-web"]
  const stdin = new PassThrough()
  let stdout = ""
  vm.runInNewContext(declaration.args[1],{
    require(name) {
      if (name === "fs") return {existsSync:()=>false}
      if (name === "path") return path
      throw Error("missing-root must not load runtime")
    },
    process:{env:{},cwd:()=>"/missing",stdin,stdout:{write:v=>{stdout+=v}},stderr:{write(){}}},
  })

  stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})+"\n")
  const response = JSON.parse(stdout)
  assert.deepEqual(response.result.tools,JSON.parse(fs.readFileSync(path.join(mcpRoot,"web-catalog.json"))).tools)
  stdin.destroy()
})

test("normal prepared browser-only SDK over owned stdio lists two tools without browser preparation",async t=>{
    const home=await makeIsolatedHome("desk-F-sdk-stdio-")
    const env=isolatedEnv(home)
    const guard=path.join(home.root,"no-native-startup.cjs")
    fs.writeFileSync(guard,`const Module=require("module"),path=require("path"),load=Module._load;
Module._load=function(name,...args){if(["web-native-messaging.cjs","web-real-profile.cjs"].includes(path.basename(name)))throw Error("Browser handshake must not request a native/profile client");return load.call(this,name,...args)};`)
    const marker=path.join(home.root,"relative-node-probe.json")
    if(process.platform!=="win32"){
      const candidate=path.join(home.root,"undefined/usr/local/bin/node")
      fs.mkdirSync(path.dirname(candidate),{recursive:true})
      fs.writeFileSync(candidate,"#!"+process.execPath+"\n"+
        `const cp=require("child_process"),fs=require("fs");fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,start:cp.execFileSync("/bin/ps",["-p",String(process.pid),"-o","lstart="],{encoding:"utf8"}).trim()}));process.stdout.write("v22.9.0 127");`)
      fs.chmodSync(candidate,0o700)
    }
    const session=await openSession({command:process.execPath,args:["--require",guard,path.join(mcpRoot,"browser-context-mcp.cjs")],
      cwd:home.root,env,timeoutMs:15000})
    t.after(()=>session.close())
    if(fs.existsSync(marker))t.diagnostic("E4_FIX_CHILD "+fs.readFileSync(marker,"utf8"))
    assert.equal(fs.existsSync(marker),false,"normal runtime selection never probes an undefined-relative workspace executable")
    assert.deepEqual(session.tools.result.tools,JSON.parse(fs.readFileSync(path.join(mcpRoot,"web-catalog.json"))).tools)
    const invalid=await session.call("browser_context",{action:"create"})
    assert.equal(invalid.isError,true)
    assert.equal(invalid.payload.code,"invalid_arguments")
    assert.equal(fs.existsSync(path.join(home.home,".local/state/ouroboros-skills/desk/browser")),false)
    assert.ok(fs.readdirSync(home.runtimeCache).length,"normal SDK runtime was prepared rather than bypassed")

})
