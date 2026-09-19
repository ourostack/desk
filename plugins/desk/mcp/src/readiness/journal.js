import { randomUUID } from "node:crypto"
import * as filesystem from "node:fs"
import * as path from "node:path"
import { protectWindowsPaths } from "../feedback/windows-acl.js"
import { withActiveLexicalGeneration } from "./generations.js"

// The elected controller is the sole writer. No journal operation elects another owner.
export async function openChangeJournal({ root, stateDir, io = filesystem }) {
  root = io.realpathSync(root)
  stateDir = path.resolve(stateDir)
  for (let current = stateDir; ; current = path.dirname(current)) {
    const stat = statIfPresent(io, current)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error("journal has unsafe state directory ancestry")
    }
    if (current === path.dirname(current)) break
  }
  const created = !statIfPresent(io, stateDir)
  io.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const directoryStat = io.lstatSync(stateDir)
  if (process.platform !== "win32" &&
      (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o777) !== 0o700)) {
    throw new Error("journal has unsafe state directory ownership or permissions")
  }
  const logPath = path.join(stateDir, "changes.jsonl")
  const metaPath = path.join(stateDir, "journal.json")
  const entries = [{ path: stateDir, kind: "directory", created }]
  for (const file of [logPath, metaPath]) {
    if (statIfPresent(io, file)) {
      assertSafeFile(io, file)
      entries.push({ path: file, kind: "file", created: false })
    }
  }
  if (process.platform === "win32") await protectWindowsPaths(entries)

  let metadata = statIfPresent(io, metaPath) ? JSON.parse(io.readFileSync(metaPath, "utf8")) : null
  if (metadata && (metadata.root !== root || typeof metadata.id !== "string" || !metadata.id)) {
    throw new Error("journal metadata root or identity is invalid")
  }
  let reason = metadata ? metadata.clean_shutdown ? "watcher_downtime" : "unclean_shutdown" : "initial_scan"
  if (metadata && !statIfPresent(io, logPath)) {
    metadata.id = randomUUID()
    reason = "journal_integrity_failed"
  }
  metadata ??= { id: randomUUID(), root }
  const raw = statIfPresent(io, logPath) ? io.readFileSync(logPath) : Buffer.alloc(0)
  const { records: initialRecords, corrupt } = parseRecords(raw)
  let records = initialRecords
  let persistedBytes = corrupt ? Buffer.from(serialize(records)) : raw
  let poisoned = false
  let integrityError = null
  let closed = false
  if (corrupt) {
    // Persist the original bytes before replacing the derived log with its valid prefix.
    await writeAtomic(io, path.join(stateDir, `changes.corrupt-${randomUUID()}.jsonl`), raw)
    await writeAtomic(io, logPath, serialize(records))
    metadata.id = randomUUID()
    reason = "journal_corrupt"
  }
  if (!statIfPresent(io, logPath)) await writeAtomic(io, logPath, "")
  await writeAtomic(io, metaPath, JSON.stringify({ ...metadata, clean_shutdown: false }))
  let persistedFile = assertSafeFile(io, logPath)

  const cursor = () => ({ journal_id: metadata.id, sequence: records.at(-1)?.sequence ?? 0 })
  let pending = Promise.resolve()
  function serialized(operation) {
    const result = pending.then(operation)
    // The caller retains the rejection; later operations must still reach the poison check.
    pending = result.catch(() => {})
    return result
  }
  function verifyIntegrity() {
    if (poisoned) {
      if (integrityError && reason !== "journal_corrupt") throw integrityError
      return
    }
    let fd
    try {
      const before = assertSafeFile(io, logPath)
      if (!sameFile(before, persistedFile)) throw new Error("journal file was replaced")
      fd = io.openSync(logPath, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW ?? 0))
      if (!sameFile(io.fstatSync(fd), persistedFile)) throw new Error("journal file was replaced")
      const bytes = io.readFileSync(fd)
      const after = assertSafeFile(io, logPath)
      if (!sameFile(after, persistedFile)) throw new Error("journal file was replaced")
      if (!bytes.equals(persistedBytes) || after.size !== persistedBytes.length) {
        poisoned = true
        reason = "journal_corrupt"
        integrityError = new JournalIntegrityError(new Error("journal bytes changed"), reason)
      }
    } catch (cause) {
      poisoned = true
      reason = "journal_integrity_failed"
      integrityError = new JournalIntegrityError(cause)
      throw integrityError
    } finally {
      if (fd !== undefined) io.closeSync(fd)
    }
  }
  return {
    get cursor() { return cursor() },
    appendChange({ root: changedRoot = root, path: changedPath, operation = "write", observedAt = new Date().toISOString() }) {
      return serialized(() => {
        verifyIntegrity()
        if (closed || poisoned) throw new Error("journal must recover before accepting changes")
        if (io.realpathSync(changedRoot) !== root) throw new Error("journal root mismatch")
        const record = {
          sequence: cursor().sequence + 1,
          path: normalizeChangePath(changedPath),
          operation,
          observed_at: observedAt,
        }
        validateRecord(record)
        let fd
        try {
          const before = assertSafeFile(io, logPath)
          fd = io.openSync(logPath, io.constants.O_WRONLY | io.constants.O_APPEND | (io.constants.O_NOFOLLOW ?? 0))
          const opened = io.fstatSync(fd)
          if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) {
            throw new Error("journal has unsafe replaced file")
          }
          const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
          io.writeFileSync(fd, bytes)
          io.fsyncSync(fd)
          persistedBytes = Buffer.concat([persistedBytes, bytes])
          records.push(record)
          return record
        } catch (error) {
          poisoned = true
          reason = "journal_write_failed"
          throw error
        } finally {
          if (fd !== undefined) io.closeSync(fd)
        }
      })
    },
    replay() {
      verifyIntegrity()
      const changes = new Map()
      for (const record of records) {
        if (!record.checkpoint) changes.set(record.path, record)
      }
      return {
        changes: [...changes.values()].sort((a, b) => a.sequence - b.sequence),
        cursor: cursor(),
        certain: reason === null,
        reason,
      }
    },
    reconciled(covered) {
      verifyIntegrity()
      if (poisoned) throw integrityError ?? new Error("journal must recover after a write failure")
      if (covered?.journal_id === metadata.id && covered.sequence === cursor().sequence) reason = null
    },
    compact({ db, generationId }) {
      if (closed || poisoned) throw new Error("journal must recover before compaction")
      const generation = db.prepare("SELECT event_cursor FROM lexical_generations WHERE id = ?").get(generationId)
      if (db.inTransaction || !generation) throw new Error("journal compaction requires a committed generation")
      const covered = JSON.parse(generation.event_cursor)
      if (covered.journal_id !== metadata.id || !Number.isSafeInteger(covered.sequence) ||
          covered.sequence < 0 || covered.sequence > cursor().sequence) {
        throw new Error("journal generation coverage does not match")
      }
      return serialized(async () => {
        const guarded = (replace) => withActiveLexicalGeneration({ db, generationId, eventCursor: covered }, () => {
          verifyIntegrity()
          if (poisoned) throw integrityError ?? new JournalIntegrityError(new Error("journal is poisoned"))
          return replace()
        })
        const anchor = records.findLast((record) => record.sequence <= covered.sequence)
        if (!anchor) return guarded(() => {})
        const retained = [
          { ...anchor, checkpoint: true },
          ...records.filter((record) => record.sequence > covered.sequence),
        ]
        await writeAtomic(io, logPath, serialize(retained), guarded)
        records = retained
        persistedBytes = Buffer.from(serialize(retained))
        persistedFile = assertSafeFile(io, logPath)
      })
    },
    close() {
      return serialized(async () => {
        if (closed) return
        // Removed derived state has no clean-shutdown marker to persist.
        if (statIfPresent(io, stateDir)) {
          await writeAtomic(io, metaPath, JSON.stringify({ ...metadata, clean_shutdown: !poisoned }))
        }
        closed = true
      })
    },
  }
}

