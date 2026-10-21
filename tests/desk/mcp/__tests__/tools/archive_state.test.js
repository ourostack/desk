import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { git,interrupted,retry,assertPendingUnchanged } from "./_archive_state_helpers.js"

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
  ["Git's mode when only non-owner execute bits are set",{ filemode:true,mode:"100644",permissions:0o645 }],
]) test(`interrupted archive preserves ${name} in the published index`,async t => {
  const f = await interrupted(policy)
  await fs.chmod(f.file,policy.permissions ?? 0o644)
  if (process.platform === "win32" && policy.permissions !== undefined) {
    const lstat = fs.lstat
    t.mock.method(fs,"lstat",async (file,...args) => {
      const stat = await lstat(file,...args)
      return file === f.file
        ? Object.assign(Object.create(stat),{mode:(stat.mode & ~0o777n) | BigInt(policy.permissions)}) : stat
    })
  }
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
