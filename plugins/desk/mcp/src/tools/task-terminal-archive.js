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
import { isPathContained } from "../util/paths.js"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const blobHash = (bytes, format) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/")
const identityOf = (stat) => `${stat.dev}:${stat.ino}`

export class TerminalArchiveError extends Error {
  constructor({ phase, path: cardPath, cause, committed = null, placement = "known" }) {
    const recovery = placement !== "known" ?
      "Retain the obligation and establish owned placement before further mutation; do not force an unarchive across the write boundary." :
      "Inspect this path; use task_move unarchive and a reasoned return to reopen."
    super(`Terminal update stopped at ${cardPath ?? "an unqualified location"} (${phase}): ${cause.message}. Payload was not rolled back; do not replay mixed/append-bearing updates. ${recovery}`, { cause })
    this.code = "terminal_archive_partial"
    this.phase = phase
    this.path = cardPath
    this.committed = committed
    this.placement = placement
  }
  toJSON() {
    return { status: "partial_operation", code: this.code, phase: this.phase, path: this.path,
      committed: this.committed, placement: this.placement, retryable: false, message: this.message,
      ...(this.actual_path ? { actual_path: this.actual_path } : {}),
      ...(this.last_known_path ? { last_known_path: this.last_known_path } : {}),
      ...(this.mutation_claim_cleanup_error ? { mutation_claim_cleanup_error: this.mutation_claim_cleanup_error } : {}) }
  }
}