export class JournalIntegrityError extends Error {
  constructor(cause, reason = "journal_integrity_failed") {
    super(`journal integrity failed; recovery required: ${cause.message}`, { cause })
    this.code = "journal_integrity_failed"
    this.reason = reason
  }
}

export function normalizeChangePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      path.win32.isAbsolute(value) || path.posix.isAbsolute(value) ||
      value.includes(":") || value.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
    throw new Error("journal requires a workspace-relative file path")
  }
  return value.replaceAll("\\", "/")
}

export class CanonicalWriteRecordingError extends Error {
  constructor({ paths, recordedPaths, cause, invalidationError }) {
    super("Canonical files were written or moved, but durable change recording failed; do not repeat the canonical mutation.", { cause })
    this.code = "canonical_write_recording_failed"
    this.canonical_written = true
    this.journal_recorded = false
    this.retryable = false
    this.paths = paths
    this.recorded_paths = recordedPaths
    this.invalidation_error = invalidationError?.message ?? null
  }

  toJSON() {
    return {
      status: "partial_operation", code: this.code, message: this.message,
      canonical_written: this.canonical_written, journal_recorded: this.journal_recorded,
      retryable: this.retryable, paths: this.paths, recorded_paths: this.recorded_paths,
      invalidation_error: this.invalidation_error,
      recording_error: this.cause?.message ?? String(this.cause),
    }
  }
}

