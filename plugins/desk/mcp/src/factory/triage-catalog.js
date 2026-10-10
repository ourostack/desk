// Finite immutable evidence service. No content-directed filesystem or import
// operation exists in dispatch. Prepared authorization is private run data.
import { createHash, randomBytes } from "node:crypto"
import { constants, promises as fs } from "node:fs"
import * as path from "node:path"
import { validateTriageResultBytes } from "./triage-schema.js"
import { assertOutsideGitWorkspace } from "./os-protect.js"

export const CATALOG_LIMITS = Object.freeze({
  cards:20, records:320, recordBytes:16384, briefBytes:331776, snapshotBytes:6291456,
  candidateBytes:331776, frameBytes:393216, incomingBytes:16777216, outgoingBytes:16777216,
  incomingFrames:256, outgoingFrames:256, queryBytes:256, page:20,
  receiptBytes:2097152, receiptFrames:4, controlBytes:1024, stderrBytes:65536,
})
export const catalogHash = bytes => createHash("sha256").update(bytes).digest("hex")
const fail = () => { throw new Error("catalog_invalid") }
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const token = /^r\d{6}$/u
const hex = /^[a-f0-9]{64}$/u
export function boundedCatalogBytes(value,max){
  if((typeof value!=="string"&&!Buffer.isBuffer(value))||Buffer.byteLength(value)>max)fail()
  return value
}
function scalarText(value, max, multiline = false) {
  if (typeof value !== "string" || Buffer.byteLength(value)>max ||
    /[\ud800-\udfff]/u.test(value) || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u : /[\x00-\x1f\x7f-\x9f]/u).test(value)) fail()
  return value
}
export function closedObject(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)) ||
      required.some(k=>!Object.hasOwn(value,k)) ||
      Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k))) fail()
  return value
}
// Sorted keys recursively; duplicate-key/canonical-byte checks happen on all
// external byte readers before the object can reach this serializer.
export function catalogCanonical(value) {
  const visit = (v, depth) => {
    if (depth>32) fail()
    if (typeof v==="string") { scalarText(v,CATALOG_LIMITS.snapshotBytes,true);return v }
    if (v===null || typeof v==="boolean") return v
    if (typeof v==="number") { if (!Number.isFinite(v)) fail();return v }
    if (Array.isArray(v)) return v.map(x=>visit(x,depth+1))
    if (typeof v!=="object" || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) fail()
    const out={}
    for (const k of Object.keys(v).sort()) {
      if (["__proto__","prototype","constructor"].includes(k)) fail()
      out[k]=visit(v[k],depth+1)
    }
    return out
  }
  return JSON.stringify(visit(value,0))
}
function referenceList(list) {
  if (!Array.isArray(list)||list.length>320||new Set(list).size!==list.length) fail()
  for (const value of list) {
    scalarText(value,256)
    if (!value || /[/\\:]|^\.{1,2}$/u.test(value)) fail()
  }
}
function validateRaw({brief,records,recordRefs}) {
  closedObject(brief,["batch","producer_version","rubric_version","cards"])
  if (!/^[a-f0-9]{16}$/u.test(brief.batch)|| !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(brief.producer_version) ||
      !Number.isSafeInteger(brief.rubric_version)||brief.rubric_version<1|| !Array.isArray(brief.cards) ||
      brief.cards.length>20 || bytes(brief)>CATALOG_LIMITS.briefBytes) fail()
  const keys=new Set(),refs=new Map()
  for (const c of brief.cards) {
    closedObject(c,["key","basis","evidence_ids","ruling_ids","authority_codes"])
    scalarText(c.key,1200);scalarText(c.basis,1200)
    if (!c.key||!c.basis||keys.has(c.key)||bytes(c)>16384) fail()
    keys.add(c.key);referenceList(c.evidence_ids);referenceList(c.ruling_ids)
    if (!Array.isArray(c.authority_codes)||!c.authority_codes.length||new Set(c.authority_codes).size!==c.authority_codes.length ||
      c.authority_codes.some(x=>!["existing_scope","approved_plan","investigation_only","human_gate"].includes(x))) fail()
    for (const [kind,list] of [["evidence",c.evidence_ids],["ruling",c.ruling_ids]]) for (const ref of list) {
      if (refs.has(ref)&&refs.get(ref)!==kind) fail()
      refs.set(ref,kind)
    }
  }
  if (!Array.isArray(records)||records.length+1>320||records.length<brief.cards.length ||
      !Array.isArray(recordRefs)||recordRefs.length>320) fail()
  const ids=new Map()
  for (const [i,r] of records.entries()) {
    closedObject(r,["id","kind","revision","text"])
    if (r.id!==`r${String(i+1).padStart(6,"0")}`||ids.has(r.id) ||
      (i<brief.cards.length ? r.kind!=="card" : !["evidence","ruling"].includes(r.kind)) ||
      !Number.isSafeInteger(r.revision)||r.revision<1) fail()
    scalarText(r.text,16384,true);if (bytes(r)>16384) fail()
    ids.set(r.id,r)
  }
  const mapped=new Set(),targeted=new Set()
  for (const m of recordRefs) {
    closedObject(m,["ref","id"]);referenceList([m.ref])
    if (!token.test(m.id)|| !ids.has(m.id)||mapped.has(m.ref) ||
      ids.get(m.id).kind!==refs.get(m.ref)) fail()
    mapped.add(m.ref);targeted.add(m.id)
  }
  if (mapped.size!==refs.size||records.slice(brief.cards.length).some(r=>!targeted.has(r.id))) fail()
}
export function prepareTriageCatalog({brief,records,recordRefs,generation}) {
  if (!hex.test(generation)) fail()
  validateRaw({brief,records,recordRefs})
  const composed=[{id:"r000000",kind:"brief",revision:1,text:catalogCanonical({
    batch:brief.batch,producer_version:brief.producer_version,rubric_version:brief.rubric_version,
    card_ids:brief.cards.map((_,i)=>`r${String(i+1).padStart(6,"0")}`),
  })},...records.map((r,i)=>i<brief.cards.length?{...r,text:catalogCanonical({
    authorization:brief.cards[i],record_refs:recordRefs.filter(m=>[...brief.cards[i].evidence_ids,...brief.cards[i].ruling_ids].includes(m.ref)),
    prepared_text:r.text,
  })}:{...r})]
  if (composed.some(r=>bytes(r)>16384)) fail()
  const snapshot={schema:"desk.factory.triage-catalog/1",generation,receipt_key:randomBytes(32).toString("hex"),
    brief:structuredClone(brief),record_refs:structuredClone(recordRefs),records:composed}
  const snapshotBytes=boundedCatalogBytes(catalogCanonical(snapshot),CATALOG_LIMITS.snapshotBytes)
  return {snapshotBytes,snapshotSha256:catalogHash(snapshotBytes),briefSha256:catalogHash(catalogCanonical(brief)),
    catalogSha256:catalogHash(catalogCanonical(composed)),recordRefsSha256:catalogHash(catalogCanonical(recordRefs)),
    limits:CATALOG_LIMITS,formatFingerprint:catalogHash(catalogCanonical({version:1,limits:CATALOG_LIMITS,schemas:catalogToolSchemas()}))}
}
export function createCatalogState(snapshot) {
  closedObject(snapshot,["schema","generation","receipt_key","brief","record_refs","records"])
  if (snapshot.schema!=="desk.factory.triage-catalog/1"||!hex.test(snapshot.generation)||!hex.test(snapshot.receipt_key)) fail()
  const raw=snapshot.records.slice(1).map((r,i)=>i<snapshot.brief.cards.length?{...r,text:JSON.parse(r.text).prepared_text}:r)
  validateRaw({brief:snapshot.brief,records:raw,recordRefs:snapshot.record_refs})
  const rebuilt=prepareTriageCatalog({brief:snapshot.brief,records:raw,recordRefs:snapshot.record_refs,generation:snapshot.generation})
  if (catalogCanonical(JSON.parse(rebuilt.snapshotBytes).records)!==catalogCanonical(snapshot.records)) fail()
  const privateRecords=structuredClone(snapshot.records)
  return {phase:"open",brief:structuredClone(snapshot.brief),catalog:new Map(privateRecords.map(r=>[r.id,r])),submission:null}
}
const obj = properties => ({type:"object",properties,required:Object.keys(properties),additionalProperties:false})
const str = {type:"string"}
const textSchema={type:"string",minLength:1,maxLength:1200}
const textArray={type:"array",items:textSchema,maxItems:16}
const nullableText={anyOf:[textSchema,{type:"null"}]}
const candidateSchema=obj({
  schema:{const:"desk.factory.triage-result/1"},batch:{type:"string",pattern:"^[a-f0-9]{16}$"},
  producer_version:{type:"string",maxLength:64},rubric_version:{type:"integer",minimum:1},
  results:{type:"array",maxItems:20,items:obj({
    key:textSchema,basis:textSchema,route:{enum:["agent_ready","investigate","human_decision"]},
    problem:textSchema,observed_impact:textSchema,unknowns:textArray,next_step:textSchema,
    authority:obj({code:{enum:["existing_scope","approved_plan","investigation_only","human_gate"]},ruling_ids:textArray}),
    evidence:textArray,related:textArray,duplicates:{type:"array",maxItems:16,items:obj({key:textSchema,evidence_ids:textArray})},
    decision:nullableText,gate_reason:{enum:["intent","scope","approval","voice","spend","account","irreversible",null]},
    recommendation:nullableText,safe_continuation:nullableText,
  })},
})
export function catalogToolSchemas() {
  const tools=[
    {name:"evidence_read",description:"Read one immutable prepared record by exact ID.",inputSchema:obj({id:{type:"string",pattern:"^r[0-9]{6}$"}}),outputSchema:obj({id:str,kind:{type:"string",enum:["brief","card","evidence","ruling"]},revision:{type:"integer",minimum:1},text:str})},
    {name:"evidence_search",description:"Case-sensitive literal search of prepared records.",inputSchema:{...obj({query:{type:"string",minLength:1,maxLength:256},ids:{type:"array",items:{type:"string",pattern:"^r[0-9]{6}$"},maxItems:320,uniqueItems:true}}),required:["query"]},
      outputSchema:obj({matches:{type:"array",items:obj({id:str,snippet:str}),maxItems:20},truncated:{type:"boolean"}})},
    {name:"evidence_list",description:"List a fixed page of prepared record IDs.",inputSchema:{...obj({cursor:{type:"integer",minimum:0,maximum:320}}),required:[]},
      outputSchema:obj({items:{type:"array",items:obj({id:str,kind:str,revision:{type:"integer",minimum:1}}),maxItems:20},next_cursor:{type:["integer","null"]}})},
    {name:"candidate_submit",description:"Seal one bounded candidate for protected parent validation; not acceptance.",inputSchema:obj({candidate:candidateSchema}),
      outputSchema:obj({receipt_id:str,candidate_sha256:str,valid_count:{type:"integer",minimum:1},refused_count:{type:"integer",minimum:0}})},
  ]
  return {tools,schemaSha256:catalogHash(catalogCanonical(tools))}
}
function snippet(text) {
  let out=""
  for (const ch of text) { if (Buffer.byteLength(out+ch)>256) break;out+=ch }
  return out
}
export function dispatchCatalogTool({name,args,requestId,state}) {
  if (!state||!["open","submitted"].includes(state.phase)||
      !(typeof requestId==="string"||Number.isSafeInteger(requestId))) fail()
  let result
  if (name==="evidence_read") {
    closedObject(args,["id"]);scalarText(args.id,7)
    if (!state.catalog.has(args.id)) fail()
    result=structuredClone(state.catalog.get(args.id))
  } else if (name==="evidence_list") {
    closedObject(args,[],["cursor"])
    const cursor=Object.hasOwn(args,"cursor")?args.cursor:0
    if (!Number.isSafeInteger(cursor)||cursor<0||cursor>state.catalog.size) fail()
    const records=[...state.catalog.values()],items=records.slice(cursor,cursor+20).map(({id,kind,revision})=>({id,kind,revision}))
    result={items,next_cursor:cursor+items.length<records.length?cursor+items.length:null}
  } else if (name==="evidence_search") {
    closedObject(args,["query"],["ids"]);scalarText(args.query,256)
    if (!args.query) fail()
    if (args.ids!==undefined && (!Array.isArray(args.ids)||args.ids.length>320||new Set(args.ids).size!==args.ids.length||args.ids.some(id=>!state.catalog.has(id)))) fail()
    const selected=args.ids===undefined?null:new Set(args.ids),hits=[]
    for (const r of state.catalog.values()) if ((!selected||selected.has(r.id))&&r.text.includes(args.query)) hits.push({id:r.id,snippet:snippet(r.text)})
    result={matches:hits.slice(0,20),truncated:hits.length>20}
  } else if (name==="candidate_submit") {
    closedObject(args,["candidate"])
    const encoded=catalogCanonical(args.candidate)
    boundedCatalogBytes(encoded,331776)
    const validated=validateTriageResultBytes(encoded,{brief:state.brief})
    if (validated.valid.length===0) fail()
    const candidate_sha256=catalogHash(encoded)
    if (state.submission) {
      if (encoded!==state.submission.bytes) fail()
      return {result:{...state.submission.result},state}
    }
    result={receipt_id:randomBytes(16).toString("hex"),candidate_sha256,valid_count:validated.valid.length,refused_count:validated.refused.length}
    const submitReceipt={rpc_id:requestId,receipt_id:result.receipt_id,candidate_sha256,candidate:JSON.parse(encoded),
      refused:validated.refused.map(r=>({index:r.index,codes:r.errors.map(e=>e.code)}))}
    state.submission={bytes:encoded,result:{...result},receipt:submitReceipt};state.phase="submitted"
    return {result,state,submitReceipt}
  } else fail()
  return {result,state}
}
export async function safeCatalogPath(file,kind="file",mode=0o600) {
  if (!path.isAbsolute(file)||path.resolve(file)!==file||await fs.realpath(path.dirname(file))!==path.dirname(file)) fail()
  const stat=await fs.lstat(file)
  if ((kind==="directory"?!stat.isDirectory():kind==="fifo"?!stat.isFIFO():!stat.isFile()) ||
      stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==mode ||
      (kind==="file"&&stat.nlink!==1)) fail()
  return {dev:stat.dev,ino:stat.ino,uid:stat.uid,mode:stat.mode,nlink:stat.nlink,size:stat.size}
}
export async function writeTriagePreparedFile({inputDir,brief,records,recordRefs}) {
  validateRaw({brief,records,recordRefs})
  await assertOutsideGitWorkspace(inputDir,{label:"triage catalog",subject:"prepared input"})
  await safeCatalogPath(inputDir,"directory",0o700)
  const encoded=catalogCanonical({schema:"desk.factory.triage-prepared/1",brief,records,record_refs:recordRefs})
  boundedCatalogBytes(encoded,6291456)
  const file=path.join(inputDir,"triage-prepared.json"),fd=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try {await fd.writeFile(encoded);await fd.sync()} finally {await fd.close()}
  return {path:file,sha256:catalogHash(encoded)}
}
export async function readTriagePreparedFile({inputDir}) {
  await safeCatalogPath(inputDir,"directory",0o700)
  const file=path.join(inputDir,"triage-prepared.json"),before=await safeCatalogPath(file)
  if (before.size>6291456) fail()
  const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  let encoded
  try {
    const stat=await fd.stat();if(stat.dev!==before.dev||stat.ino!==before.ino) fail()
    encoded=await fd.readFile();if(encoded.length!==before.size) fail()
  } finally {await fd.close()}
  const text=new TextDecoder("utf-8",{fatal:true}).decode(encoded),value=JSON.parse(text)
  if (catalogCanonical(value)!==text) fail()
  closedObject(value,["schema","brief","records","record_refs"])
  if(value.schema!=="desk.factory.triage-prepared/1") fail()
  validateRaw({brief:value.brief,records:value.records,recordRefs:value.record_refs})
  if(catalogCanonical(await safeCatalogPath(file))!==catalogCanonical(before)) fail()
  return {brief:value.brief,records:value.records,recordRefs:value.record_refs,path:file,sha256:catalogHash(encoded),identity:before}
}
