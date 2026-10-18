// Scoped checks for the ordinary archive primitive, not mutation custody.
// Nonparticipating editors are not excluded; late failures retain actual state.
import { promises as fs } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { isPathContained } from "../util/paths.js"
import { indexEntries, stagePaths, commitIndexPaths } from "../util/git-stage.js"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/")
function gitPath(git, file) {
  const suffix = path.relative(git.logicalRoot, file)
  if (suffix === ".." || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix))
    throw new Error("task_archive: a Git path leaves the effective desk")
  return relative(git.root, path.resolve(git.physicalRoot, suffix))
}
async function present(file) {
  try { return await fs.lstat(file, { bigint: true }) } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}
function readGit(root, args, spawnGit, input) {
  const answer = spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, ...(input === undefined ? {} : { input }) })
  if (answer.status !== 0) throw new Error(`task_archive: Git precondition unavailable (${args[0]}): ${answer.stderr || answer.error?.code || answer.status}`)
  return answer.stdout
}
async function gitContext(root, spawnGit) {
  const physicalRoot = await fs.realpath(root)
  let marker = false
  for (let dir = physicalRoot; ; dir = path.dirname(dir)) {
    if (await present(path.join(dir, ".git"))) { marker = true; break }
    if (dir === path.dirname(dir)) break
  }
  if (!marker) return null
  const top = readGit(root, ["rev-parse", "--show-toplevel"], spawnGit).trim()
  const head = spawnGit("git", ["-C", top, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8", timeout: 10000 })
  if (head.status !== 0 && head.status !== 1) throw new Error("task_archive: HEAD could not be qualified; nothing was moved")
  return { root: top, logicalRoot: path.resolve(root), physicalRoot, head: head.status === 0 ? head.stdout.trim() : null, spawnGit }
}
function headEntries(git, folder) {
  if (!git.head) return []
  return readGit(git.root, ["ls-tree", "-r", "-z", git.head, "--", gitPath(git, folder)], git.spawnGit)
    .split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t")
      const [mode, , sha] = line.slice(0, tab).split(" ")
      return { mode, sha, path: line.slice(tab + 1), stage: "0" }
    })
}
function destinationVacant(git, archiveDir) {
  const entries = indexEntries(git.root, [gitPath(git, archiveDir)], git.spawnGit)
  if (entries === null) throw new Error("task_archive: archive destination index state is unavailable; nothing was moved")
  if (entries.length || headEntries(git, archiveDir).length)
    throw new Error("task_archive: archive destination is occupied in HEAD or the index (including a staged deletion); nothing was moved")
}
async function tree(directory) {
  const result = new Map()
  async function visit(file, key) {
    const before = await fs.lstat(file, { bigint: true })
    const entry = { identity: identity(before), mode: Number(before.mode & 0o777n) }
    if (before.isDirectory()) {
      entry.kind = "directory"
      result.set(key, entry)
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), key ? `${key}/${name}` : name)
      return
    }
    if (!before.isFile() && !before.isSymbolicLink()) throw new Error("task_archive: an unsupported companion type cannot be admitted")
    entry.kind = before.isSymbolicLink() ? "link" : "file"
    entry.bytes = before.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file)
    entry.hash = hash(entry.bytes)
    const after = await fs.lstat(file, { bigint: true })
    if (identity(after) !== entry.identity || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("task_archive: source changed while its bytes were being admitted")
    result.set(key, entry)
  }
  await visit(directory, "")
  return result
}
function sameTree(actual, expected) {
  return actual.size === expected.size && [...expected].every(([key, entry]) => {
    const found = actual.get(key)
    return found && found.identity === entry.identity && found.kind === entry.kind &&
      found.mode === entry.mode && found.hash === entry.hash
  })
}
function cleanHash(git, file, bytes) {
  const oid = readGit(git.root, ["hash-object", "--path", gitPath(git, file), "--stdin"], git.spawnGit, bytes).trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) throw new Error("task_archive: Git did not return a qualified clean blob")
  return oid
}
async function ancestry(boundary, destination) {
  const physical = await fs.realpath(boundary)
  const segments = path.relative(boundary, path.dirname(destination)).split(path.sep).filter(Boolean)
  const nodes = new Map()
  let cursor = boundary
  for (const segment of ["", ...segments]) {
    cursor = segment ? path.join(cursor, segment) : cursor
    const info = await present(cursor)
    if (!info) continue
    const real = await fs.realpath(cursor)
    if (!isPathContained(physical, real)) throw new Error("task_archive: destination ancestry is outside the effective desk")
    nodes.set(cursor, { identity: identity(info), real, target: identity(await fs.stat(cursor, { bigint: true })) })
  }
  return { physical, async assert() {
    for (const [file, expected] of nodes) {
      const info = await present(file)
      if (!info || identity(info) !== expected.identity || await fs.realpath(file) !== expected.real ||
          identity(await fs.stat(file, { bigint: true })) !== expected.target)
        throw new Error("task_archive: destination ancestor identity changed")
    }
    const parent = await fs.realpath(path.dirname(destination))
    if (!isPathContained(physical, parent)) throw new Error("task_archive: destination ancestry is outside the effective desk")
  } }
}

