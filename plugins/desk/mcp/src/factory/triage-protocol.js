// Bounded adapter BEFORE SDK ReadBuffer. The installed SDK remains the JSON-RPC
// parser and transport; exact roundtrip rejects duplicate/lossy wire objects.
import { PassThrough, Writable } from "node:stream"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { InitializeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { CATALOG_LIMITS, catalogCanonical, catalogHash, catalogToolSchemas, closedObject, dispatchCatalogTool } from "./triage-catalog.js"

export const catalogProtocolIdentity=()=>({version:2,negotiated:"2025-06-18",
  schema_sha256:catalogHash(catalogCanonical({version:2,depth:32,keys:1024,idBytes:64,
    offers:["2025-06-18","2025-11-25"],metadata:{name:128,version:128,title:256,description:1024,websiteUrl:2048},
    capabilities:["roots.listChanged:boolean","elicitation.form:{}","elicitation.url:{}",
      "io.modelcontextprotocol/ui:text/html;profile=mcp-app"],tools:catalogToolSchemas().schemaSha256}))})
const refuse=()=>{throw Error("wire_noncanonical")}
const text=(value,max,required=false)=>{
  if(typeof value!=="string"||(required&&!value)||Buffer.byteLength(value)>max||
    /[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value))throw Error("catalog_invalid")
}
function requestIdentity(message){
  closedObject(message,["jsonrpc","method"],Object.hasOwn(message,"id")?["id","params"]:["params"])
  if(message.jsonrpc!=="2.0")refuse()
  text(message.method,128,true)
  if(Object.hasOwn(message,"id")){
    if(typeof message.id==="number"){
      if(!Number.isSafeInteger(message.id)||message.id<0||Object.is(message.id,-0))refuse()
    }else text(message.id,64,true)
  }
}
export function validateCatalogInitialize(message){
  requestIdentity(message)
  closedObject(message,["jsonrpc","id","method","params"])
  if(message.method!=="initialize")throw Error("protocol_state")
  const p=closedObject(message.params,["protocolVersion","capabilities","clientInfo"])
  if(!["2025-06-18","2025-11-25"].includes(p.protocolVersion))throw Error("protocol_state")
  const info=closedObject(p.clientInfo,["name","version"],["title","description","websiteUrl"])
  text(info.name,128,true);text(info.version,128,true)
  for(const [key,max]of [["title",256],["description",1024],["websiteUrl",2048]])if(Object.hasOwn(info,key))text(info[key],max)
  const cap=closedObject(p.capabilities,[],["roots","elicitation","extensions"])
  if(Object.hasOwn(cap,"roots")){
    closedObject(cap.roots,[],["listChanged"])
    if(Object.hasOwn(cap.roots,"listChanged")&&typeof cap.roots.listChanged!=="boolean")throw Error("catalog_invalid")
  }
  if(Object.hasOwn(cap,"elicitation")){
    closedObject(cap.elicitation,[],["form","url"])
    for(const key of Object.keys(cap.elicitation))closedObject(cap.elicitation[key],[])
  }
  if(Object.hasOwn(cap,"extensions")){
    closedObject(cap.extensions,["io.modelcontextprotocol/ui"])
    const ui=closedObject(cap.extensions["io.modelcontextprotocol/ui"],["mimeTypes"])
    if(!Array.isArray(ui.mimeTypes)||ui.mimeTypes.length!==1||ui.mimeTypes[0]!=="text/html;profile=mcp-app")throw Error("catalog_invalid")
  }
  return {offered:p.protocolVersion,negotiated:"2025-06-18",clientInfo:info,capabilities:cap}
}
// A bounded lexical walk, BEFORE JSON.parse: grammar, decoded-key uniqueness,
// prototype/surrogate and numeric loss checks. No wire/string normalization.
export function validateCatalogWireFrame(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>CATALOG_LIMITS.frameBytes)refuse()
  const source=new TextDecoder("utf-8",{fatal:true}).decode(bytes)
  let cursor=0,keys=0
  const space=()=>{while(cursor<source.length&&" \t\r\n".includes(source[cursor]))cursor++}
  const string=()=>{
    if(source[cursor++]!=='"')refuse()
    let value="",done=false
    while(cursor<source.length){
      let ch=source[cursor++]
      if(ch==='"'){done=true;break}
      if(ch<" ")refuse()
      if(ch==="\\"){
        ch=source[cursor++]
        if(ch==="u"){
          const hex=source.slice(cursor,cursor+4)
          if(!/^[a-fA-F0-9]{4}$/u.test(hex))refuse()
          value+=String.fromCharCode(parseInt(hex,16));cursor+=4
        }else{
          const escaped={'"':'"', "\\":"\\", "/":"/", b:"\b", f:"\f", n:"\n", r:"\r", t:"\t"}
          if(!Object.hasOwn(escaped,ch))refuse()
          value+=escaped[ch]
        }
      }else value+=ch
    }
    if(!done||/[\ud800-\udfff]/u.test(value))refuse()
    return value
  }
  const visit=depth=>{
    if(depth>32)refuse()
    space()
    const ch=source[cursor]
    if(ch==='"'){string();return}
    if(ch==="{"||ch==="["){
      cursor++;space()
      const end=ch==="{"?"}":"]",seen=new Set()
      if(source[cursor]===end){cursor++;return}
      for(;;){
        if(ch==="{"){
          const key=string()
          if(++keys>1024||seen.has(key)||["__proto__","prototype","constructor"].includes(key))refuse()
          seen.add(key);space();if(source[cursor++]!==":")refuse()
        }
        visit(depth+1);space()
        const delimiter=source[cursor++]
        if(delimiter===end)return
        if(delimiter!==",")refuse()
        space()
      }
    }
    for(const literal of ["true","false","null"])if(source.startsWith(literal,cursor)){cursor+=literal.length;return}
    const token=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(cursor))?.[0]
    if(!token)refuse()
    const number=Number(token)
    if(!Number.isFinite(number)||Object.is(number,-0)||(Number.isInteger(number)&&!Number.isSafeInteger(number))||
      (number===0&&/[1-9]/u.test(token.split(/[eE]/u)[0])))refuse()
    cursor+=token.length
  }
  visit(0);space();if(cursor!==source.length)refuse()
  const originalMessage=JSON.parse(source)
  requestIdentity(originalMessage)
  if(originalMessage.method==="initialize")validateCatalogInitialize(originalMessage)
  else if(originalMessage.method==="notifications/initialized"){
    closedObject(originalMessage,["jsonrpc","method"],["params"])
    if(originalMessage.params!==undefined)closedObject(originalMessage.params,[])
  }else if(["ping","tools/list"].includes(originalMessage.method)){
    closedObject(originalMessage,["jsonrpc","id","method"],["params"])
    if(originalMessage.params!==undefined)closedObject(originalMessage.params,[])
  }else if(originalMessage.method==="tools/call"){
    closedObject(originalMessage,["jsonrpc","id","method","params"])
    closedObject(originalMessage.params,["name","arguments"])
    text(originalMessage.params.name,128,true)
    // Tool arguments remain the original object, never SDK-stripped data.
    closedObject(originalMessage.params.arguments,[],Object.keys(originalMessage.params.arguments??{}))
  }else if(!Object.hasOwn(originalMessage,"id"))throw Error("protocol_state")
  return {originalMessage,canonicalHash:catalogHash(catalogCanonical(originalMessage))}
}

