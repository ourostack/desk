import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { taskFocus } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { createFocusHolder } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"
import { archiveFixture, git } from "./_archive_state_helpers.js"

const target = {track:"t",slug:"owned-work"}
const evidence = {kind:"non_code",ref:"https://example.invalid/owned-proof"}
const noPush = () => {}

async function fixture(person = null) {
  const root = await mkTempDeskRoot()
  await task_create({deskRoot:root,person,input:{...target,title:"Owned work",status:"processing"},schedulePush:noPush})
  const prefix = person === null ? root : path.join(root,"desks",person)
  return {root,prefix,file:path.join(prefix,"t","owned-work","task.md")}
}

const update = (f,input,extra = {}) => task_update({deskRoot:f.root,input:{...target,...input},schedulePush:noPush,...extra})
const focus = (f,extra = {}) => taskFocus({deskRoot:f.root,input:target,...extra})

function assertDue(result,key = target) {
  assert.deepEqual(result.archive_due,key)
  assert.match(result.archive_next_action,/owning main agent/u)
  assert.match(result.archive_next_action,/task_archive/u)
  assert.match(result.archive_next_action,/before final delivery/u)
  assert.match(result.archive_next_action,/archive_pending/u)
  assert.match(result.archive_next_action,/unsigned/u)
}

function assertNotDue(result) {
  assert.equal(Object.hasOwn(result,"archive_due"),false)
  assert.equal(Object.hasOwn(result,"archive_next_action"),false)
}

for (const status of ["done","cancelled"]) test(`a live ${status} update advises archival without performing it`,async () => {
  const f = await fixture()
  const result = await update(f,{frontmatter:{status},...(status === "done" ? {evidence} : {})})
  assert.equal(result.status,"updated")
  assertDue(result)
  assert.equal((await readFront(f.file)).data.status,status)
  await assert.rejects(fs.lstat(path.join(f.prefix,"t","_archive","owned-work")),{code:"ENOENT"})
  assertDue(await update(f,{status}))
})

test("explicit terminal focus and resumed reinspection are read-only archive advice",async () => {
  const f = await archiveFixture(), key = {track:"t",slug:"mode-proof"}
  const file = path.join(f.source,"task.md"), bytes = await fs.readFile(file)
  const statusContext = {focus:createFocusHolder()}
  const first = await taskFocus({deskRoot:f.root,input:key,statusContext})
  assertDue(first,key)
  assert.deepEqual(statusContext.focus.get(),key)
  const resumed = await taskFocus({deskRoot:f.root,input:key,statusContext:{focus:createFocusHolder()}})
  assertDue(resumed,key)
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.deepEqual(await fs.readFile(file),bytes)
})

for (const status of ["processing","mystery","",null]) test(`focus has no archive advice for ${JSON.stringify(status)} status`,async () => {
  const f = await fixture()
  await fs.writeFile(f.file,`---\nstatus: ${JSON.stringify(status)}\n---\n\nOwned body.\n`)
  const before = await fs.readFile(f.file)
  assertNotDue(await focus(f))
  assert.deepEqual(await fs.readFile(f.file),before)
})

test("ordinary nonterminal updates keep their recorded next step and have no archive advice",async () => {
  const f = await fixture()
  const result = await update(f,{note:"Still working",next_step:"Verify owned work"})
  assertNotDue(result)
  assert.equal(result.next_step,"Verify owned work")
  assert.equal((await focus(f)).next_step,"Verify owned work")
})

test("another held focus is not changed or represented as archive ownership",async () => {
  const f = await fixture(), held = {track:"peer-track",slug:"peer-work"}, holder = createFocusHolder()
  holder.set(held)
  const result = await update(f,{status:"cancelled"},{statusContext:{focus:holder}})
  assertDue(result)
  assert.match(result.focus_note,/focused on peer-track\/peer-work/u)
  assert.deepEqual(holder.get(),held)
  assert.equal(result.accepted,undefined)
})

