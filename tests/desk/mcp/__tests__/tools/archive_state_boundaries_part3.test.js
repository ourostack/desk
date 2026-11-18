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

for (const kind of ["dirty","staged"]) test(`report admission retains ${kind} outside edits`,async () => {
  const f = await archiveFixture(), file = path.join(f.source,"task.md")
  await fs.appendFile(file,"\nOUTSIDE_REPORT\n")
  if (kind === "staged") git(f.root,"add","--",`${sourceRelative}/task.md`)
  const index = git(f.root,"ls-files","-s")
  await assert.rejects(prepareArchivedCardPublication({effectiveRoot:f.root,file,before:f.card,spawnGit:spawnSync}),/archived card has outside edits/u)
  assert.equal(git(f.root,"ls-files","-s"),index)
})

test("a retained report target that resolves outside is explicitly unknown",async () => {
  const f = await plainFixture(), file = path.join(f.source,"task.md"), outside = await plainFixture()
  const state = await prepareArchivedCardPublication({effectiveRoot:f.root,file,before:"owned card\n",spawnGit:spawnSync})
  await fs.rename(f.source,path.join(f.root,"retained-source"))
  await fs.symlink(outside.source,f.source,process.platform === "win32" ? "junction" : "dir")
  assert.equal(await state.retainedTarget(),null)
  await assert.rejects(state.assertBefore(),/changed before its report patch/u)
  assert.equal((await state.publish("owned card\n","report")).status,"failed")
})

test("failure qualification reports an actual known candidate outside a rebound ancestor",async () => {
  const f = await plainFixture(), outside = await mkTempDeskRoot(), stat = await fs.lstat(f.source,{bigint:true})
  const sourceIdentity = `${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`
  await fs.rename(f.source,path.join(outside,"source"))
  await fs.rename(path.dirname(f.destination),path.join(f.root,"retained-parent"))
  await fs.symlink(outside,path.dirname(f.destination),process.platform === "win32" ? "junction" : "dir")
  const error = await qualifyArchiveFailure(new Error("controlled failure"),{effectiveRoot:f.root,srcDir:f.source,
    archiveDir:f.destination,sourceIdentity,moved:true,published:false})
  assert.equal(error.archive_phase,"relocated_outside_boundary")
  assert.equal(error.actual_path,path.join(await fs.realpath(outside),"source","task.md"))
})

test("failure qualification does not fabricate a boundary when it is unavailable",async () => {
  const f = await plainFixture(), stat = await fs.lstat(f.source,{bigint:true})
  const error = await qualifyArchiveFailure(new Error("controlled failure"),{effectiveRoot:path.join(f.root,"missing"),
    srcDir:f.source,archiveDir:f.destination,sourceIdentity:`${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`,
    moved:false,published:false})
  assert.equal(error.archive_phase,"not_moved")
  assert.equal(error.actual_path,path.join(await fs.realpath(f.source),"task.md"))
})

for (const staged of [false,true]) test(`preflight refuses a ${staged ? "staged" : "dirty"} tracked companion`,async () => {
  const f = await archiveFixture()
  await fs.writeFile(f.file,"OUTSIDE_COMPANION\n")
  if (staged) git(f.root,"add","--",`${sourceRelative}/companion.txt`)
  const index = git(f.root,"ls-files","-s")
  await assert.rejects(prepare(f),/staged or dirty companion/u)
  assert.equal(git(f.root,"ls-files","-s"),index)
  assert.equal(await fs.readFile(f.file,"utf8"),"OUTSIDE_COMPANION\n")
})

test("the final preflight Git reads catch a companion write after byte admission",async () => {
  const f = await archiveFixture()
  let injected = false
  const spawnGit = (command,args,options) => {
    if (!injected && args[2] === "diff" && !args.includes("--cached")) {
      const write = spawnSync(process.execPath,["-e",
        "require('node:fs').appendFileSync(process.argv[1], 'OUTSIDE_AFTER_HASH\\n')",f.file],{encoding:"utf8"})
      assert.equal(write.status,0,write.stderr)
      injected = true
    }
    return spawnSync(command,args,options)
  }
  await assert.rejects(prepare(f,{spawnGit}),/dirty, staged, or untracked companion bytes/u)
  assert.equal(injected,true)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.match(await fs.readFile(f.file,"utf8"),/OUTSIDE_AFTER_HASH/u)
})

