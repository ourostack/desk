// archive_state_boundaries, continued: the same suite as archive_state_boundaries.test.js, split so no single file sets a Windows shard's time.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { task_archive, task_create } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import {
  prepareArchiveState, prepareArchivedCardPublication, archivePublicationState, qualifyArchiveFailure,
} from "../../../../../plugins/desk/mcp/src/tools/archive-state.js"
import { archiveFixture,git } from "./_archive_state_helpers.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { beforeLanding } from "../_index_commit_seam.js"

const prepare = (f,extra = {}) => prepareArchiveState({
  effectiveRoot:f.root,srcDir:f.source,archiveDir:f.destination,srcFile:path.join(f.source,"task.md"),
  spawnGit:spawnSync,...extra,
})
const sourceRelative = "t/mode-proof"
const archiveRelative = "t/_archive/mode-proof"
const failedGit = (matches,answer) => (command,args,options) =>
  matches(args) ? answer : spawnSync(command,args,options)
const failed = { status:128,stdout:"",stderr:"CONTROLLED_GIT_FAILURE" }

async function plainFixture() {
  const root = await mkTempDeskRoot(), source = path.join(root,"source"), destination = path.join(root,"archive","source")
  await fs.mkdir(source)
  await fs.mkdir(path.dirname(destination))
  await fs.writeFile(path.join(source,"task.md"),"owned card\n")
  return {root,source,destination}
}

async function move(f,state) {
  await state.atUse()
  await fs.rename(f.source,f.destination)
  await state.afterMove()
}

async function trackFixture(f) {
  const file = path.join(f.root,"t","track.md"), before = "owned track\n", after = "archived track\n"
  await fs.writeFile(file,before)
  git(f.root,"add","--","t/track.md")
  git(f.root,"commit","-q","-m","owned track baseline")
  return {file,before,after}
}

test("a track write after preflight is retained",async () => {
  const f = await archiveFixture(), trackPlan = await trackFixture(f), state = await prepare(f,{trackPlan})
  await fs.appendFile(trackPlan.file,"OUTSIDE_TRACK\n")
  await assert.rejects(state.assertTrack(),/track changed after preflight/u)
  assert.match(await fs.readFile(trackPlan.file,"utf8"),/OUTSIDE_TRACK/u)
})

test("publication requires the exact admitted track update",async () => {
  const f = await archiveFixture(), trackPlan = await trackFixture(f), state = await prepare(f,{trackPlan})
  await move(f,state)
  await assert.rejects(state.publish("archive"),/track changed before publication/u)
  await fs.writeFile(trackPlan.file,trackPlan.after)
  assert.equal(await state.publish("archive"),undefined)
  assert.equal(await fs.readFile(trackPlan.file,"utf8"),trackPlan.after)
  assert.equal(git(f.root,"status","--porcelain"),"")
})

test("archived report patches without Git retain the same target and exact bytes",async () => {
  const f = await plainFixture(), file = path.join(f.source,"task.md")
  const state = await prepareArchivedCardPublication({effectiveRoot:f.root,file,before:"owned card\n",spawnGit:spawnSync})
  await state.assertBefore()
  assert.equal(await state.retainedTarget(),await fs.realpath(file))
  await fs.writeFile(file,"patched\n")
  assert.equal(await state.publish("patched\n","report"),undefined)
  assert.equal((await state.publish("different\n","report")).status,"failed")
})

test("archived report admission refuses outside and nonregular targets",async () => {
  const f = await plainFixture(), outside = await mkTempDeskRoot(), file = path.join(outside,"task.md")
  await fs.writeFile(file,"outside\n")
  await assert.rejects(prepareArchivedCardPublication({effectiveRoot:f.root,file,before:"outside\n",spawnGit:spawnSync}),/outside the effective desk/u)
  await assert.rejects(prepareArchivedCardPublication({effectiveRoot:f.root,file:f.source,before:"",spawnGit:spawnSync}),/not a regular file/u)
})

test("report target changes and disappearance are not silently treated as retained",async () => {
  const f = await plainFixture(), file = path.join(f.source,"task.md")
  const state = await prepareArchivedCardPublication({effectiveRoot:f.root,file,before:"owned card\n",spawnGit:spawnSync})
  await fs.writeFile(file,"outside edit\n")
  await assert.rejects(state.assertBefore(),/changed before its report patch/u)
  await fs.rename(file,path.join(f.root,"retained-card"))
  assert.equal(await state.retainedTarget(),null)
  await fs.writeFile(file,"replacement\n")
  assert.equal(await state.retainedTarget(),null)
})

