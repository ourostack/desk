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

test("an initially untracked companion cannot disappear between sequential Git preflight reads",async () => {
  const f = await archiveFixture(), note = path.join(f.source,"foreign-note.txt")
  await fs.writeFile(note,"OWNED_OUTSIDE_WRITER_PAYLOAD\n")
  let injected = false, expectedIndex = f.index, result, failure
  const spawnGit = (command,args,options) => {
    const answer = spawnSync(command,args,options)
    if (!injected && args[2] === "diff" && args.includes("--cached") && args.at(-1) === "t/mode-proof") {
      git(f.root,"add","--","t/mode-proof/foreign-note.txt")
      expectedIndex = git(f.root,"ls-files","-s")
      injected = true
    }
    return answer
  }
  try {
    result = await task_archive({ deskRoot:f.root,input:{track:"t",slug:"mode-proof"},spawnGit,schedulePush:() => {} })
  } catch (error) { failure = error }
  assert.ok(failure,`the unadmitted companion must refuse before relocation, not ${result?.status}`)
  assert.ok(await fs.stat(f.source))
  await assert.rejects(fs.lstat(f.destination),{code:"ENOENT"})
  assert.equal(await fs.readFile(note,"utf8"),"OWNED_OUTSIDE_WRITER_PAYLOAD\n")
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),expectedIndex)
})

test("plain filesystem archives still fence payloads without Git",async () => {
  const f = await plainFixture(), state = await prepare(f)
  assert.equal(state.git,null)
  await move(f,state)
  await state.cardWritten("owned card\n")
  assert.equal(await state.publish("archive"),undefined)
  assert.deepEqual(await archivePublicationState({effectiveRoot:f.root,srcDir:f.source,archiveDir:f.destination,spawnGit:spawnSync}),
    {status:"not_git"})
})

test("an unborn Git desk can publish its first archived card",async () => {
  const f = await plainFixture()
  git(f.root,"init","-q","-b","main")
  git(f.root,"config","user.name","Owned archive boundary")
  git(f.root,"config","user.email","archive-boundary@example.invalid")
  const state = await prepare(f)
  assert.equal(state.git.head,null)
  await move(f,state)
  assert.equal(await state.publish("first archive"),undefined)
  assert.match(git(f.root,"ls-tree","-r","HEAD"),/archive\/source\/task\.md/u)
})

test("a logical desk root alias publishes the archive in its physical Git repository",async () => {
  const f = await archiveFixture(), aliases = await mkTempDeskRoot(), root = path.join(aliases,"desk")
  const physical = await fs.realpath(f.root)
  await fs.symlink(physical,root,process.platform === "win32" ? "junction" : "dir")
  assert.notEqual(path.resolve(root),physical)
  assert.equal(await fs.realpath(root),physical)
  const result = await task_archive({deskRoot:root,input:{track:"t",slug:"mode-proof"},schedulePush:() => {}})
  assert.equal(result.status,"archived")
  assert.equal(result.path,"t/_archive/mode-proof/task.md")
  await assert.rejects(fs.lstat(f.source),{code:"ENOENT"})
  assert.equal(await fs.readFile(path.join(f.destination,"companion.txt"),"utf8"),"peer.txt")
  assert.notEqual(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"status","--porcelain"),"")
  assert.match(git(f.root,"ls-tree","-r","HEAD"),/t\/_archive\/mode-proof\/companion\.txt/u)
  assert.doesNotMatch(git(f.root,"ls-tree","-r","HEAD"),/t\/mode-proof\//u)
})

for (const [name,match,answer,message] of [
  ["Git top-level lookup",a => a[2] === "rev-parse" && a[3] === "--show-toplevel",failed,/precondition unavailable/u],
  ["initial HEAD lookup",a => a[2] === "rev-parse" && a[3] === "--verify",failed,/HEAD could not be qualified/u],
  ["Git policy read",a => a[2] === "config",failed,/could not be qualified/u],
  ["malformed Git policy",a => a[2] === "config",{status:0,stdout:"maybe\n",stderr:""},/could not be qualified/u],
  ["source index read",a => a[2] === "ls-files" && a.includes("-s") && a.at(-1) === sourceRelative,failed,/source index conflicts/u],
  ["destination index read",a => a[2] === "ls-files" && a.includes("-s") && a.at(-1) === archiveRelative,failed,/destination index state is unavailable/u],
]) test(`preflight refuses an unqualified ${name}`,async () => {
  const f = await archiveFixture()
  await assert.rejects(prepare(f,{spawnGit:failedGit(match,answer)}),message)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.ok(await fs.stat(f.source))
})

