// Shared relocation mechanics. The caller owns the canonical mutation claim.
// Prepared bytes are fingerprinted; Git commits a pinned index, never a later
// working-tree edit. This is phase reporting, not a durable transaction ledger.
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { withCreatedDirs } from "../util/created-dirs.js"
import { isGitRepository, commitIndexPaths, indexEntries, stagePaths } from "../util/git-stage.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { writeFileAtomic } from "../util/fm.js"
import { recordCleanupCard } from "../desk/cleanup-index.js"
import { openResources } from "../desk/resources.js"
import { assertDeskMutationHeld } from "../util/desk-mutation.js"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const blobHash = (bytes, format) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/")
const identityOf = (stat) => `${stat.dev}:${stat.ino}`

export class TerminalArchiveError extends Error {
  constructor({ phase, path: cardPath, cause, committed = null }) {
    super(`Terminal update stopped at ${cardPath} (${phase}): ${cause.message}. Payload was not rolled back; do not replay mixed/append-bearing updates. Inspect this path; use task_move unarchive and a reasoned return to reopen.`, { cause })
    this.code = "terminal_archive_partial"
    this.phase = phase
    this.path = cardPath
    this.committed = committed
  }
  toJSON() {
    return { status: "partial_operation", code: this.code, phase: this.phase, path: this.path,
      committed: this.committed, retryable: false, message: this.message,
      ...(this.mutation_claim_cleanup_error ? { mutation_claim_cleanup_error: this.mutation_claim_cleanup_error } : {}) }
  }
}

async function present(file) {
  try { return await fs.lstat(file, { bigint: true }) } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function tree(directory, format = "sha1") {
  const entries = new Map()
  async function visit(file, name) {
    const stat = await fs.lstat(file, { bigint: true })
    const identity = identityOf(stat)
    if (stat.isSymbolicLink()) {
      const bytes = Buffer.from(await fs.readlink(file))
      entries.set(name, { kind: "link", mode: "120000", hash: digest(bytes), gitHash: blobHash(bytes, format), identity })
    } else if (stat.isDirectory()) {
      entries.set(name, { kind: "directory", identity })
      for (const child of (await fs.readdir(file)).sort()) await visit(path.join(file, child), name ? `${name}/${child}` : child)
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(file)
      entries.set(name, { kind: "file", mode: stat.mode & 0o111n ? "100755" : "100644", hash: digest(bytes), gitHash: blobHash(bytes, format), identity })
    } else throw new Error("Automatic archive refuses a non-file companion")
  }
  await visit(directory, "")
  return entries
}

function sameTree(actual, expected) {
  return actual.size === expected.size && [...expected].every(([name, value]) => {
    const found = actual.get(name)
    return found?.kind === value.kind && found.mode === value.mode && found.hash === value.hash && found.identity === value.identity
  })
}

async function sameTrack(file, bytes, identity, mode) {
  const stat = await fs.lstat(file, { bigint: true })
  if (!stat.isFile() || identityOf(stat) !== identity ||
      (stat.mode & 0o111n ? "100755" : "100644") !== mode) return false
  return (await fs.readFile(file)).equals(Buffer.from(bytes))
}

function gitRead(root, args, spawnGit) {
  const result = spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 })
  if (result.status !== 0) throw new Error(`Archive Git preflight failed: ${result.stderr || result.error?.message || args[0]}`)
  return result.stdout
}

function gitHead(root, spawnGit) {
  const result = spawnGit("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8", timeout: 10_000 })
  if (result.status === 1) return null // an unborn branch
  if (result.status !== 0) throw new Error("Cannot establish archive HEAD")
  return result.stdout.trim()
}