test("crew archive advice uses only the task key in the server's bound person",async () => {
  const f = await fixture("owner")
  assertDue(await update(f,{status:"cancelled"},{person:"owner"}))
  const result = await callTool({deskRoot:f.root,person:"owner",name:"task_focus",input:target})
  assert.equal(result.isError,undefined)
  assertDue(JSON.parse(result.content[0].text))
  await assert.rejects(focus(f,{person:"other"}),/card not found/u)
  assert.equal(await fs.readFile(f.file,"utf8").then(text => text.includes("status: cancelled")),true)
})

test("a successful explicit archive clears advice without altering evidence or unsigned delivery",async () => {
  const f = await fixture()
  const delivered = await update(f,{status:"done",evidence})
  assertDue(delivered)
  assert.equal(delivered.signoff,"delivered_unsigned")
  assert.deepEqual(delivered.signoff_packet,["Asked: Owned work",`Delivered: ${evidence.ref}`,"Accept or send back?"])
  const before = (await readFront(f.file)).data
  assert.equal(before.signoff.state,"delivered_unsigned")
  assert.equal(before.flow.deliveries,1)
  const archived = await task_archive({deskRoot:f.root,input:target,schedulePush:noPush})
  assert.equal(archived.status,"archived")
  assert.deepEqual(archived.signoff_packet,delivered.signoff_packet)
  const result = await focus(f)
  assert.equal(result.archived,true)
  assertNotDue(result)
  const after = (await readFront(path.join(f.prefix,"t","_archive","owned-work","task.md"))).data
  for (const field of ["evidence","delivery","job_id","flow","signoff","accepted","factory_report","factory_report_unavailable"])
    assert.deepEqual(after[field],before[field],`${field} is not recreated by archive advice`)
  assertNotDue(await task_archive({deskRoot:f.root,input:target,schedulePush:noPush}))
})

test("an archive refusal leaves live terminal advice available rather than claiming the move",async () => {
  const f = await archiveFixture(), key = {track:"t",slug:"mode-proof"}
  await fs.writeFile(path.join(f.source,"outside.txt"),"OUTSIDE_BYTES\n")
  await assert.rejects(task_archive({deskRoot:f.root,input:key,schedulePush:noPush}),/untracked companion/u)
  assertDue(await taskFocus({deskRoot:f.root,input:key}),key)
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.equal(await fs.readFile(path.join(f.source,"outside.txt"),"utf8"),"OUTSIDE_BYTES\n")
})

test("an interrupted publication retains its own pending action, not a fresh live-task cue",async () => {
  const f = await archiveFixture(), key = {track:"t",slug:"mode-proof"}
  const spawnGit = (command,args,options) => args[2] === "commit"
    ? {status:1,stdout:"",stderr:"CONTROLLED_ARCHIVE_COMMIT_FAILURE"} : spawnSync(command,args,options)
  const result = await task_archive({deskRoot:f.root,input:key,spawnGit,schedulePush:() => assert.fail("failed publication is not pushed")})
  assert.equal(result.status,"archive_pending")
  assert.match(result.next_action,/do not repeat the directory move/u)
  assertNotDue(result)
  const inspected = await taskFocus({deskRoot:f.root,input:key})
  assert.equal(inspected.archived,true)
  assertNotDue(inspected)
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
})

test("terminal archive advice does not add a second Git commit or push",async () => {
  const f = await archiveFixture()
  const before = Number(git(f.root,"rev-list","--count","HEAD")), pushes = []
  const result = await task_update({deskRoot:f.root,input:{track:"t",slug:"mode-proof",status:"done",note:"Owned terminal note"},
    schedulePush:request => pushes.push(request)})
  assertDue(result,{track:"t",slug:"mode-proof"})
  assert.equal(Number(git(f.root,"rev-list","--count","HEAD")),before+1)
  assert.deepEqual(pushes,[{root:f.root}])
  assert.equal(git(f.root,"status","--porcelain"),"")
  assert.ok(await fs.stat(f.source))
  await assert.rejects(fs.lstat(f.destination),{code:"ENOENT"})
})