test("unset Git mode/type policies retain Git's true default",async () => {
  const f = await archiveFixture()
  const state = await prepare(f,{spawnGit:failedGit(a => a[2] === "config",{status:1,stdout:"",stderr:""})})
  assert.equal(state.git.fileMode,true)
  assert.equal(state.git.symlinks,true)
  await state.atUse()
})

for (const [name,mode,stage] of [["conflict","100644","2"],["submodule","160000","0"]])
  test(`a source ${name} is not admitted`,async () => {
    const f = await archiveFixture()
    const spawnGit = failedGit(a => a[2] === "ls-files" && a.includes("-s") && a.at(-1) === sourceRelative,
      {status:0,stdout:`${mode} ${f.sha} ${stage}\t${sourceRelative}/companion.txt\0`,stderr:""})
    await assert.rejects(prepare(f,{spawnGit}),/source index conflicts\/submodules/u)
    assert.equal(git(f.root,"ls-files","-s"),f.index)
  })

test("a destination staged deletion still occupies the archived HEAD namespace",async () => {
  const f = await archiveFixture(), relative = `${archiveRelative}/held.txt`
  await fs.mkdir(f.destination)
  await fs.writeFile(path.join(f.destination,"held.txt"),"outside retained\n")
  git(f.root,"add","--",relative)
  git(f.root,"commit","-q","-m","owned destination baseline")
  await fs.rename(f.destination,path.join(f.root,"retained-destination"))
  git(f.root,"add","-u","--",relative)
  const index = git(f.root,"ls-files","-s")
  await assert.rejects(prepare(f),/occupied in HEAD or the index/u)
  assert.equal(git(f.root,"ls-files","-s"),index)
})

for (const when of ["atUse","publish"]) test(`source index changes are retained and refuse at ${when}`,async () => {
  const f = await archiveFixture(), state = await prepare(f)
  if (when === "publish") await move(f,state)
  git(f.root,"update-index","--cacheinfo",`100755,${f.sha},${sourceRelative}/companion.txt`)
  const index = git(f.root,"ls-files","-s")
  await assert.rejects(when === "atUse" ? state.atUse() : state.publish("archive"),/source index changed/u)
  assert.equal(git(f.root,"ls-files","-s"),index)
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
})

for (const [name,mutate,message] of [
  ["new payload",f => fs.writeFile(path.join(f.source,"new.txt"),"outside\n"),/source changed/u],
  ["changed payload",f => fs.writeFile(f.file,"outside\n"),/source changed/u],
  ["appearing destination",f => fs.mkdir(f.destination),/other archive path appeared/u],
  ["changed HEAD",async f => { git(f.root,"commit","--allow-empty","-q","-m","outside HEAD") },/HEAD changed/u],
  ["changed mode policy",async f => { git(f.root,"config","core.filemode","false") },/mode\/type policy changed/u],
  ["changed link policy",async f => { git(f.root,"config","core.symlinks","false") },/mode\/type policy changed/u],
]) test(`at-use fence refuses ${name}`,async () => {
  const f = await archiveFixture(), state = await prepare(f)
  await mutate(f)
  const index = git(f.root,"ls-files","-s")
  await assert.rejects(state.atUse(),message)
  assert.equal(git(f.root,"ls-files","-s"),index)
  assert.ok(await fs.stat(f.source))
})

test("replaced destination ancestry is detected before the move",async () => {
  const f = await archiveFixture(), state = await prepare(f), parent = path.dirname(f.destination)
  await fs.rename(parent,path.join(f.root,"retained-archive-parent"))
  await fs.mkdir(parent)
  await assert.rejects(state.atUse(),/ancestor identity changed/u)
  assert.ok(await fs.stat(f.source))
})

