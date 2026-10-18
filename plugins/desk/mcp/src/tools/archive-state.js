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
  if (isPathContained(git.physicalRoot, file)) return relative(git.root, file)
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
function gitBoolean(root, name, spawnGit) {
  const answer = spawnGit("git", ["-C", root, "config", "--bool", "--get", name], { encoding: "utf8", timeout: 10000 })
  if (answer.status === 1) return true
  if (answer.status !== 0 || !["true", "false"].includes(answer.stdout.trim()))
    throw new Error(`task_archive: Git ${name} could not be qualified`)
  return answer.stdout.trim() === "true"
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
  return { root: top, logicalRoot: path.resolve(root), physicalRoot, head: head.status === 0 ? head.stdout.trim() : null,
    fileMode: gitBoolean(top, "core.filemode", spawnGit), symlinks: gitBoolean(top, "core.symlinks", spawnGit), spawnGit }
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
function gitMode(entry, previous, git) {
  if (entry.kind === "link" || (previous?.mode === "120000" && !git.symlinks)) return "120000"
  if (!git.fileMode) return previous?.mode === "100755" ? "100755" : "100644"
  return entry.mode & 0o100 ? "100755" : "100644"
}
function blobHash(git, file, bytes, mode) {
  return mode === "120000"
    ? readGit(git.root, ["hash-object", "--stdin"], git.spawnGit, bytes).trim()
    : cleanHash(git, file, bytes)
}
function assertGitState(git) {
  if (headSha(git) !== git.head) throw new Error("task_archive: HEAD changed after preflight")
  if (gitBoolean(git.root, "core.filemode", git.spawnGit) !== git.fileMode ||
      gitBoolean(git.root, "core.symlinks", git.spawnGit) !== git.symlinks)
    throw new Error("task_archive: Git mode/type policy changed after preflight")
}
function indexMatches(entries, expected) {
  return entries !== null && entries.length === expected.size && entries.every((entry) =>
    entry.stage === "0" && expected.get(entry.path)?.sha === entry.sha && expected.get(entry.path)?.mode === entry.mode)
}
function publishExpected(git, paths, expected, message) {
  assertGitState(git)
  const staged = stagePaths(git.root, paths, git.spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  let entries = indexEntries(git.root, paths, git.spawnGit)
  const normalStage = new Map([...expected].map(([file, entry]) => [file, { sha: entry.stageSha, mode: entry.stageMode }]))
  if (!indexMatches(entries, normalStage))
    return { status: "failed", reason: "staged archive differs from the admitted bytes; no commit was attempted" }
  const metadata = [...expected].filter(([, entry]) => entry.mode !== entry.stageMode || entry.sha !== entry.stageSha)
  if (metadata.length) {
    const input = metadata.map(([file, entry]) => `${entry.mode} ${entry.sha}\t${file}\0`).join("")
    const updated = git.spawnGit("git", ["-C", git.root, "update-index", "-z", "--index-info"],
      { encoding: "utf8", timeout: 10000, input })
    if (updated.status !== 0) return { status: "failed", reason: updated.stderr || updated.error?.code || "Git metadata staging failed" }
    entries = indexEntries(git.root, paths, git.spawnGit)
  }
  if (!indexMatches(entries, expected))
    return { status: "failed", reason: "the admitted Git mode/type metadata could not be staged" }
  assertGitState(git)
  const committed = commitIndexPaths(git.root, paths, entries, message, git.spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
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
  let originals = new Map()
  let trackEntry = null
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
    originals = new Map(entries.map((entry) => [entry.path, entry]))
    if (relocated) {
      if (entries.length === 0 || entries.length !== baseline.size ||
          entries.some((entry) => baseline.get(entry.path)?.sha !== entry.sha || baseline.get(entry.path)?.mode !== entry.mode))
        throw new Error("task_archive: the interrupted move has no unchanged source HEAD/index to reconcile")
      for (const [key, entry] of snapshot) {
        if (entry.kind === "directory") continue
        const held = baseline.get(`${source}/${key}`)
        const mode = gitMode(entry, held, git)
        const sha = blobHash(git, path.join(srcDir, key), entry.bytes, mode)
        if (!held || held.sha !== sha || held.mode !== mode)
          throw new Error("task_archive: relocated bytes differ from the source HEAD/index; preserve the archive and resolve the discrepancy before retrying")
      }
      if ([...baseline.keys()].some((file) => !snapshot.has(file.slice(source.length + 1))))
        throw new Error("task_archive: the interrupted move is missing a tracked source file")
    }
    for (const entry of entries) {
      if (entry.path === card) continue
      const previous = baseline.get(entry.path)
      const key = entry.path.slice(source.length + 1)
      const current = snapshot.get(key), bytes = current?.bytes
      if (!previous || previous.sha !== entry.sha || previous.mode !== entry.mode || !bytes ||
          gitMode(current, entry, git) !== entry.mode ||
          blobHash(git, path.join(srcDir, key), bytes, entry.mode) !== entry.sha)
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
    if (track) {
      const held = indexEntries(git.root, [gitPath(git, track.file)], spawnGit)
      if (held === null || held.length !== 1 || held[0].stage !== "0" || !["100644", "100755"].includes(held[0].mode))
        throw new Error("task_archive: the track's regular Git file state could not be qualified")
      trackEntry = held[0]
    }
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
        assertGitState(git)
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
      await fence.assert()
      if (!sameTree(await tree(archiveDir), snapshot)) throw new Error("task_archive: relocated bytes changed before staging; outside edits retained")
      if (track && (!(await fs.lstat(track.file)).isFile() ||
          !isPathContained(fence.physical, await fs.realpath(track.file)) ||
          !(await fs.readFile(track.file)).equals(Buffer.from(track.after))))
        throw new Error("task_archive: track changed before publication")
      if (!git) return undefined
      destinationVacant(git, archiveDir)
      if (headSha(git) !== git.head) throw new Error("task_archive: HEAD changed before publication")
      const expected = new Map()
      const source = gitPath(git, srcDir)
      const destination = gitPath(git, archiveDir)
      for (const [name, entry] of snapshot) {
        if (entry.kind === "directory") continue
        if (!tracked.includes(`${source}/${name}`) && name !== "task.md") continue
        const mode = gitMode(entry, originals.get(`${source}/${name}`), git)
        const sha = blobHash(git, path.join(archiveDir, name), entry.bytes, mode)
        expected.set(`${destination}/${name}`, { sha, mode,
          stageSha: entry.kind === "file" && mode === "120000" ? cleanHash(git, path.join(archiveDir, name), entry.bytes) : sha,
          stageMode: entry.kind === "link" ? "120000" : git.fileMode && entry.mode & 0o100 ? "100755" : "100644" })
      }
      if (track) {
        const bytes = Buffer.from(track.after)
        const sha = cleanHash(git, track.file, bytes), mode = gitMode({ kind: "file", mode: track.mode }, trackEntry, git)
        expected.set(gitPath(git, track.file), { sha, mode, stageSha: sha, stageMode: mode })
      }
      const paths = [...new Set([...tracked, ...expected.keys()])]
      return publishExpected(git, paths, expected, message)
    },
  }
}

export async function prepareArchivedCardPublication({ effectiveRoot, file, before, spawnGit }) {
  const physical = await fs.realpath(file), boundary = await fs.realpath(effectiveRoot)
  if (!isPathContained(boundary, physical)) throw new Error("task_archive: archived card target is outside the effective desk")
  const stat = await fs.lstat(physical, { bigint: true })
  if (!stat.isFile()) throw new Error("task_archive: archived card target is not a regular file")
  const git = await gitContext(effectiveRoot, spawnGit)
  let previous = null
  let key
  if (git) {
    key = gitPath(git, physical)
    const held = indexEntries(git.root, [key], spawnGit)
    if (held === null || held.length !== 1 || held[0].stage !== "0" || !["100644", "100755"].includes(held[0].mode))
      throw new Error("task_archive: archived card Git state could not be qualified")
    previous = held[0]
    for (const args of [
      ["diff", "--name-only", "--", key], ["diff", "--cached", "--name-only", "--", key],
      ["ls-files", "--others", "--", key],
    ]) if (readGit(git.root, args, spawnGit).trim())
      throw new Error("task_archive: archived card has outside edits; no report fields were changed")
  }
  async function sameTarget(expected) {
    return await fs.realpath(file) === physical &&
      identity(await fs.lstat(physical, { bigint: true })) === identity(stat) &&
      (await fs.readFile(physical)).equals(Buffer.from(expected))
  }
  return {
    file: physical, git,
    async retainedTarget() {
      try {
        const actual = await fs.realpath(physical)
        if (!isPathContained(boundary, actual)) return null
        const current = await fs.lstat(actual, { bigint: true })
        return current.isFile() && identity(current) === identity(stat) ? actual : null
      } catch { return null }
    },
    async assertBefore() {
      if (!(await sameTarget(before))) throw new Error("task_archive: archived card changed before its report patch")
      if (git) assertGitState(git)
    },
    async publish(expected, message) {
      if (!(await sameTarget(expected))) return { status: "failed", reason: "archived card changed during its report patch; no commit was attempted" }
      if (!git) return undefined
      const mode = gitMode({ kind: "file", mode: Number(stat.mode & 0o777n) }, previous, git)
      const sha = cleanHash(git, physical, Buffer.from(expected))
      return publishExpected(git, [key], new Map([[key, { sha, mode, stageSha: sha, stageMode: mode }]]), message)
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
    moved ? "relocated_publication_unconfirmed" : actual === null ? "relocation_outcome_uncertain" : "not_moved"
  error.actual_path = actual === null ? null : path.join(actual, "task.md")
  error.path = error.actual_path
  if (actual === null) error.last_known_path = path.join(archiveDir, "task.md")
  error.message += `; archive_phase=${error.archive_phase}; actual_path=${error.actual_path ?? "unknown"}; no rollback or unknown publication was attempted`
  return error
}