export async function prepareTerminalArchive({ root, srcDir, filePath, archiveDir, sourceBytes, spawnGit, validateSource, trackFile, nextTrack }) {
  if (await present(archiveDir)) throw new Error("task_update: archive destination already exists; nothing was written")
  await validateSource()
  const git = isGitRepository(root, spawnGit)
  const format = git ? gitRead(root, ["rev-parse", "--show-object-format"], spawnGit).trim() : "sha1"
  if (!["sha1", "sha256"].includes(format)) throw new Error("Automatic archive cannot pin this Git object format; nothing was written")
  const snapshot = await tree(srcDir, format)
  if (snapshot.get("task.md")?.kind !== "file" || snapshot.get("task.md").hash !== digest(sourceBytes)) throw new Error("task_update: card changed or is symlinked during preparation; nothing was written")
  let head = null
  let tracked = []
  if (git) {
    head = gitHead(root, spawnGit)
    const src = relative(root, srcDir)
    tracked = gitRead(root, ["ls-files", "-z", "--", src], spawnGit).split("\0").filter(Boolean)
    const sourceEntries = indexEntries(root, [src], spawnGit)
    if (sourceEntries === null || sourceEntries.some((entry) => entry.mode === "160000")) throw new Error("task_update: automatic archive cannot admit a submodule companion; nothing was written")
    if (gitRead(root, ["ls-files", "-u", "--", src, relative(root, archiveDir)], spawnGit).trim()) throw new Error("task_update: archive paths have unmerged conflicts; nothing was written")
    for (const args of [
      ["diff", "--name-only", "-z", "--", src],
      ["diff", "--cached", "--name-only", "-z", "--", src],
      ["ls-files", "--others", "--exclude-standard", "-z", "--", src],
    ]) {
      const changed = gitRead(root, args, spawnGit).split("\0").filter(Boolean)
      if (changed.some((name) => name !== relative(root, filePath))) throw new Error("task_update: uncommitted companion bytes cannot be published by automatic archival; nothing was written")
    }
  }
  return { root, srcDir, filePath, archiveDir, snapshot, format, initialCardHash: digest(sourceBytes), git, head, tracked, trackFile, nextTrack, spawnGit }
}

// Recheck immediately before rename under the shared canonical claim. POSIX
// rename is not claimed to exclude hostile/nonparticipating external creators.
export async function relocateTaskDirectory({ srcDir, archiveDir }) {
  await withCreatedDirs(path.dirname(archiveDir), async () => {
    await assertDeskMutationHeld()
    if (await present(archiveDir)) throw new Error("archive destination already exists; no relocation was performed")
    await fs.rename(srcDir, archiveDir)
  })
}