test("publication status distinguishes a clean move from retained dirt and Git read failure",async () => {
  const f = await archiveFixture(), args = {effectiveRoot:f.root,srcDir:f.source,archiveDir:f.destination,spawnGit:spawnSync}
  assert.equal((await archivePublicationState(args)).status,"pending")
  const state = await prepare(f)
  await move(f,state)
  assert.equal(await state.publish("archive"),undefined)
  assert.equal((await archivePublicationState(args)).status,"published")
  await fs.writeFile(path.join(f.destination,"outside.txt"),"outside\n")
  assert.equal((await archivePublicationState(args)).status,"pending")
  assert.equal((await archivePublicationState({...args,spawnGit:failedGit(a => a[2] === "ls-files",failed)})).status,"unknown")
  assert.equal((await archivePublicationState({...args,spawnGit:failedGit(a => a[2] === "rev-parse",failed)})).status,"unknown")
})

for (const [moved,published,phase] of [
  [false,false,"not_moved"],[true,false,"relocated_publication_unconfirmed"],[true,true,"archived_publication_complete"],
]) test(`archive failure retains the qualified ${phase} location`,async () => {
  const f = await plainFixture(), stat = await fs.lstat(f.source,{bigint:true})
  const sourceIdentity = `${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`
  if (moved) await fs.rename(f.source,f.destination)
  const error = await qualifyArchiveFailure(new Error("controlled failure"),{effectiveRoot:f.root,srcDir:f.source,
    archiveDir:f.destination,sourceIdentity,moved,published})
  assert.equal(error.archive_phase,phase)
  assert.equal(error.actual_path,path.join(await fs.realpath(moved ? f.destination : f.source),"task.md"))
  assert.equal(error.path,error.actual_path)
  assert.match(error.message,/no rollback or unknown publication/u)
})

test("unknown archive location is explicit rather than an invented recovery target",async () => {
  const f = await plainFixture()
  const error = await qualifyArchiveFailure(new Error("controlled failure"),{effectiveRoot:f.root,srcDir:f.source,
    archiveDir:f.destination,sourceIdentity:"unmatched",moved:false,published:false})
  assert.equal(error.archive_phase,"relocation_outcome_uncertain")
  assert.equal(error.actual_path,null)
  assert.equal(error.last_known_path,path.join(f.destination,"task.md"))
})

test("physical Git paths publish without adopting a logical alias",async () => {
  const f = await archiveFixture(), root = await fs.realpath(f.root)
  const physical = {...f,root,source:path.join(root,sourceRelative),destination:path.join(root,archiveRelative)}
  const state = await prepare(physical)
  await move(physical,state)
  assert.equal(await state.publish("physical archive"),undefined)
  assert.equal(git(root,"status","--porcelain"),"")
})

test("source Git paths cannot escape their effective desk",async () => {
  const f = await archiveFixture(), outside = await plainFixture()
  await assert.rejects(prepare(f,{srcDir:outside.source}),/Git path leaves the effective desk/u)
  assert.equal(await fs.readFile(path.join(outside.source,"task.md"),"utf8"),"owned card\n")
})

for (const [answer,message] of [
  [{status:null,stdout:"",stderr:"",error:{code:"ETIMEDOUT"}},/ETIMEDOUT/u],
  [{status:127,stdout:"",stderr:""},/127/u],
]) test(`Git read failure retains ${message.source} diagnostics`,async () => {
  const f = await archiveFixture()
  await assert.rejects(prepare(f,{spawnGit:failedGit(a => a[2] === "rev-parse" && a[3] === "--show-toplevel",answer)}),message)
})

test("a malformed clean blob response cannot qualify a source companion",async () => {
  const f = await archiveFixture()
  await assert.rejects(prepare(f,{spawnGit:failedGit(a => a[2] === "hash-object",
    {status:0,stdout:"not-a-blob\n",stderr:""})}),/qualified clean blob/u)
})

for (const answer of [failed,{status:1,stdout:"",stderr:""}])
  test(`at-use HEAD qualification refuses status ${answer.status}`,async () => {
    const f = await archiveFixture()
    let active = false
    const spawnGit = (command,args,options) => active && args[2] === "rev-parse" && args[3] === "--verify"
      ? answer : spawnSync(command,args,options)
    const state = await prepare(f,{spawnGit})
    active = true
    await assert.rejects(state.atUse(),/current HEAD could not be qualified|HEAD changed/u)
  })

