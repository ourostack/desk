import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot } from "./_helpers.js"

function git(root,...args) {
  const result = spawnSync("git",["-C",root,...args],{ encoding:"utf8" })
  assert.equal(result.status,0,result.stderr)
  return result.stdout.trimEnd()
}
async function interrupted({ filemode = true, symlinks = true, mode = "100644" } = {}) {
  const root = await mkTempDeskRoot()
  git(root,"init","-q","-b","main")
  git(root,"config","user.name","Owned archive mode fixture")
  git(root,"config","user.email","archive-mode@example.invalid")
  git(root,"config","core.filemode",String(filemode))
  git(root,"config","core.symlinks",String(symlinks))
  await task_create({ deskRoot:root,input:{track:"t",slug:"mode-proof",title:"Mode proof",status:"done"},
    schedulePush:() => {} })
  const source = path.join(root,"t","mode-proof"), destination = path.join(root,"t","_archive","mode-proof")
  const relative = "t/mode-proof/companion.txt"
  await fs.writeFile(path.join(source,"companion.txt"),"peer.txt")
  git(root,"add","--",relative)
  const sha = git(root,"hash-object",relative)
  git(root,"update-index","--add","--cacheinfo",`${mode},${sha},${relative}`)
  git(root,"commit","-q","-m","owned companion baseline")
  await fs.mkdir(path.dirname(destination))
  await fs.rename(source,destination)
  return { root,destination,file:path.join(destination,"companion.txt"),sha,
    head:git(root,"rev-parse","HEAD"),index:git(root,"ls-files","-s"),
    card:await fs.readFile(path.join(destination,"task.md")) }
}
async function retry(f,extra = {}) {
  return task_archive({ deskRoot:f.root,input:{track:"t",slug:"mode-proof"},schedulePush:() => {},...extra })
}
async function assertPendingUnchanged(f) {
  const result = await retry(f)
  assert.equal(result.status,"archive_pending")
  assert.equal(result.path,"t/_archive/mode-proof/task.md")
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.deepEqual(await fs.readFile(path.join(f.destination,"task.md")),f.card)
}

test("interrupted archive refuses a companion executable-mode change honored by Git",async () => {
  const f = await interrupted({ mode:"100755" })
  await fs.chmod(f.file,0o644)
  await assertPendingUnchanged(f)
})

test("interrupted archive refuses a companion type substitution with identical blob bytes",async t => {
  const f = await interrupted()
  if (process.platform === "win32") {
    // The filesystem-call cell tests mode admission without a symlink privilege.
    const lstat = fs.lstat
    t.mock.method(fs,"lstat",async (file,...args) => {
      const stat = await lstat(file,...args)
      if (file !== f.file) return stat
      return Object.assign(Object.create(stat),{ mode:(stat.mode & 0o777n) | 0o120000n,
        isDirectory:() => false,isFile:() => false,isSymbolicLink:() => true })
    })
    t.mock.method(fs,"readlink",async file => { assert.equal(file,f.file); return "peer.txt" })
  } else {
    await fs.rename(f.file,path.join(f.root,"retained-original-companion"))
    await fs.symlink("peer.txt",f.file)
  }
  await assertPendingUnchanged(f)
})

for (const [name,policy] of [
  ["an executable bit ignored by Git",{ filemode:false,mode:"100755" }],
  ["Git's plain-file symlink representation",{ symlinks:false,mode:"120000" }],
]) test(`interrupted archive preserves ${name} in the published index`,async () => {
  const f = await interrupted(policy)
  await fs.chmod(f.file,0o644)
  const result = await retry(f)
  assert.equal(result.status,"archived")
  assert.equal(result.commit,undefined)
  assert.match(git(f.root,"ls-tree","HEAD","t/_archive/mode-proof/companion.txt"),
    new RegExp(`^${policy.mode} blob ${f.sha}\\t`))
  assert.equal(git(f.root,"status","--porcelain"),"")
})

test("recovery does not adopt a card-body edit that arrives after its initial admission",async () => {
  const f = await interrupted()
  const card = path.join(f.destination,"task.md")
  let injected = false
  let result, failure
  try { result = await retry(f,{ readiness:{
    async recordChange(change) {
      if (change.path === "t/_archive/mode-proof" && change.operation === "write") {
        await fs.appendFile(card,"\nFOREIGN_AFTER_ADMISSION\n")
        injected = true
      }
      return { recorded:true }
    },
    async markUncertain() { assert.fail("the controlled journal acknowledgement did not fail") },
  } }) } catch (error) { failure = error }
  assert.equal(injected,true)
  assert.ok(failure?.actual_path || result?.status === "archive_pending","late card changes must remain an explicit retained uncertainty")
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.match(await fs.readFile(card,"utf8"),/FOREIGN_AFTER_ADMISSION/u)
})