test("nested tracked payloads retain their directory keys during admission and publication",async () => {
  const f = await archiveFixture(), folder = path.join(f.source,"nested")
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder,"peer.txt"),"nested owned\n")
  git(f.root,"add","--",`${sourceRelative}/nested/peer.txt`)
  git(f.root,"commit","-q","-m","owned nested payload")
  const state = await prepare(f)
  assert.ok(state.snapshot.has("nested/peer.txt"))
  await move(f,state)
  assert.equal(await state.publish("archive"),undefined)
  assert.equal(await fs.readFile(path.join(f.destination,"nested","peer.txt"),"utf8"),"nested owned\n")
})

test("executable payload admission honors real Git observations, not a syscall-only mode",async t => {
  const f = await archiveFixture({mode:"100755"})
  if (process.platform === "win32") {
    const lstat = fs.lstat
    t.mock.method(fs,"lstat",async (file,...args) => {
      const stat = await lstat(file,...args)
      return [f.file,path.join(f.destination,"companion.txt")].includes(file)
        ? Object.assign(Object.create(stat),{mode:stat.mode | 0o100n}) : stat
    })
    assert.equal(git(f.root,"diff","--name-only","--",sourceRelative),`${sourceRelative}/companion.txt`)
    await assert.rejects(prepare(f),/dirty, staged, or untracked companion bytes/u)
    assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
    assert.equal(git(f.root,"ls-files","-s"),f.index)
    await assert.rejects(fs.lstat(f.destination),{code:"ENOENT"})
    return
  }
  const state = await prepare(f)
  await move(f,state)
  const result = await state.publish("archive")
  assert.equal(result,undefined)
  assert.match(git(f.root,"ls-tree","HEAD",`${archiveRelative}/companion.txt`),/^100755 /u)
})

test("symbolic payload admission honors real Git observations, not a syscall-only link",async t => {
  const f = await archiveFixture({mode:"120000"})
  if (process.platform === "win32") {
    const lstat = fs.lstat
    t.mock.method(fs,"lstat",async (file,...args) => {
      const stat = await lstat(file,...args)
      return [f.file,path.join(f.destination,"companion.txt")].includes(file)
        ? Object.assign(Object.create(stat),{mode:(stat.mode & 0o777n) | 0o120000n,
          isFile:() => false,isSymbolicLink:() => true}) : stat
    })
    t.mock.method(fs,"readlink",async file => {
      assert.ok([f.file,path.join(f.destination,"companion.txt")].includes(file))
      return "peer.txt"
    })
    assert.equal(git(f.root,"diff","--name-only","--",sourceRelative),`${sourceRelative}/companion.txt`)
    await assert.rejects(prepare(f),/dirty, staged, or untracked companion bytes/u)
    assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
    assert.equal(git(f.root,"ls-files","-s"),f.index)
    await assert.rejects(fs.lstat(f.destination),{code:"ENOENT"})
    return
  } else {
    await fs.rename(f.file,path.join(f.root,"retained-plain-companion"))
    await fs.symlink("peer.txt",f.file)
  }
  const state = await prepare(f)
  await move(f,state)
  const result = await state.publish("archive")
  assert.equal(result,undefined)
  assert.equal(await fs.readlink(path.join(f.destination,"companion.txt")),"peer.txt")
  assert.match(git(f.root,"ls-tree","HEAD",`${archiveRelative}/companion.txt`),/^120000 /u)
})

test("a card referent outside the moved directory is not inserted as a new snapshot key",async t => {
  const f = await plainFixture(), held = path.join(f.root,"held-card.md")
  await fs.writeFile(held,"owned card\n")
  const state = await prepare(f)
  await move(f,state)
  const file = path.join(f.destination,"task.md")
  if (process.platform === "win32") {
    const realpath = fs.realpath
    t.mock.method(fs,"realpath",async (target,...args) => target === file ? await realpath(held) : realpath(target,...args))
  } else {
    await fs.rename(file,path.join(f.root,"original-card"))
    await fs.symlink(held,file)
  }
  const keys = [...state.snapshot.keys()]
  await state.cardWritten("owned card\n")
  assert.deepEqual([...state.snapshot.keys()],keys)
  assert.equal(await fs.readFile(held,"utf8"),"owned card\n")
})

