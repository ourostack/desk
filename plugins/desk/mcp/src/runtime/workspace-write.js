import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { runGit } from "./state-branch.js"
import { insidePath, nativeGitPath, samePath } from "./native-path.js"
import { withWorkspaceClaim } from "./workspace-claim.js"

const INSPECT_MS = 2000
const LOCATION_ENV = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/iu

function assertGitEnvironment() {
  const override = Object.keys(process.env).find(key => LOCATION_ENV.test(key) && process.env[key] !== "")
  if (override) throw new Error(`Git write environment overrides the claimed resource: ${override}`)
}

async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

async function outsideGit(root) {
  for (let folder = root; ; folder = path.dirname(folder)) {
    if (await exists(path.join(folder, ".git")) || await exists(path.join(folder, "HEAD")) && await exists(path.join(folder, "objects"))) return false
    if (path.dirname(folder) === folder) return true
  }
}

async function directoryIdentity(file) {
  const info = await fs.stat(file, { bigint: true })
  if (!info.isDirectory()) throw new Error("workspace write destination is not a directory")
  return `${info.dev}:${info.ino}`
}

// These Git reads resolve metadata only; none traverses objects or implicitly fetches missing history.
async function locate(root, read) {
  const found = await read(root, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"])
  if (!found.ok) {
    if (/^fatal: not a git repository/u.test(found.stderr) && await outsideGit(root)) return null
    throw new Error(`Git could not verify the write destination: ${found.stderr}`)
  }
  const fields = found.stdout.split(/\r?\n/u)
  if (fields.length !== 3 || fields.some(value => !path.isAbsolute(nativeGitPath(value)))) throw new Error("Git returned an invalid write destination")
  const [worktree, repository, admin] = await Promise.all(fields.map(value => fs.realpath(nativeGitPath(value))))
  if (!insidePath(worktree, root)) throw new Error("Git write destination is outside its reported worktree")
  const head = await read(root, ["symbolic-ref", "--quiet", "HEAD"])
  if (!head.ok || !/^refs\/heads\/[^\s]+$/u.test(head.stdout)) throw new Error("Git write requires a verified named branch; detached or unreadable HEAD")
  const identities = await Promise.all([root, worktree, repository, admin].map(directoryIdentity))
  return { worktree, repository, admin, branch: head.stdout, identities }
}

function sameResource(before, after) {
  return after !== null && ["worktree", "repository", "admin"].every(key => samePath(before[key], after[key])) &&
    before.branch === after.branch && before.identities.every((identity, i) => identity === after.identities[i])
}

/** Hold the maintained exact claim across one cooperating file-write/commit operation. This does not exclude external editors. */
export async function withWorkspaceWrite({ deskRoot, stateBranch, owner = `desk_save:${randomUUID()}`, reuse, validate, signal }, action) {
  assertGitEnvironment()
  const root = await fs.realpath(deskRoot)
  const rootIdentity = await directoryIdentity(root)
  const deadline = Date.now() + INSPECT_MS
  const read = async (cwd, args) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Git write inspection budget expired; no write dispatched")
    return runGit({ cwd, args, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, signal, timeoutMs: remaining })
  }
  const before = await locate(root, read)
  const assertDestination = async assertHeld => {
    assertGitEnvironment()
    signal?.throwIfAborted()
    await assertHeld()
    if (!samePath(await fs.realpath(deskRoot), root) || await directoryIdentity(root) !== rootIdentity) {
      throw new Error("Git write destination alias or identity changed before mutation")
    }
  }
  const verify = async assertHeld => {
    await assertDestination(assertHeld)
    const now = await locate(root, read)
    if (before === null ? now !== null : !sameResource(before, now)) throw new Error("Git write destination or branch changed before mutation")
    if (now !== null && stateBranch != null && now.branch !== `refs/heads/${stateBranch}`) throw new Error(`Git write branch does not match ${stateBranch}`)
    if (now !== null) {
      if (await exists(path.join(now.admin, "index.lock"))) throw new Error("Git index.lock blocks this write")
    }
    await assertHeld()
  }
  const run = async (assertHeld, capability) => {
    await verify(assertHeld)
    await validate?.()
    await verify(assertHeld)
    return action({ deskRoot, assertHeld: () => assertDestination(assertHeld), capability, branch: before?.branch.slice("refs/heads/".length) })
  }
  if (before === null) {
    if (reuse !== undefined) throw new Error("workspace claim resource changed to a non-Git folder")
    return run(async () => {})
  }
  return withWorkspaceClaim({ ...before, owner, reuse }, run)
}