async function present(file) {
  try { return await fs.lstat(file, { bigint: true }) } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function destinationFence(boundary, archiveDir) {
  const realBoundary = await fs.realpath(boundary)
  const parent = path.dirname(archiveDir)
  const rel = path.relative(path.resolve(boundary), parent)
  if (!isPathContained(path.resolve(boundary), parent)) throw new Error("archive destination ancestry is outside the write boundary")
  const parts = rel === "" ? [] : rel.split(path.sep)
  const entries = []
  for (let i = 0; i <= parts.length; i++) {
    const file = path.join(boundary, ...parts.slice(0, i))
    const stat = await present(file)
    const real = stat ? await fs.realpath(file) : null
    if (stat && ((!stat.isDirectory() && !stat.isSymbolicLink()) || !isPathContained(realBoundary, real))) throw new Error("archive destination ancestry is outside the write boundary or not a directory")
    entries.push({ file, identity: stat ? identityOf(stat) : null, real,
      link: stat?.isSymbolicLink() ? await fs.readlink(file) : null })
  }
  return {
    boundary: realBoundary,
    async assert({ created = false } = {}) {
      for (const entry of entries) {
        const stat = await present(entry.file)
        if (!stat) {
          if (entry.identity !== null || created) throw new Error("archive destination ancestry disappeared")
          continue
        }
        const real = await fs.realpath(entry.file)
        if ((!stat.isDirectory() && !stat.isSymbolicLink()) || !isPathContained(realBoundary, real)) throw new Error("archive destination ancestry escaped its write boundary")
        if (entry.identity === null) {
          if (!created || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("archive destination ancestry was replaced or appeared")
          entry.identity = identityOf(stat)
          entry.real = real
        } else if (identityOf(stat) !== entry.identity || real !== entry.real ||
            (stat.isSymbolicLink() ? await fs.readlink(entry.file) : null) !== entry.link) {
          throw new Error("archive destination ancestry was replaced")
        }
      }
    },
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

function gitRead(root, args, spawnGit, input) {
  const result = spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, ...(input === undefined ? {} : { input }) })
  if (result.status !== 0) throw new Error(`Archive Git preflight failed: ${result.stderr || result.error?.message || args[0]}`)
  return result.stdout
}

function assertGitDestinationVacant({ root, archiveDir, head, spawnGit }) {
  if (gitHead(root, spawnGit) !== head) throw new Error("HEAD changed during archive preflight; the destination cannot be admitted")
  const dest = relative(root, archiveDir)
  const indexed = indexEntries(root, [dest], spawnGit)
  if (indexed === null || indexed.length > 0 ||
      (head !== null && gitRead(root, ["ls-tree", "-r", "-z", "--name-only", head, "--", dest], spawnGit) !== "")) {
    throw new Error("task_update: archive destination is occupied in HEAD/index, even if absent on disk; reconcile its deletion or collision before retrying")
  }
  for (let ancestor = path.posix.dirname(dest); ancestor !== "."; ancestor = path.posix.dirname(ancestor)) {
    const entries = indexEntries(root, [ancestor], spawnGit)
    const held = head === null ? "" : gitRead(root, ["ls-tree", "-z", head, "--", ancestor], spawnGit)
    if (entries === null || entries.some((entry) => entry.path === ancestor) ||
        (held && !held.startsWith("040000 tree "))) throw new Error("task_update: archive destination ancestry is occupied in HEAD/index")
  }
}

function gitHead(root, spawnGit) {
  const result = spawnGit("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8", timeout: 10_000 })
  if (result.status === 1) return null // an unborn branch
  if (result.status !== 0) throw new Error("Cannot establish archive HEAD")
  return result.stdout.trim()
}

export async function prepareTerminalArchive({ root, boundary = root, srcDir, filePath, archiveDir, sourceBytes, spawnGit, validateSource, trackFile, nextTrack }) {
  if (await present(archiveDir)) throw new Error("task_update: archive destination already exists; nothing was written")
  await validateSource()
  const fence = await destinationFence(boundary, archiveDir)
  const git = isGitRepository(root, spawnGit)
  const format = git ? gitRead(root, ["rev-parse", "--show-object-format"], spawnGit).trim() : "sha1"
  if (!["sha1", "sha256"].includes(format)) throw new Error("Automatic archive cannot pin this Git object format; nothing was written")
  const snapshot = await tree(srcDir, format)
  if (snapshot.get("task.md")?.kind !== "file" || snapshot.get("task.md").hash !== digest(sourceBytes)) throw new Error("task_update: card changed or is symlinked during preparation; nothing was written")
  let head = null
  let tracked = []
  if (git) {
    head = gitHead(root, spawnGit)
    assertGitDestinationVacant({ root, archiveDir, head, spawnGit })
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
  if (git && [...snapshot.keys()].some((name) => name.split("/").includes(".gitattributes"))) {
    throw new Error("task_update: automatic archive cannot pre-admit task-local .gitattributes at a new path. Review and commit an equivalent inherited attribute policy before retrying, or explicitly archive an already-terminal card after reviewing destination attributes; nothing was written.")
  }
  return { root, physicalRoot: await fs.realpath(root), sourceLocation: await fs.realpath(srcDir), srcDir, filePath, archiveDir, snapshot, fence, format, initialCardHash: digest(sourceBytes), git, head, tracked, trackFile, nextTrack, spawnGit }
}

// Recheck immediately before rename under the shared canonical claim. POSIX
// rename is not claimed to exclude hostile/nonparticipating external creators.
export async function relocateTaskDirectory({ srcDir, archiveDir, boundary = path.dirname(srcDir), fence: givenFence }) {
  const fence = givenFence ?? await destinationFence(boundary, archiveDir)
  await fence.assert()
  const sourceIdentity = identityOf(await fs.lstat(srcDir, { bigint: true }))
  await withCreatedDirs(path.dirname(archiveDir), async () => {
    await assertDeskMutationHeld()
    await fence.assert({ created: true })
    if (await present(archiveDir)) throw new Error("archive destination already exists; no relocation was performed")
    await fs.rename(srcDir, archiveDir)
    try { await fence.assert({ created: true }) } catch (error) {
      const real = await fs.realpath(archiveDir).catch(() => null)
      if (real && identityOf(await fs.lstat(real, { bigint: true })) === sourceIdentity) error.actual_path = path.join(real, "task.md")
      throw error
    }
  })
}

export async function finishTerminalArchive({ plan, bytes, body, readiness, env, schedulePush, terminalSync }) {
  const { root, srcDir, filePath, archiveDir, snapshot, fence, format, git, head, tracked, trackFile, nextTrack, spawnGit } = plan
  let actual = filePath
  let phase = "not_written"
  let committed = null
  let trackIdentity = nextTrack?.identity
  try {
    await assertDeskMutationHeld()
    await fence.assert()
    if (!sameTree(await tree(srcDir, format), snapshot)) throw new Error("source bytes/path changed after preflight")
    if (await present(archiveDir)) throw new Error("archive destination appeared after preflight")
    if (nextTrack && !(await sameTrack(trackFile, nextTrack.before, trackIdentity, nextTrack.mode))) throw new Error("track bytes/path changed after preflight")
    const cleanHashes = new Map()
    let cleanTrackHash
    if (git) {
      assertGitDestinationVacant(plan)
      for (const [name, entry] of snapshot) {
        if (entry.kind === "directory") continue
        const content = name === "task.md" ? Buffer.from(bytes) :
          entry.kind === "link" ? Buffer.from(await fs.readlink(path.join(srcDir, name))) : await fs.readFile(path.join(srcDir, name))
        if (name !== "task.md" && digest(content) !== entry.hash) throw new Error("source changed during Git clean preflight")
        cleanHashes.set(name, entry.kind === "link" ? entry.gitHash :
          gitRead(root, ["hash-object", "--path", relative(root, path.join(archiveDir, name)), "--stdin"], spawnGit, content).trim())
      }
      if (nextTrack) cleanTrackHash = gitRead(root, ["hash-object", "--path", relative(root, trackFile), "--stdin"], spawnGit, Buffer.from(nextTrack.after)).trim()
    }
    phase = "write_attempted"
    await writeFileAtomic(filePath, bytes)
    phase = "written_active"
    const preparedBytes = Buffer.from(bytes)
    snapshot.set("task.md", { ...snapshot.get("task.md"), hash: digest(preparedBytes), gitHash: blobHash(preparedBytes, format),
      identity: identityOf(await fs.lstat(filePath, { bigint: true })) })
    if (!sameTree(await tree(srcDir, format), snapshot)) throw new Error("source changed after terminal write; external bytes retained")
    if (git) assertGitDestinationVacant(plan)
    await relocateTaskDirectory({ srcDir, archiveDir, fence })
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
    await fence.assert({ created: true })
    if (!sameTree(await tree(archiveDir, format), snapshot)) throw new Error("relocated bytes changed before staging; external bytes retained")
    if (nextTrack && !(await sameTrack(trackFile, nextTrack.after, trackIdentity, nextTrack.mode))) throw new Error("track changed before staging")
    if (git) {
      assertGitDestinationVacant(plan)
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
        if (nextTrack && entry.path === relative(root, trackFile)) expected = { gitHash: cleanTrackHash, mode: nextTrack.mode }
        else {
          const prefix = `${relative(root, archiveDir)}/`
          if (entry.path.startsWith(prefix)) {
            const name = entry.path.slice(prefix.length)
            expected = { ...snapshot.get(name), gitHash: cleanHashes.get(name) }
          }
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
      const scheduled = schedulePush({ root })
      if (scheduled?.scheduled === false) throw new Error(`commit retained but push handoff failed: ${scheduled.error}; pending recorded: ${scheduled.pending_recorded}`)
      await fence.assert({ created: true })
      if (!sameTree(await tree(archiveDir, format), snapshot) ||
          (nextTrack && !(await sameTrack(trackFile, nextTrack.after, trackIdentity, nextTrack.mode)))) {
        throw new Error("external edits retained after the pinned commit; cleanup-index and terminal-sync obligations remain")
      }
    }
    // This is the actual final path, including for an update adding no resource.
    recordCleanupCard(root, relative(root, archiveDir), openResources(body).length > 0, env)
    const sync = await terminalSync()
    if (sync && Object.values(sync).some((value) => value?.status === "deferred")) throw new Error("terminal sync deferred; the recorded request obligation remains")
    await fence.assert({ created: true })
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
    const lastKnown = relative(root, actual)
    let located = null
    for (const candidate of [cause.actual_path, path.join(archiveDir, "task.md"), filePath].filter(Boolean)) {
      try {
        const directory = await fs.realpath(path.dirname(candidate))
        if (identityOf(await fs.lstat(directory, { bigint: true })) !== snapshot.get("").identity) continue
        const card = path.join(directory, "task.md")
        if (await present(card)) { located = card; break }
      } catch {
        // An unreadable/moved candidate is not qualified placement.
      }
    }
    const placement = located === null ? "unknown" : isPathContained(fence.boundary, located) ? "known" : "outside_boundary"
    if (phase === "written_active") {
      if (placement === "unknown") phase = "placement_uncertain"
      else if (placement === "outside_boundary") phase = "relocated_outside_boundary"
      else if (path.dirname(located) !== plan.sourceLocation &&
          path.dirname(located) === await fs.realpath(archiveDir).catch(() => null)) phase = "relocated_uncommitted"
    }
    const error = new TerminalArchiveError({ phase, path: located === null ? null : relative(plan.physicalRoot, located), cause, committed, placement })
    if (located === null) error.last_known_path = lastKnown
    if (placement === "outside_boundary") error.actual_path = located
    throw error
  }
}
