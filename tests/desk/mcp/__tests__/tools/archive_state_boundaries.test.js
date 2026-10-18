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
      if (args[2] === "commit" && fault === "commit failure") { intercepted = true; return failed }
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