test("destination ancestry cannot resolve outside the effective desk",async () => {
  const f = await plainFixture(), outside = await mkTempDeskRoot(), parent = path.dirname(f.destination)
  await fs.rename(parent,path.join(f.root,"retained-archive-parent"))
  await fs.symlink(outside,parent,process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(prepare(f),/ancestry is outside/u)
  assert.deepEqual(await fs.readdir(outside),[])
})

test("non-ENOENT filesystem admission failures propagate",async t => {
  const f = await plainFixture(), lstat = fs.lstat, physical = await fs.realpath(f.root)
  t.mock.method(fs,"lstat",async (file,...args) => {
    if (file === path.join(physical,".git")) throw Object.assign(new Error("CONTROLLED_ACCESS_DENIED"),{code:"EACCES"})
    return lstat(file,...args)
  })
  await assert.rejects(prepare(f),{code:"EACCES"})
})

test("unsupported filesystem companion types are explicitly refused",async t => {
  const f = await plainFixture(), file = path.join(f.source,"task.md"), lstat = fs.lstat
  t.mock.method(fs,"lstat",async (target,...args) => {
    const stat = await lstat(target,...args)
    return target === file
      ? Object.assign(Object.create(stat),{isFile:() => false,isSymbolicLink:() => false}) : stat
  })
  await assert.rejects(prepare(f),/unsupported companion type/u)
})

test("a payload write during admission is refused even when filesystem timestamps have not advanced",async t => {
  const f = await plainFixture(), file = path.join(f.source,"task.md"), readFile = fs.readFile, lstat = fs.lstat
  const admitted = await lstat(file,{bigint:true})
  let injected = false
  t.mock.method(fs,"lstat",async (target,...args) => {
    const stat = await lstat(target,...args)
    return target === file
      ? Object.assign(Object.create(stat),{mtimeNs:admitted.mtimeNs,ctimeNs:admitted.ctimeNs}) : stat
  })
  t.mock.method(fs,"readFile",async (target,...args) => {
    const bytes = await readFile(target,...args)
    if (target === file && !injected) {
      injected = true
      await fs.appendFile(file,"OUTSIDE_DURING_READ\n")
    }
    return bytes
  })
  await assert.rejects(prepare(f),/source changed while its bytes/u)
  assert.equal(injected,true)
  assert.ok((await lstat(file,{bigint:true})).size > admitted.size)
  assert.match(await readFile(file,"utf8"),/OUTSIDE_DURING_READ/u)
})

for (const when of ["afterMove","publish"]) test(`relocated payload changes refuse at ${when}`,async () => {
  const f = await archiveFixture(), state = await prepare(f)
  await move(f,state)
  await fs.appendFile(path.join(f.destination,"companion.txt"),"OUTSIDE_RELOCATED\n")
  await assert.rejects(when === "afterMove" ? state.afterMove() : state.publish("archive"),/relocated (payload|bytes) changed/u)
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
})

test("card acknowledgement rejects bytes other than the actual patched card",async () => {
  const f = await plainFixture(), state = await prepare(f)
  await move(f,state)
  await assert.rejects(state.cardWritten("not actual\n"),/card bytes changed during its patch/u)
})

for (const [name,mutate] of [
  ["missing source index",async f => { git(f.root,"update-index","--force-remove",`${sourceRelative}/task.md`) }],
  ["missing relocated card",f => fs.rename(path.join(f.destination,"task.md"),path.join(f.root,"retained-task.md"))],
  ["different relocated bytes",f => fs.writeFile(path.join(f.destination,"companion.txt"),"outside\n")],
]) test(`interrupted admission refuses ${name}`,async () => {
  const f = await archiveFixture({relocated:true})
  await mutate(f)
  await assert.rejects(prepare(f,{relocated:true}),/unchanged source HEAD\/index|missing a tracked source file|relocated bytes differ/u)
  assert.ok(await fs.stat(f.destination))
})

test("a nonregular track card cannot be patched",async () => {
  const f = await plainFixture(), file = path.join(f.root,"track")
  await fs.mkdir(file)
  await assert.rejects(prepare(f,{trackPlan:{file,before:"",after:""}}),/requires a regular track card/u)
})

for (const kind of ["dirty","staged","untracked"]) test(`${kind} track edits are not adopted`,async () => {
  const f = await archiveFixture(), trackPlan = await trackFixture(f)
  if (kind === "untracked") git(f.root,"update-index","--force-remove","t/track.md")
  else {
    await fs.appendFile(trackPlan.file,"OUTSIDE_TRACK\n")
    if (kind === "staged") git(f.root,"add","--","t/track.md")
  }
  const index = git(f.root,"ls-files","-s")
  await assert.rejects(prepare(f,{trackPlan}),/track row\/link has outside edits/u)
  assert.equal(git(f.root,"ls-files","-s"),index)
})