export async function finishTerminalArchive({ plan, bytes, body, readiness, env, schedulePush, terminalSync }) {
  const { root, srcDir, filePath, archiveDir, snapshot, format, git, head, tracked, trackFile, nextTrack, spawnGit } = plan
  let actual = filePath
  let phase = "not_written"
  let committed = null
  let trackIdentity = nextTrack?.identity
  try {
    await assertDeskMutationHeld()
    if (!sameTree(await tree(srcDir, format), snapshot)) throw new Error("source bytes/path changed after preflight")
    if (await present(archiveDir)) throw new Error("archive destination appeared after preflight")
    if (nextTrack && !(await sameTrack(trackFile, nextTrack.before, trackIdentity, nextTrack.mode))) throw new Error("track bytes/path changed after preflight")
    phase = "write_attempted"
    await writeFileAtomic(filePath, bytes)
    phase = "written_active"
    const preparedBytes = Buffer.from(bytes)
    snapshot.set("task.md", { ...snapshot.get("task.md"), hash: digest(preparedBytes), gitHash: blobHash(preparedBytes, format),
      identity: identityOf(await fs.lstat(filePath, { bigint: true })) })
    if (!sameTree(await tree(srcDir, format), snapshot)) throw new Error("source changed after terminal write; external bytes retained")
    await relocateTaskDirectory({ srcDir, archiveDir })
    actual = path.join(archiveDir, "task.md")
    phase = "relocated_uncommitted"
    if (nextTrack) {
      if (!(await sameTrack(trackFile, nextTrack.before, trackIdentity, nextTrack.mode))) throw new Error("track bytes/path changed before its write")
      await writeFileAtomic(trackFile, nextTrack.after)
      const written = await fs.lstat(trackFile, { bigint: true })
      if (!written.isFile()) throw new Error("track path changed after its write")
      trackIdentity = identityOf(written)
    }
    await recordCanonicalChanges({ root, readiness, changes: [
      { path: relative(root, srcDir), operation: "delete" },
      { path: relative(root, archiveDir), operation: "write" },
      ...(nextTrack ? [{ path: relative(root, trackFile) }] : []),
    ] })
    if (!sameTree(await tree(archiveDir, format), snapshot)) throw new Error("relocated bytes changed before staging; external bytes retained")
    if (nextTrack && !(await sameTrack(trackFile, nextTrack.after, trackIdentity, nextTrack.mode))) throw new Error("track changed before staging")
    if (git) {
      const paths = [...(tracked.length ? [relative(root, srcDir)] : []), relative(root, archiveDir), ...(nextTrack ? [relative(root, trackFile)] : [])]
      const staged = stagePaths(root, paths, spawnGit)
      if (!staged.ok) throw new Error(`stage failed: ${staged.stderr}`)
      const entries = indexEntries(root, paths, spawnGit)
      if (entries === null) throw new Error("cannot read staged archive entries")
      const oldPrefix = `${relative(root, srcDir)}/`
      const newPrefix = `${relative(root, archiveDir)}/`
      const expectedNames = new Set([
        ...tracked.map((name) => `${newPrefix}${name.slice(oldPrefix.length)}`),
        `${newPrefix}task.md`,
        ...(nextTrack ? [relative(root, trackFile)] : []),
      ])
      if (entries.length !== expectedNames.size || entries.some((entry) => !expectedNames.has(entry.path))) throw new Error("staged paths differ from admitted archive; no commit made")
      // Every entry committed must be exactly one admitted snapshot blob.
      for (const entry of entries) {
        let expected
        if (nextTrack && entry.path === relative(root, trackFile)) expected = { gitHash: blobHash(Buffer.from(nextTrack.after), format), mode: nextTrack.mode }
        else {
          const prefix = `${relative(root, archiveDir)}/`
          if (entry.path.startsWith(prefix)) expected = snapshot.get(entry.path.slice(prefix.length))
        }
        if (!expected?.gitHash || entry.stage !== "0" ||
            entry.sha !== expected.gitHash ||
            (expected.mode && expected.mode !== entry.mode)) throw new Error("staged archive differs from admitted bytes; no commit made")
      }
      if (gitHead(root, spawnGit) !== head) throw new Error("HEAD changed during terminal operation; no commit made")
      // commitIndexPaths removes individual old index entries, not a directory
      // pathspec (a directory is not itself an index entry).
      const pinnedPaths = [...new Set([...tracked, ...expectedNames])]
      await assertDeskMutationHeld()
      phase = "commit_attempted"
      const result = commitIndexPaths(root, pinnedPaths, entries, `task_update: ${relative(root, srcDir)}`, spawnGit)
      if (!result.ok) {
        const after = gitHead(root, spawnGit)
        phase = after === head ? "relocated_uncommitted" : "commit_outcome_uncertain"
        if (after !== head) committed = after
        throw new Error(`commit failed: ${result.stderr}`)
      }
      phase = "committed"
      committed = gitRead(root, ["rev-parse", "--short", "HEAD"], spawnGit).trim()
      schedulePush({ root })
      if (!sameTree(await tree(archiveDir, format), snapshot) ||
          (nextTrack && !(await sameTrack(trackFile, nextTrack.after, trackIdentity, nextTrack.mode)))) {
        throw new Error("external edits retained after the pinned commit; cleanup-index and terminal-sync obligations remain")
      }
    }
    // This is the actual final path, including for an update adding no resource.
    recordCleanupCard(root, relative(root, archiveDir), openResources(body).length > 0, env)
    const sync = await terminalSync()
    if (sync && Object.values(sync).some((value) => value?.status === "deferred")) throw new Error("terminal sync deferred; the recorded request obligation remains")
    if (!sameTree(await tree(archiveDir, format), snapshot) ||
        (nextTrack && !(await sameTrack(trackFile, nextTrack.after, trackIdentity, nextTrack.mode)))) throw new Error("external edits retained after metadata refresh; derived state may need reconciliation")
    return { filePath: actual, deskCommit: committed, archive_phase: phase }
  } catch (cause) {
    if (phase === "write_attempted") {
      try {
        const current = await fs.readFile(filePath)
        phase = current.equals(Buffer.from(bytes)) ? "written_active" :
          digest(current) === plan.initialCardHash ? "not_written" : "write_outcome_uncertain"
      } catch {
        phase = "write_outcome_uncertain"
      }
    }
    if (phase === "written_active") {
      try {
        const moved = await present(archiveDir)
        if (!(await present(srcDir)) && moved && identityOf(moved) === snapshot.get("").identity) {
          actual = path.join(archiveDir, "task.md")
          phase = "relocated_uncommitted"
        }
      } catch {
        phase = "placement_uncertain"
      }
    }
    throw new TerminalArchiveError({ phase, path: relative(root, actual), cause, committed })
  }
}