export async function recordCanonicalChanges({ root, readiness, changes }) {
  // Unadmitted library callers retain their file-only API; admitted dispatch always supplies readiness.
  if (readiness === undefined) return
  const paths = changes.map((change) => change.path.replaceAll("\\", "/"))
  const recordedPaths = []
  try {
    for (const change of changes) {
      const acknowledgement = await readiness.recordChange({
        root, path: normalizeChangePath(change.path), operation: change.operation ?? "write",
        observedAt: new Date().toISOString(),
      })
      if (acknowledgement?.recorded !== true) throw new Error("controller did not acknowledge durable recording")
      recordedPaths.push(change.path.replaceAll("\\", "/"))
    }
  } catch (cause) {
    let invalidationError
    try { await readiness.markUncertain("journal_write_failed") } catch (error) { invalidationError = error }
    throw new CanonicalWriteRecordingError({ paths, recordedPaths, cause, invalidationError })
  }
}

function validateRecord(record) {
  normalizeChangePath(record.path)
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
      !["write", "delete"].includes(record.operation) ||
      typeof record.observed_at !== "string" || !Number.isFinite(Date.parse(record.observed_at))) {
    throw new Error("invalid journal record")
  }
}

function parseRecords(raw) {
  const records = []
  let offset = 0
  while (offset < raw.length) {
    const end = raw.indexOf(0x0a, offset)
    if (end < 0) return { records, corrupt: true }
    try {
      const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(offset, end)))
      validateRecord(record)
      if ((records.length && record.sequence !== records.at(-1).sequence + 1) ||
          (record.checkpoint && records.length) ||
          (!records.length && record.sequence !== 1 && record.checkpoint !== true)) {
        throw new Error("journal sequence gap")
      }
      records.push(record)
    } catch {
      return { records, corrupt: true }
    }
    offset = end + 1
  }
  return { records, corrupt: false }
}

function serialize(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("")
}

function statIfPresent(io, file) {
  try { return io.lstatSync(file) } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function sameFile(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.nlink === 1
}

function assertSafeFile(io, file) {
  const stat = io.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600))) {
    throw new Error("journal has unsafe file ownership, type or permissions")
  }
  return stat
}

async function writeAtomic(io, target, contents, replace = (operation) => operation()) {
  if (statIfPresent(io, target)) assertSafeFile(io, target)
  const temporary = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = io.openSync(temporary, "wx", 0o600)
    if (process.platform === "win32") {
      await protectWindowsPaths([{ path: temporary, kind: "file", created: true }])
    }
    io.writeFileSync(fd, contents)
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = undefined
    replace(() => {
      io.renameSync(temporary, target)
      // Windows does not expose POSIX directory fsync; file handles are flushed above.
      if (process.platform !== "win32") {
        const directory = io.openSync(path.dirname(target), "r")
        try { io.fsyncSync(directory) } finally { io.closeSync(directory) }
      }
    })
  } finally {
    if (fd !== undefined) io.closeSync(fd)
    if (statIfPresent(io, temporary)) io.unlinkSync(temporary)
  }
}
