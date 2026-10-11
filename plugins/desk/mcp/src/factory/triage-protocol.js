// Bounded adapter BEFORE SDK ReadBuffer. The installed SDK remains the JSON-RPC
// parser and transport; exact roundtrip rejects duplicate/lossy wire objects.
import { PassThrough, Writable } from "node:stream"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { InitializeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { CATALOG_LIMITS, catalogCanonical, catalogHash, catalogToolSchemas, closedObject, dispatchCatalogTool } from "./triage-catalog.js"

// At most this many requests may be in flight or queued. initialize and
// candidate_submit run alone, so the submission receipt chain stays ordered.
const IN_FLIGHT=8
export const catalogProtocolIdentity=()=>({version:3,negotiated:"2025-06-18",
  schema_sha256:catalogHash(catalogCanonical({version:3,depth:32,keys:1024,idBytes:64,inFlight:IN_FLIGHT,
    callMeta:{progressToken:"string<=128|safe_integer","claudecode/toolUseId":"string<=128"},
    cancelled:{requestId:"id",reason:"string<=1024",effect:"advisory"},
    offers:["2025-06-18","2025-11-25"],metadata:{name:128,version:128,title:256,description:1024,websiteUrl:2048},
    capabilities:["roots.listChanged:boolean","elicitation.form:{}","elicitation.url:{}",
      "io.modelcontextprotocol/ui:text/html;profile=mcp-app"],tools:catalogToolSchemas().schemaSha256}))})
const refuse=()=>{throw Error("wire_noncanonical")}
const text=(value,max,required=false)=>{
  if(typeof value!=="string"||(required&&!value)||Buffer.byteLength(value)>max||
    /[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value))throw Error("catalog_invalid")
}
const requestId=id=>{
  if(typeof id==="number"){
    if(!Number.isSafeInteger(id)||id<0||Object.is(id,-0))refuse()
  }else text(id,64,true)
}
function requestIdentity(message){
  closedObject(message,["jsonrpc","method"],Object.hasOwn(message,"id")?["id","params"]:["params"])
  if(message.jsonrpc!=="2.0")refuse()
  text(message.method,128,true)
  if(Object.hasOwn(message,"id"))requestId(message.id)
}
// tools/call params as the native client sends them. _meta is closed: a
// progress token and Claude Code's tool-use id are validated, then ignored.
function validateCatalogCallParams(params){
  const p=closedObject(params,["name","arguments"],["_meta"])
  text(p.name,128,true)
  // Only the object shape is checked here. dispatchCatalogTool applies each
  // tool's closed argument schema to the SDK-parsed arguments, which the SDK
  // passes through without stripping unknown keys.
  closedObject(p.arguments,[],Object.keys(p.arguments??{}))
  if(Object.hasOwn(p,"_meta")){
    const meta=closedObject(p._meta,[],["progressToken","claudecode/toolUseId"])
    if(Object.hasOwn(meta,"progressToken")&&!Number.isSafeInteger(meta.progressToken))text(meta.progressToken,128,true)
    if(Object.hasOwn(meta,"claudecode/toolUseId"))text(meta["claudecode/toolUseId"],128,true)
  }
  return p
}
// notifications/cancelled is advisory: the transport never forwards it, so
// it cannot partially seal or unseal a submission. It may drop a queued read.
function validateCatalogCancel(message){
  closedObject(message,["jsonrpc","method","params"])
  const p=closedObject(message.params,["requestId"],["reason"])
  requestId(p.requestId)
  if(Object.hasOwn(p,"reason"))text(p.reason,1024)
  return p
}
// Decimal value as sign, significant digits and scale, so a token can be
// compared with the shortest round-trip spelling of the parsed number.
const decimal=value=>{
  const [,sign,whole,fraction="",exponent="0"]=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value)
  const digits=(whole+fraction).replace(/^0+/u,""),trimmed=digits.replace(/0+$/u,"")
  return trimmed?`${sign}${trimmed}e${Number(exponent)-fraction.length+digits.length-trimmed.length}`:"0"
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
// prototype/surrogate checks, and a numeric check that refuses any number
// token whose decimal value differs from the parsed double (overflow,
// underflow, unsafe integers and lost precision). Strings are not normalized.
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
      decimal(token)!==decimal(String(number)))refuse()
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
    validateCatalogCallParams(originalMessage.params)
  }else if(originalMessage.method==="notifications/cancelled")validateCatalogCancel(originalMessage)
  else if(!Object.hasOwn(originalMessage,"id"))throw Error("protocol_state")
  return {originalMessage,canonicalHash:catalogHash(catalogCanonical(originalMessage))}
}