export function guardedCatalogTransport({input,output,onFailure,onMessage,onObservation,limits=CATALOG_LIMITS}) {
  const verified=new PassThrough({highWaterMark:32768}),pending=[]
  let partial=Buffer.alloc(0),partialOffset=0,totalIn=0,totalOut=0,framesIn=0,framesOut=0,busy=false,closed=false,failed=false
  let idleResolve,ended=false
  const pendingSends=new Set()
  const idle=()=>!busy&&pending.length===0
  const failure=(e,direction="input")=>{
    if(failed||closed)return
    failed=true;input.pause()
    onObservation?.({kind:"parser_refused",direction,offset:direction==="input"?partialOffset:totalOut,
      bytes:direction==="input"?partial:Buffer.alloc(0),code:e.message})
    onFailure?.(e);idleResolve?.()
    for(const reject of pendingSends)reject(e)
    pendingSends.clear()
  }
  const release=()=>{busy=false;forward();if(idle())idleResolve?.()}
  const forward=()=>{
    if(busy||failed||closed||!pending.length)return
    busy=true
    const {message,wire}=pending.shift()
    try {
      onMessage?.(message)
      verified.write(wire)
      if(!Object.hasOwn(message,"id"))queueMicrotask(release)
    } catch(e) {failure(e)}
  }
  const outgoing=new Writable({highWaterMark:32768,write(chunk,_encoding,callback){
    try {
      if(failed||closed)throw new Error("wire_closed")
      totalOut+=chunk.length;framesOut++
      if(framesOut<=2)onObservation?.({kind:"output_frame",direction:"output",offset:totalOut-chunk.length,bytes:chunk})
      if(chunk.length>limits.frameBytes||totalOut>limits.outgoingBytes||framesOut>limits.outgoingFrames)throw new Error("wire_output_limit")
      const flowing=output.write(chunk,e=>{
        if(framesOut<=2)onObservation?.({kind:"write_complete",direction:"output",offset:totalOut,code:e?"write_failed":null})
        callback(e);if(e)failure(e,"output");else release()
      })
      if(framesOut<=2)onObservation?.({kind:"backpressure",direction:"output",offset:totalOut,blocked:!flowing})
    }catch(e){callback(e);failure(e,"output")}
  }})
  outgoing.on("error",e=>failure(e,"output"));verified.on("error",failure)
  const data=chunk=>{
    try {
      totalIn+=chunk.length
      if(totalIn>limits.incomingBytes)throw new Error("wire_input_limit")
      let cursor=0
      while(cursor<chunk.length){
        const index=chunk.indexOf(10,cursor),end=index<0?chunk.length:index
        if(!partial.length)partialOffset=totalIn-chunk.length+cursor
        if(partial.length+end-cursor>limits.frameBytes)throw new Error("wire_frame_limit")
        partial=Buffer.concat([partial,chunk.subarray(cursor,end)])
        cursor=end+(index<0?0:1)
        if(index<0)break
        framesIn++
        if(framesIn>limits.incomingFrames)throw new Error("wire_frame_count")
        if(framesIn<=2)onObservation?.({kind:"input_frame",direction:"input",offset:partialOffset,
          bytes:Buffer.concat([partial,Buffer.from("\n")])})
        // An optional single CR immediately before LF is a delimiter, not
        // JSON whitespace. Keep original bytes in frame/aggregate accounting.
        const payload=partial.at(-1)===13?partial.subarray(0,-1):partial
        const line=new TextDecoder("utf-8",{fatal:true}).decode(payload)
        const {originalMessage:message}=validateCatalogWireFrame(Buffer.from(line))
        partial=Buffer.alloc(0)
        if(pending.length>=1)throw new Error("wire_queue_limit")
        pending.push({message,wire:line+"\n"});forward()
      }
    }catch(e){failure(e)}
  }
  const end=()=>{ended=true;onObservation?.({kind:"input_end",direction:"input",offset:totalIn});if(partial.length)failure(new Error("wire_incomplete"));if(idle())idleResolve?.()}
  input.on("data",data);input.on("end",end);input.on("error",failure)
  const transport=new StdioServerTransport(verified,outgoing)
  const sdkSend=transport.send.bind(transport)
  // SDK stdio waits only for drain after write(false), even when write's
  // callback fails. Keep its serialization/transport, but settle those sends
  // on our guarded fatal/close event instead of leaving handler work pending.
  transport.send=message=>{
    if(failed||closed)return Promise.reject(new Error("wire_closed"))
    return new Promise((resolve,reject)=>{
      pendingSends.add(reject)
      sdkSend(message).then(()=>{pendingSends.delete(reject);resolve()},error=>{pendingSends.delete(reject);reject(error)})
    })
  }
  return {transport,failed:()=>failed,ended:()=>ended,counters:()=>({totalIn,totalOut,framesIn,framesOut}),
    waitIdle:()=>idle()||failed?Promise.resolve():new Promise(r=>{idleResolve=r}),
    async close(){if(closed)return;closed=true;input.pause();input.off("data",data);input.off("end",end);input.off("error",failure);
      for(const reject of pendingSends)reject(new Error("wire_closed"))
      pendingSends.clear();await transport.close();verified.destroy();outgoing.destroy();idleResolve?.()},
  }
}

