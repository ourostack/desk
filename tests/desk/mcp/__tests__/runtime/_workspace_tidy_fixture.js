// Fixtures shared by the workspace tidy tests, which are split over two files so the Windows suite can run them at the same time.
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { readInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"
import { TIDY_GIT_TIMEOUT_MS } from "../../../../../plugins/desk/mcp/src/runtime/workspace-tidy.js"

// Injected Git runners stand in for workspace tidy's own, so they keep its per-call limit rather than the hooks' 2 s default.
export const tidyInspectionGit = (cwd, args) => readInspectionGit(cwd, args, { timeoutMs: TIDY_GIT_TIMEOUT_MS })

export const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/workspace-tidy.js", import.meta.url)
export const tidy = await import(moduleUrl).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
  return {}
})
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim()

export async function fixture() {
  const root = await mkTempRoot("desk-workspace-tidy-")
  const desk = path.join(root, "desk")
  const repo = path.join(root, "repo")
  const remote = path.join(root, "remote.git")
  for (const dir of [desk, repo]) {
    await fs.mkdir(dir)
    git(dir, "init", "-b", "main")
    git(dir, "config", "user.name", "Fixture")
    git(dir, "config", "user.email", "fixture@example.invalid")
    await fs.writeFile(path.join(dir, "tracked"), "base\n")
    git(dir, "add", "tracked")
    git(dir, "commit", "-m", "base")
  }
  git(root, "init", "--bare", remote)
  git(repo, "remote", "add", "origin", remote)
  git(repo, "push", "-u", "origin", "main")
  const card = path.join(desk, "track", "task", "task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, `---\nstatus: done\nupdated: "${new Date().toISOString()}"\nrepos:\n  - name: repo\n    local_path: ${JSON.stringify(repo)}\n    mode: local\n---\n`)
  return { root, desk, repo, remote, card }
}

export async function worktree(f, branch = "topic") {
  const directory = path.join(f.root, branch)
  git(f.repo, "worktree", "add", "-b", branch, directory, "main")
  const admin = git(directory, "rev-parse", "--absolute-git-dir")
  const info = await fs.stat(directory)
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" })
  let start
  try {
    await once(child, "spawn")
    start = await readProcessStart(child.pid)
  } finally {
    child.kill()
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit")
  }
  const record = {
    version: 2, task: path.relative(f.desk, f.card), owner: "task/attempt-1", disposition: "remove",
    repository: git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    worktree: directory, branch: `refs/heads/${branch}`, head: git(directory, "rev-parse", "HEAD"),
    base: "refs/heads/main", delivered: git(f.repo, "rev-parse", "main"),
    identity: { dev: info.dev, ino: info.ino },
    release: { complete: true, host: "fixture", machine: os.hostname(), evidence: "host-operation/1", consumers: [], processes: [{ pid: child.pid, start }] },
  }
  const receipt = path.join(admin, "desk-closeout.json")
  const save = () => fs.writeFile(receipt, JSON.stringify(record), { mode: 0o600 })
  await save()
  return { directory, admin, record, receipt, save }
}


export async function squashFixture() {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(w.directory, "tracked"), "squash delivery\n")
  git(w.directory, "commit", "-am", "topic")
  git(w.directory, "push", "origin", "topic")
  git(f.repo, "merge", "--squash", "topic")
  git(f.repo, "commit", "-m", "squash")
  git(f.repo, "push", "origin", "main")
  w.record.head = git(w.directory, "rev-parse", "HEAD")
  w.record.delivered = git(f.repo, "rev-parse", "main")
  w.record.base = "refs/remotes/origin/main"
  w.record.remote = { name: "origin", branch: "refs/heads/topic", endpoint: pathToFileURL(f.remote).href }
  await w.save()
  return { f, w }
}