test("an unreadable track plan fails before relocation rather than becoming no track",async () => {
  const f = await archiveFixture()
  await fs.mkdir(path.join(f.root,"t","track.md"))
  await assert.rejects(task_archive({deskRoot:f.root,input:{track:"t",slug:"mode-proof"},schedulePush:() => {}}),
    {code:"EISDIR"})
  assert.ok(await fs.stat(f.source))
  assert.equal(git(f.root,"ls-files","-s"),f.index)
})

test("cancelling an open archive does not invent a row in an unrelated track body",async () => {
  const root = await mkTempDeskRoot()
  await task_create({deskRoot:root,input:{track:"t",slug:"open-work",title:"Owned open work",status:"processing"},
    schedulePush:() => {}})
  const file = path.join(root,"t","track.md")
  await fs.writeFile(file,"No task table here.\n")
  const result = await task_archive({deskRoot:root,input:{track:"t",slug:"open-work",outcome:"cancelled"},schedulePush:() => {}})
  assert.equal(result.status,"archived")
  assert.equal(await fs.readFile(file,"utf8"),"No task table here.\n")
  assert.match(await fs.readFile(path.join(root,"t","_archive","open-work","task.md"),"utf8"),/^status: cancelled$/mu)
})

for (const kind of ["missing","malformed"]) test(`a ${kind} legacy archived card is not treated as a readable status or report`,async () => {
  const root = await mkTempDeskRoot(), dir = path.join(root,"t","_archive","legacy-work")
  await fs.mkdir(dir,{recursive:true})
  if (kind === "malformed") await fs.writeFile(path.join(dir,"task.md"),"---\nstatus: [\n---\n")
  const result = await task_archive({deskRoot:root,input:{track:"t",slug:"legacy-work"},schedulePush:() => {}})
  assert.equal(result.status,"already_archived")
  assert.equal(result.factory_report,undefined)
  if (kind === "malformed") assert.equal(await fs.readFile(path.join(dir,"task.md"),"utf8"),"---\nstatus: [\n---\n")
})

for (const kind of ["nonterminal","unknown","missing-card"])
  test(`an interrupted ${kind} archive keeps explicit pending state without moving again`,async () => {
    const f = await archiveFixture({relocated:true}), card = path.join(f.destination,"task.md")
    if (kind === "nonterminal") await fs.writeFile(card,(await fs.readFile(card,"utf8")).replace(/^status: done$/mu,"status: processing"))
    if (kind === "missing-card") await fs.rename(card,path.join(f.root,"retained-task.md"))
    const before = await fs.readdir(f.destination)
    const result = await task_archive({deskRoot:f.root,input:{track:"t",slug:"mode-proof"},schedulePush:() => assert.fail("pending archives are not pushed"),
      spawnGit:kind === "unknown" ? failedGit(a => a[2] === "ls-files",failed) : spawnSync})
    assert.equal(result.status,"archive_pending")
    assert.ok(["pending","unknown"].includes(result.publication.status))
    assert.deepEqual(await fs.readdir(f.destination),before)
    assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
    assert.equal(git(f.root,"ls-files","-s"),f.index)
    await assert.rejects(fs.lstat(f.source),{code:"ENOENT"})
  })

test("a card changed during completion preflight is retained before any move",async t => {
  const f = await archiveFixture(), file = path.join(f.source,"task.md"), physical = await fs.realpath(file), readFile = fs.readFile
  let injected = false
  t.mock.method(fs,"readFile",async (target,...args) => {
    const bytes = await readFile(target,...args)
    if ([file,physical].includes(target) && !injected) {
      injected = true
      await fs.appendFile(file,"\nOUTSIDE_COMPLETION_PREFLIGHT\n")
    }
    return bytes
  })
  await assert.rejects(task_archive({deskRoot:f.root,input:{track:"t",slug:"mode-proof"},schedulePush:() => {}}),
    /card changed during completion preflight/u)
  assert.equal(injected,true)
  assert.match(await readFile(file,"utf8"),/OUTSIDE_COMPLETION_PREFLIGHT/u)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  await assert.rejects(fs.lstat(f.destination),{code:"ENOENT"})
})