export function guardedCatalogTransport({input,output,onFailure,onMessage,onObservation,limits=CATALOG_LIMITS}) {
  const verified=new PassThrough({highWaterMark:32768}),pending=[]
  let partial=Buffer.alloc(0),partialOffset=0,totalIn=0,totalOut=0,framesIn=0,framesOut=0,closed=false,failed=false
  let idleResolve,ended=false,inFlight=0,exclusive=false,busyWrites=0
  const pendingSends=new Set()
  const idle=()=>inFlight===0&&pending.length===0&&busyWrites===0
  const settle=()=>{if(idle())idleResolve?.()}
  const isRequest=message=>Object.hasOwn(message,"id")
  // These run alone: nothing else is forwarded while one is in flight.
  const runsAlone=message=>message.method==="initialize"||(message.method==="tools/call"&&message.params.name==="candidate_submit")
  const failure=(e,direction="input")=>{
    if(failed||closed)return
    failed=true;input.pause()
    onObservation?.({kind:"parser_refused",direction,offset:direction==="input"?partialOffset:totalOut,
      bytes:direction==="input"?partial:Buffer.alloc(0),code:e.message})
    onFailure?.(e);idleResolve?.()
    for(const reject of pendingSends)reject(e)
    pendingSends.clear()
  }
  // Each SDK output frame answers one forwarded request.
  const release=()=>{inFlight=Math.max(0,inFlight-1);exclusive&&=inFlight>0;forward();settle()}
  // FIFO: a request that runs alone waits for in-flight requests to finish,
  // and everything behind it waits for its response.
  const forward=()=>{
    while(!failed&&!closed&&!exclusive&&pending.length){
      const {message,wire}=pending[0],request=isRequest(message),alone=request&&runsAlone(message)
      if(alone&&inFlight>0)return
      pending.shift()
      try {
        onMessage?.(message)
        if(request){inFlight++;exclusive=alone}
        verified.write(wire)
      } catch(e) {failure(e)}
    }
  }
  const account=chunk=>{
    if(failed||closed)throw new Error("wire_closed")
    totalOut+=chunk.length;framesOut++
    if(framesOut<=2)onObservation?.({kind:"output_frame",direction:"output",offset:totalOut-chunk.length,bytes:chunk})
    if(chunk.length>limits.frameBytes||totalOut>limits.outgoingBytes||framesOut>limits.outgoingFrames)throw new Error("wire_output_limit")
  }
  // Over the in-flight limit, that request alone gets a JSON-RPC error and
  // the session stays open. The reply is not an SDK response, so it does
  // not release an in-flight slot.
  const refuseBusy=id=>{
    const frame=Buffer.from(JSON.stringify({jsonrpc:"2.0",id,error:{code:-32000,message:"catalog_busy"}})+"\n")
    account(frame);busyWrites++
    output.write(frame,e=>{busyWrites--;if(e)failure(e,"output");else settle()})
  }
  const outgoing=new Writable({highWaterMark:32768,write(chunk,_encoding,callback){
    try {
      account(chunk)
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
        if(message.method==="notifications/cancelled"){
          // Advisory and never forwarded: an in-flight or sealed request
          // still completes; a queued read with that id is dropped.
          onMessage?.(message)
          const index=pending.findIndex(x=>x.message.id===message.params.requestId&&!runsAlone(x.message))
          if(index>=0)pending.splice(index,1)
          settle();continue
        }
        if(isRequest(message)&&inFlight+pending.filter(x=>isRequest(x.message)).length>=IN_FLIGHT){refuseBusy(message.id);continue}
        if(pending.length>=2*IN_FLIGHT)throw new Error("wire_queue_limit")
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
        }else if(message.method==="notifications/cancelled"){
          if(!initialized)reject()
          validateCatalogCancel(message)
        }else{
          if(phase!=="open"&&phase!=="submitted")reject()
          // The original-object validator already refused unsolicited replies
          // and unknown notifications. Unknown requests reach SDK method-not-
          // found without entering tool dispatch.
          if(message.method==="tools/list"||message.method==="ping"){
            if(message.params!==undefined)closedObject(message.params,[])
          }
          if(message.method==="tools/call")validateCatalogCallParams(message.params)
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