export async function prepareArchiveState({ effectiveRoot, srcDir, archiveDir, srcFile, trackPlan, spawnGit, relocated = false }) {
  const snapshot = await tree(relocated ? archiveDir : srcDir)
  const fence = await ancestry(effectiveRoot, archiveDir)
  const git = await gitContext(effectiveRoot, spawnGit)
  let track = null
  if (trackPlan) {
    const stat = await fs.lstat(trackPlan.file, { bigint: true })
    if (!stat.isFile()) throw new Error("task_archive: a track link update requires a regular track card")
    track = { ...trackPlan, identity: identity(stat), mode: Number(stat.mode & 0o777n) }
  }
  let tracked = []
  let cardDirty = false
  if (git) {
    destinationVacant(git, archiveDir)
    const source = gitPath(git, srcDir)
    const card = gitPath(git, srcFile)
    const entries = indexEntries(git.root, [source], spawnGit)
    if (entries === null || entries.some((entry) => entry.stage !== "0" || entry.mode === "160000"))
      throw new Error("task_archive: source index conflicts/submodules cannot be admitted; nothing was moved")
    const baseline = new Map(headEntries(git, srcDir).map((entry) => [entry.path, entry]))
    tracked = entries.map((entry) => entry.path)
    if (relocated) {
      if (entries.length === 0 || entries.length !== baseline.size ||
          entries.some((entry) => baseline.get(entry.path)?.sha !== entry.sha || baseline.get(entry.path)?.mode !== entry.mode))
        throw new Error("task_archive: the interrupted move has no unchanged source HEAD/index to reconcile")
      for (const [key, entry] of snapshot) {
        if (entry.kind === "directory") continue
        const held = baseline.get(`${source}/${key}`)
        const sha = entry.kind === "link"
          ? readGit(git.root, ["hash-object", "--stdin"], spawnGit, entry.bytes).trim()
          : cleanHash(git, path.join(srcDir, key), entry.bytes)
        if (!held || held.sha !== sha)
          throw new Error("task_archive: relocated bytes differ from the source HEAD/index; preserve the archive and resolve the discrepancy before retrying")
      }
      if ([...baseline.keys()].some((file) => !snapshot.has(file.slice(source.length + 1))))
        throw new Error("task_archive: the interrupted move is missing a tracked source file")
    }
    for (const entry of entries) {
      if (entry.path === card) continue
      const previous = baseline.get(entry.path)
      const key = entry.path.slice(source.length + 1)
      const bytes = snapshot.get(key)?.bytes
      if (!previous || previous.sha !== entry.sha || previous.mode !== entry.mode || !bytes ||
          (snapshot.get(key).kind === "link"
            ? readGit(git.root, ["hash-object", "--stdin"], spawnGit, bytes).trim()
            : cleanHash(git, path.join(srcDir, key), bytes)) !== entry.sha)
        throw new Error("task_archive: a staged or dirty companion is not implicitly owned; nothing was moved")
    }
    for (const args of relocated ? [] : [
      ["diff", "--name-only", "-z", "--", source],
      ["diff", "--cached", "--name-only", "-z", "--", source],
      ["ls-files", "--others", "-z", "--", source],
    ]) {
      const changes = readGit(git.root, args, spawnGit).split("\0").filter(Boolean)
      if (changes.some((file) => file !== card))
        throw new Error("task_archive: dirty, staged, or untracked companion bytes cannot be adopted; nothing was moved")
      cardDirty ||= changes.includes(card)
    }
    if (track && [
      ["diff", "--name-only", "--", gitPath(git, track.file)],
      ["diff", "--cached", "--name-only", "--", gitPath(git, track.file)],
      ["ls-files", "--others", "--", gitPath(git, track.file)],
    ].some((args) => readGit(git.root, args, spawnGit).trim()))
      throw new Error("task_archive: the track row/link has outside edits; nothing was moved")
  }
  async function assertTrack() {
    if (!track) return
    const stat = await fs.lstat(track.file, { bigint: true })
    if (identity(stat) !== track.identity || !Buffer.from(await fs.readFile(track.file)).equals(Buffer.from(track.before)))
      throw new Error("task_archive: the track changed after preflight; outside edits were retained")
  }
  return {
    git, cardDirty, snapshot, fence,
    async atUse() {
      await fence.assert()
      await assertTrack()
      if (!sameTree(await tree(relocated ? archiveDir : srcDir), snapshot))
        throw new Error("task_archive: source changed after preflight")
      if (await present(relocated ? srcDir : archiveDir))
        throw new Error("task_archive: the other archive path appeared before publication")
      if (git) {
        destinationVacant(git, archiveDir)
        if (headSha(git) !== git.head) throw new Error("task_archive: HEAD changed after preflight")
      }
    },
    async afterMove() {
      await fence.assert()
      if (!sameTree(await tree(archiveDir), snapshot)) throw new Error("task_archive: relocated payload changed; outside bytes retained")
    },
    assertTrack,
    async cardWritten(expectedBytes) {
      const real = await fs.realpath(path.join(archiveDir, "task.md"))
      if (!(await fs.readFile(real)).equals(Buffer.from(expectedBytes))) throw new Error("task_archive: card bytes changed during its patch; no publication was admitted")
      if (isPathContained(await fs.realpath(archiveDir), real)) {
        const key = relative(await fs.realpath(archiveDir), real)
        const stat = await fs.lstat(real, { bigint: true })
        snapshot.set(key, { ...snapshot.get(key), identity: identity(stat), bytes: Buffer.from(expectedBytes), hash: hash(expectedBytes) })
      }
    },
    async publish(message) {
      if (!git) return undefined
      await fence.assert()
      if (!sameTree(await tree(archiveDir), snapshot)) throw new Error("task_archive: relocated bytes changed before staging; outside edits retained")
      destinationVacant(git, archiveDir)
      if (headSha(git) !== git.head) throw new Error("task_archive: HEAD changed before publication")
      const expected = new Map()
      const source = gitPath(git, srcDir)
      const destination = gitPath(git, archiveDir)
      for (const [name, entry] of snapshot) {
        if (entry.kind === "directory") continue
        if (!tracked.includes(`${source}/${name}`) && name !== "task.md") continue
        expected.set(`${destination}/${name}`, {
          sha: entry.kind === "link"
            ? readGit(git.root, ["hash-object", "--stdin"], spawnGit, entry.bytes).trim()
            : cleanHash(git, path.join(archiveDir, name), entry.bytes),
          mode: entry.kind === "link" ? "120000" : entry.mode & 0o111 ? "100755" : "100644",
        })
      }
      if (track) {
        const bytes = Buffer.from(track.after)
        if (!(await fs.readFile(track.file)).equals(bytes)) throw new Error("task_archive: track changed before publication")
        expected.set(gitPath(git, track.file), { sha: cleanHash(git, track.file, bytes), mode: track.mode & 0o111 ? "100755" : "100644" })
      }
      const paths = [...new Set([...tracked, ...expected.keys()])]
      const staged = stagePaths(git.root, paths, spawnGit)
      if (!staged.ok) return { status: "failed", reason: staged.stderr }
      const entries = indexEntries(git.root, paths, spawnGit)
      if (entries === null || entries.length !== expected.size || entries.some((entry) =>
        entry.stage !== "0" || expected.get(entry.path)?.sha !== entry.sha || expected.get(entry.path)?.mode !== entry.mode))
        return { status: "failed", reason: "staged archive differs from the admitted HEAD/index/bytes; no commit was attempted" }
      if (headSha(git) !== git.head) return { status: "failed", reason: "HEAD changed before the pinned archive commit" }
      const committed = commitIndexPaths(git.root, paths, entries, message, spawnGit)
      return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
    },
  }
}
function headSha(git) {
  const answer = git.spawnGit("git", ["-C", git.root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8", timeout: 10000 })
  if (answer.status === 1) return null
  if (answer.status !== 0) throw new Error("task_archive: current HEAD could not be qualified")
  return answer.stdout.trim()
}

export async function archivePublicationState({ effectiveRoot, srcDir, archiveDir, spawnGit }) {
  try {
    const git = await gitContext(effectiveRoot, spawnGit)
    if (!git) return { status: "not_git" }
    const oldPath = gitPath(git, srcDir)
    const newPath = gitPath(git, archiveDir)
    const entries = indexEntries(git.root, [oldPath, newPath], spawnGit)
    if (entries === null) return { status: "unknown", reason: "archive index could not be read" }
    const before = headEntries(git, srcDir)
    const published = headEntries(git, archiveDir)
    const actual = new Map(entries.map((entry) => [entry.path, entry]))
    const clean = !readGit(git.root, ["diff", "--name-only", "--", newPath], spawnGit).trim() &&
      !readGit(git.root, ["ls-files", "--others", "--exclude-standard", "--", newPath], spawnGit).trim()
    if (!before.length && published.length && entries.length === published.length && clean &&
        published.every((entry) => actual.get(entry.path)?.sha === entry.sha && actual.get(entry.path)?.mode === entry.mode))
      return { status: "published" }
    return { status: "pending", reason: "the directory exists, but the exact archive move is not cleanly published in HEAD/index" }
  } catch {
    return { status: "unknown", reason: "the existing archive's Git publication could not be qualified" }
  }
}

export async function qualifyArchiveFailure(error, { effectiveRoot, srcDir, archiveDir, sourceIdentity, moved, published }) {
  let actual = null
  for (const candidate of [archiveDir, srcDir]) {
    try {
      if (identity(await fs.lstat(candidate, { bigint: true })) === sourceIdentity) {
        actual = await fs.realpath(candidate)
        break
      }
    } catch { /* A missing/unreadable candidate is unknown, not an actual path. */ }
  }
  const physical = await fs.realpath(effectiveRoot).catch(() => null)
  const outside = actual !== null && physical !== null && !isPathContained(physical, actual)
  error.archive_phase = outside ? "relocated_outside_boundary" : published ? "archived_publication_complete" :
    moved ? "relocated_uncommitted" : actual === null ? "relocation_outcome_uncertain" : "not_moved"
  error.actual_path = actual === null ? null : path.join(actual, "task.md")
  error.path = error.actual_path
  if (actual === null) error.last_known_path = path.join(archiveDir, "task.md")
  error.message += `; archive_phase=${error.archive_phase}; actual_path=${error.actual_path ?? "unknown"}; no rollback or unknown publication was attempted`
  return error
}
