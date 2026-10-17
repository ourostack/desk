// One ephemeral claim for a canonical desk, shared by tool entry points and
// normal sync. Person prefixes deliberately do not partition this claim:
// both people can touch the same track/index. No stale-owner takeover.
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readOwnProcessStart, readProcessStart } from "../readiness/process-start.js"

const context = new AsyncLocalStorage()

export class DeskMutationCleanupError extends Error {
  constructor(cause, result) {
    super(`Desk mutation claim cleanup failed; claim retained (no automatic recovery): ${cause.message}`, { cause })
    this.result = result
  }
  toJSON() {
    return { status: "partial_operation", code: "desk_mutation_cleanup_failed", path: this.result?.path ?? null,
      retryable: false, result: this.result ?? null, message: this.message }
  }
}

export async function assertDeskMutationHeld() {
  const held = context.getStore()
  if (!held?.active) throw new Error("Canonical mutation requires an internal owner capability")
  await held.assertHeld()
}

async function mutationLocation(deskRoot) {
  const root = await fs.realpath(deskRoot)
  let directory = root
  // A bound person/subdirectory still shares the worktree's index and HEAD.
  // Find its enclosing Git administration directory without trusting a person
  // label, branch name, environment variable, or caller-supplied token.
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    try {
      const git = path.join(ancestor, ".git")
      const info = await fs.lstat(git)
      if (info.isDirectory()) directory = await fs.realpath(git)
      else if (info.isFile()) {
        const text = await fs.readFile(git, "utf8")
        if (!text.startsWith("gitdir: ")) throw new Error("Unrecognized Git directory")
        directory = await fs.realpath(path.resolve(ancestor, text.slice(8).trim()))
      } else throw new Error("Unsafe Git directory")
      break
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (ancestor === path.dirname(ancestor)) break
  }
  const file = path.join(directory, ".desk-mutation.lock")
  return { root, file }
}

// Read-only diagnosis, NOT permission to remove a claim. Even positive owner
// termination cannot prove closure of orphaned Git/hook children.
export async function inspectDeskMutation(deskRoot) {
  const { file } = await mutationLocation(deskRoot)
  try {
    const before = await fs.lstat(file, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > 16_384n) return { state: "unknown", file }
    const text = await fs.readFile(file, "utf8")
    const after = await fs.lstat(file, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return { state: "unknown", file }
    const record = JSON.parse(text)
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.start !== "string" || !record.start ||
        typeof record.token !== "string" || !record.token) return { state: "unknown", file }
    const witness = { file, file_id: `${before.dev}:${before.ino}`, sha256: createHash("sha256").update(text).digest("hex") }
    try { process.kill(record.pid, 0) } catch (error) {
      return { ...witness, state: error.code === "ESRCH" ? "ended_children_unqualified" : "unknown" }
    }
    const start = record.pid === process.pid ? await readOwnProcessStart() : await readProcessStart(record.pid)
    return { ...witness, state: !start ? "unknown" : start === record.start ? "live" : "pid_reused" }
  } catch (error) {
    return { state: error.code === "ENOENT" ? "absent" : "unknown", file }
  }
}

export async function withDeskMutation(deskRoot, action) {
  const { root, file } = await mutationLocation(deskRoot)
  const inherited = context.getStore()
  if (inherited?.file === file && inherited.active) {
    await inherited.assertHeld()
    return action(inherited.assertHeld)
  }
  const start = await readOwnProcessStart()
  if (!start) throw new Error("Desk mutation refused: process generation unavailable")
  const record = JSON.stringify({ root, pid: process.pid, start, token: randomUUID() })
  let handle
  try {
    handle = await fs.open(file, "wx", 0o600)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    const owner = await inspectDeskMutation(deskRoot)
    const busy = new Error(`Desk mutation busy: an exact owner claim exists (${owner.state}); no mutation was made. No PID/age-based recovery is supported: owner termination does not prove child/Git closure.`)
    busy.code = "desk_mutation_busy"
    busy.owner_state = owner.state
    throw busy
  }
  const identity = await handle.stat({ bigint: true })
  const assertHeld = async () => {
    const current = await fs.lstat(file, { bigint: true })
    if (!current.isFile() || current.nlink !== 1n ||
        current.dev !== identity.dev || current.ino !== identity.ino ||
        await fs.readFile(file, "utf8") !== record) {
      throw new Error("Desk mutation owner claim changed; cleanup refused")
    }
  }
  const capability = { root, file, active: true, assertHeld }
  let result
  let primaryError
  try {
    await handle.writeFile(record)
    await handle.close()
    handle = null
    await assertHeld()
    result = await context.run(capability, () => action(assertHeld))
    return result
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    capability.active = false
    try {
      if (handle) await handle.close()
      // Never remove a replacement, unknown or stale owner's claim.
      await assertHeld()
      await fs.unlink(file)
    } catch (error) {
      if (primaryError) primaryError.mutation_claim_cleanup_error = error.message
      else throw new DeskMutationCleanupError(error, result)
    }
  }
}