export async function serveCatalog({state,input=process.stdin,output=process.stdout,writeReceipt,onFailure,onObservation}) {
  let phase="initializing",initialized=false
  const server=new Server({name:"triage_catalog",version:"1"},{capabilities:{tools:{}}})
  const reject=()=>{throw new Error("protocol_state")}
  const guarded=guardedCatalogTransport({input,output,onFailure,onObservation,
    onMessage(message){
        if(message.method==="initialize"){
          if(initialized)reject()
          validateCatalogInitialize(message)
          initialized=true
        }else if(message.method==="notifications/initialized"){
          if(!initialized||phase!=="initializing")reject()
          if(message.params!==undefined)closedObject(message.params,[])
          phase="open"
        }else{
          if(phase!=="open"&&phase!=="submitted")reject()
          // The original-object validator already refused unsolicited replies
          // and unknown notifications. Unknown requests reach SDK method-not-
          // found without entering tool dispatch.
          if(message.method==="tools/list"||message.method==="ping"){
            if(message.params!==undefined)closedObject(message.params,[])
          }
          if(message.method==="tools/call")closedObject(message.params,["name","arguments"])
        }
    },
  })
  server.setRequestHandler(InitializeRequestSchema,async()=>({
    protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"triage_catalog",version:"1"},
  }))
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:catalogToolSchemas().tools}))
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try {
      const before={phase:state.phase,submission:state.submission}
      const dispatched=dispatchCatalogTool({name:request.params.name,args:request.params.arguments,requestId:extra.requestId,state})
      if(dispatched.submitReceipt){
        try{await writeReceipt("submit",dispatched.submitReceipt)}
        catch(error){
          state.phase=before.phase;state.submission=before.submission
          onFailure?.(error)
          throw error
        }
      }
      phase=state.phase
      return {content:[{type:"text",text:catalogCanonical(dispatched.result)}],structuredContent:dispatched.result}
    }catch{
      return {isError:true,content:[{type:"text",text:"catalog_request_refused"}]}
    }
  })
  server.onerror=onFailure
  await server.connect(guarded.transport)
  return {server,guarded,
    async close(){await guarded.waitIdle();state.phase="closed";phase="closed";await guarded.close()},
    error:()=>new McpError(ErrorCode.InvalidRequest,"catalog_request_refused"),
  }
}
