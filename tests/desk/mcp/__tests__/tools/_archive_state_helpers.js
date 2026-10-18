import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot } from "./_helpers.js"

export function git(root,...args) {
  const result = spawnSync("git",["-C",root,...args],{ encoding:"utf8" })
  assert.equal(result.status,0,result.stderr)
  return result.stdout.trimEnd()
}
export async function archiveFixture({ filemode = true, symlinks = true, mode = "100644", relocated = false } = {}) {
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
  await fs.chmod(path.join(source,"companion.txt"),mode === "100755" ? 0o755 : 0o644)
  git(root,"add","--",relative)
  const sha = git(root,"hash-object",relative)
  git(root,"update-index","--add","--cacheinfo",`${mode},${sha},${relative}`)
  git(root,"commit","-q","-m","owned companion baseline")
  await fs.mkdir(path.dirname(destination))
  if (relocated) await fs.rename(source,destination)
  const current = relocated ? destination : source
  return { root,source,destination,file:path.join(current,"companion.txt"),sha,
    head:git(root,"rev-parse","HEAD"),index:git(root,"ls-files","-s"),
    card:await fs.readFile(path.join(current,"task.md")) }
}
export const interrupted = options => archiveFixture({ ...options,relocated:true })
export async function retry(f,extra = {}) {
  return task_archive({ deskRoot:f.root,input:{track:"t",slug:"mode-proof"},schedulePush:() => {},...extra })
}
export async function assertPendingUnchanged(f) {
  const result = await retry(f)
  assert.equal(result.status,"archive_pending")
  assert.equal(result.path,"t/_archive/mode-proof/task.md")
  assert.equal(git(f.root,"rev-parse","HEAD"),f.head)
  assert.equal(git(f.root,"ls-files","-s"),f.index)
  assert.deepEqual(await fs.readFile(path.join(f.destination,"task.md")),f.card)
}
