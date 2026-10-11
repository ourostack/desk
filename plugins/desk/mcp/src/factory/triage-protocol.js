// Bounded adapter BEFORE SDK ReadBuffer. The installed SDK remains the JSON-RPC
// parser and transport; exact roundtrip rejects duplicate/lossy wire objects.
import { PassThrough, Writable } from "node:stream"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import { InitializeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { CATALOG_LIMITS, catalogCanonical, catalogToolSchemas, closedObject, dispatchCatalogTool } from "./triage-catalog.js"

export function guardedCatalogTransport({input,output,onFailure,onMessage,limits=CATALOG_LIMITS}) {
  const verified=new PassThrough({highWaterMark:32768}),pending=[]
  let partial=Buffer.alloc(0),totalIn=0,totalOut=0,framesIn=0,framesOut=0,busy=false,closed=false,failed=false
  let idleResolve,ended=false
  const pendingSends=new Set()
  const idle=()=>!busy&&pending.length===0
  const failure=e=>{
    if(failed||closed)return
    failed=true;input.pause();onFailure?.(e);idleResolve?.()
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
      if(chunk.length>limits.frameBytes||totalOut>limits.outgoingBytes||framesOut>limits.outgoingFrames)throw new Error("wire_output_limit")
      output.write(chunk,e=>{callback(e);if(e)failure(e);else release()})
    }catch(e){callback(e);failure(e)}
  }})
  outgoing.on("error",failure);verified.on("error",failure)
  const data=chunk=>{
    try {
      totalIn+=chunk.length
      if(totalIn>limits.incomingBytes)throw new Error("wire_input_limit")
      let cursor=0
      while(cursor<chunk.length){
        const index=chunk.indexOf(10,cursor),end=index<0?chunk.length:index
        if(partial.length+end-cursor>limits.frameBytes)throw new Error("wire_frame_limit")
        partial=Buffer.concat([partial,chunk.subarray(cursor,end)])
        cursor=end+(index<0?0:1)
        if(index<0)break
        framesIn++
        if(framesIn>limits.incomingFrames)throw new Error("wire_frame_count")
        // An optional single CR immediately before LF is a delimiter, not
        // JSON whitespace. Keep original bytes in frame/aggregate accounting.
        const payload=partial.at(-1)===13?partial.subarray(0,-1):partial
        const line=new TextDecoder("utf-8",{fatal:true}).decode(payload)
        const message=deserializeMessage(line)
        if(serializeMessage(message)!==line+"\n")throw new Error("wire_noncanonical")
        // SDK unknown object keys otherwise disappear on schema parse. Tool
        // arguments remain intact, so reject prototype keys recursively too.
        catalogCanonical(message)
        partial=Buffer.alloc(0)
        if(pending.length>=1)throw new Error("wire_queue_limit")
        pending.push({message,wire:line+"\n"});forward()
      }
    }catch(e){failure(e)}
  }
  const end=()=>{ended=true;if(partial.length)failure(new Error("wire_incomplete"));if(idle())idleResolve?.()}
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

export async function serveCatalog({state,input=process.stdin,output=process.stdout,writeReceipt,onFailure}) {
  let phase="initializing",initialized=false
  const server=new Server({name:"triage_catalog",version:"1"},{capabilities:{tools:{}}})
  const reject=()=>{throw new Error("protocol_state")}
  const guarded=guardedCatalogTransport({input,output,onFailure,
    onMessage(message){
      if(Object.hasOwn(message,"method")){
        if(message.method==="initialize"){
          if(initialized)reject()
          closedObject(message.params,["protocolVersion","capabilities","clientInfo"])
          closedObject(message.params.capabilities,[])
          closedObject(message.params.clientInfo,["name","version"])
          if(message.params.protocolVersion!=="2025-06-18")reject()
          initialized=true
        }else if(message.method==="notifications/initialized"){
          if(!initialized||phase!=="initializing")reject()
          if(message.params!==undefined)closedObject(message.params,[])
          phase="open"
        }else{
          if(phase!=="open"&&phase!=="submitted")reject()
          if(!["ping","tools/list","tools/call"].includes(message.method)){
            // Unknown requests get the SDK method-not-found error; unknown
            // notifications cannot silently expand the protocol.
            if(!Object.hasOwn(message,"id"))reject()
          }
          if(message.method==="tools/list"||message.method==="ping"){
            if(message.params!==undefined)closedObject(message.params,[])
          }
          if(message.method==="tools/call")closedObject(message.params,["name","arguments"])
        }
      }else reject()
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
