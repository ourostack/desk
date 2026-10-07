import { promises as fs } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { foldPath, nativeGitPath, samePath } from "./native-path.js"
import { readProcessStart } from "../readiness/process-start.js"

// Both names are locked: a branch can be reacquired at a different path, and a
// worktree path can be reused with another branch. Locks outlive worktree admin.
// Paths from Git arrive with forward slashes on Windows; the claim works in the platform's own spelling, and two spellings of one folder (case, short name) take the same locks.
export async function withWorkspaceClaim({ repository: givenRepository, worktree: givenWorktree, branch, owner }, action) {
  const repository = nativeGitPath(givenRepository)
  const worktree = nativeGitPath(givenWorktree)
  if (!path.isAbsolute(repository) || !path.isAbsolute(worktree) || !/^refs\/heads\/.+/u.test(branch) || typeof owner !== "string" || !owner) {
    throw new Error("exact resource claim requires repository, worktree, branch and owner")
  }
  if (!samePath(await fs.realpath(repository), repository)) throw new Error("claim repository identity is not canonical")
  const directory = path.join(repository, "desk-resource-claims")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("unsafe resource claim directory")
  const token = randomUUID()
  const record = JSON.stringify({ token, owner, repository, worktree, branch, pid: process.pid, start: await readProcessStart(process.pid) })
  const claims = []
  const assertHeld = async () => {
    for (const claim of claims) {
      const info = await fs.lstat(claim.file)
      if (!info.isFile() || info.nlink !== 1 || info.dev !== claim.dev || info.ino !== claim.ino ||
          await fs.readFile(claim.file, "utf8") !== record) throw new Error("exact resource claim changed; cleanup refused")
    }
  }
  try {
    for (const identity of [`branch:${branch}`, `worktree:${foldPath(worktree)}`].sort()) {
      const file = path.join(directory, `${createHash("sha256").update(identity).digest("hex")}.lock`)
      let handle
      try { handle = await fs.open(file, "wx", 0o600) } catch (error) {
        if (error.code === "EEXIST") throw new Error(`resource already claimed: ${identity}`)
        throw error
      }
      try {
        await handle.writeFile(record)
        const { dev, ino } = await handle.stat()
        claims.push({ file, dev, ino })
      } finally { await handle.close() }
    }
    await assertHeld()
    return await action(assertHeld)
  } finally {
    // A replaced/unreadable claim is not ours to remove. Preserve it for exact
    // owner reconciliation, and never treat age or a reused PID as authority.
    await assertHeld()
    for (const claim of claims.reverse()) await fs.unlink(claim.file)
  }
}