test("publication refuses a HEAD advance after the actual move",async () => {
  const f = await archiveFixture(), state = await prepare(f)
  await move(f,state)
  git(f.root,"commit","--allow-empty","-q","-m","outside HEAD")
  const head = git(f.root,"rev-parse","HEAD")
  await assert.rejects(state.publish("archive"),/HEAD changed before publication/u)
  assert.equal(git(f.root,"rev-parse","HEAD"),head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
})

for (const fault of ["stage failure","missing stage","wrong stage","metadata readback","metadata stderr","metadata error","metadata status","commit failure"])
  test(`publication reports ${fault} without claiming a commit`,async () => {
    const metadata = fault.startsWith("metadata")
    const f = await archiveFixture(metadata ? {filemode:false,mode:"100755"} : {})
    let active = false, staged = false, updated = false, intercepted = false
    const spawnGit = (command,args,options) => {
      if (!active) return spawnSync(command,args,options)
      if (args[2] === "add") {
        staged = true
        if (fault === "stage failure") { intercepted = true; return failed }
      }
      if (staged && args[2] === "ls-files" && args.includes("-s")) {
        if (fault === "missing stage") { intercepted = true; return failed }
        if (fault === "wrong stage" || (fault === "metadata readback" && updated)) {
          intercepted = true
          return {status:0,stdout:"",stderr:""}
        }
      }
      if (args[2] === "update-index" && !options.env?.GIT_INDEX_FILE) {
        updated = true
        if (fault === "metadata stderr") { intercepted = true; return failed }
        if (fault === "metadata error") {
          intercepted = true
          return {status:null,stdout:"",stderr:"",error:{code:"EIO"}}
        }
        if (fault === "metadata status") { intercepted = true; return {status:1,stdout:"",stderr:""} }
      }
      // The archive's commit is refused before it lands: its pre-commit step (#632 commits without `git commit`).
      if (beforeLanding(args) && fault === "commit failure") { intercepted = true; return failed }
      return spawnSync(command,args,options)
    }
    const state = await prepare(f,{spawnGit})
    await move(f,state)
    active = true
    const result = await state.publish("archive")
    assert.equal(intercepted,true,`the ${fault} boundary must actually be exercised`)
    assert.equal(result?.status,"failed")
    assert.ok(result.reason)
    assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
    assert.ok(await fs.stat(f.destination))
  })

test("missing archive ancestors are qualified when they are later created inside the desk",async () => {
  const f = await plainFixture()
  f.destination = path.join(f.root,"new-parent","nested","task")
  const state = await prepare(f)
  await fs.mkdir(path.dirname(f.destination),{recursive:true})
  await move(f,state)
  assert.equal(await state.publish("archive"),undefined)
})

test("a newly created ancestor resolving outside the desk fails the late ancestry fence",async () => {
  const f = await plainFixture(), outside = await mkTempDeskRoot()
  f.destination = path.join(f.root,"late-parent","task")
  const state = await prepare(f)
  await fs.symlink(outside,path.dirname(f.destination),process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(state.atUse(),/ancestry is outside/u)
  assert.deepEqual(await fs.readdir(outside),[])
})

for (const output of [null,"","100644 SHA 2","120000 SHA 0"])
  test(`track publication requires an unconflicted regular index entry (${output})`,async () => {
    const f = await archiveFixture(), trackPlan = await trackFixture(f)
    const answer = output === null ? failed :
      {status:0,stdout:output ? `${output.replace("SHA",f.sha)}\tt/track.md\0` : "",stderr:""}
    const spawnGit = failedGit(a => a[2] === "ls-files" && a.includes("-s") && a.at(-1) === "t/track.md",answer)
    await assert.rejects(prepare(f,{trackPlan,spawnGit}),/track's regular Git file state/u)
  })

for (const output of [null,"","100644 SHA 2","120000 SHA 0"])
  test(`report publication requires an unconflicted regular index entry (${output})`,async () => {
    const f = await archiveFixture(), file = path.join(f.source,"task.md")
    const answer = output === null ? failed :
      {status:0,stdout:output ? `${output.replace("SHA",f.sha)}\t${sourceRelative}/task.md\0` : "",stderr:""}
    await assert.rejects(prepareArchivedCardPublication({effectiveRoot:f.root,file,before:f.card,
      spawnGit:failedGit(a => a[2] === "ls-files" && a.includes("-s"),answer)}),/archived card Git state/u)
  })

test("a clean tracked report card is patched and actually committed",async () => {
  const f = await archiveFixture(), file = path.join(f.source,"task.md")
  const state = await prepareArchivedCardPublication({effectiveRoot:f.root,file,before:f.card,spawnGit:spawnSync})
  await state.assertBefore()
  const bytes = Buffer.concat([f.card,Buffer.from("\nowned report\n")])
  await fs.writeFile(file,bytes)
  assert.equal(await state.publish(bytes,"owned report"),undefined)
  assert.notEqual(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"status","--porcelain"),"")
})
