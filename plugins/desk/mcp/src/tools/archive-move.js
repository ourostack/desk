import { promises as fs } from "node:fs"
import { constants as FS } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

async function openAggregateSession(plan, dependencies) {
  const io = dependencies.fs ?? fs
  let admitted = false, moved = false, closed = false, retain = false
  const created = new Map(), stages = new Map(), receipt = plan.receipt
  let marker
  const failure = (message) => Object.assign(new Error(`task_archive: ${message}`), { code: "archive_changed" })
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const event = (kind, file) => {
    if (receipt.effects.length >= 4096) throw failure("archive effect record bound exceeded")
    const record = { kind, file, attempted: true, returned: false }
    receipt.effects.push(record)
    return record
  }
  const attach = error => {
    retain ||= receipt.effects.some(item => item.kind === "move" || item.kind === "replace" || !item.returned)
    if (error !== null && (typeof error === "object" || typeof error === "function") && Object.isExtensible(error)) {
      error.archiveAggregate = receipt; error.aggregateRetain = retain
    } else receipt.primaryErrorAttachment = "unavailable"
    return error
  }
  const writeOwned = async (entry, bytes, label) => {
    entry.record.plannedBytes = bytes.length; entry.record.returnedBytes = 0
    entry.record.writeCalls = 0; entry.record.unknownReturns = 0
    let offset = 0
    while (offset < bytes.length) {
      let invoked = false, captured = false
      const length = Math.min(65536, bytes.length - offset)
      try {
        await plan.step(label, () => {
          invoked = true; entry.record.writeCalls++
          return entry.handle.write(bytes, offset, length, offset)
        }, result => {
          const count = result?.bytesWritten
          if (!Number.isSafeInteger(count) || count <= 0 || count > length) throw failure("archive write returned an invalid count")
          offset += count; entry.record.returnedBytes += count; captured = true
        })
      } catch (error) { if (invoked && !captured) entry.record.unknownReturns++; throw error }
    }
  }
  return {
    aggregate: true,
    get receipt() { return receipt },
    get retain() { return retain },
    async admit() {
      if (admitted || closed) throw failure("aggregate session cannot be reused")
      try {
        await plan.assertCurrent()
        const file = path.join(plan.source, plan.markerName), bytes = Buffer.from('{"state":"unfinished"}\n')
        const record = event("marker_create", file)
        retain = true
        const entry = await plan.open(file, FS.O_RDWR | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_NONBLOCK,
          "archive operation marker", 0o600)
        record.returned = true
        const original = await plan.step("marker original descriptor", () => entry.handle.stat({ bigint: true }))
        record.identity = plan.identity(original)
        receipt.marker = { identity: record.identity, retired: false }
        if (!original.isFile() || original.nlink !== 1n || (original.mode & 0o777n) !== 0o600n)
          throw failure("archive marker is not a private single-link regular file")
        await writeOwned(entry, bytes, "archive marker positional write")
        const completed = await plan.step("marker completed descriptor", () => entry.handle.stat({ bigint: true }))
        const named = await plan.step("marker created name", () => io.lstat(file, { bigint: true }))
        if (plan.identity(completed) !== record.identity || completed.nlink !== 1n || completed.mode !== original.mode ||
          !same(plan.version(completed), plan.version(named)) || !(await plan.readBytes(entry, bytes.length)).equals(bytes))
          throw failure("archive marker is not the original exclusively created inode")
        const row = await plan.ownFile(file, entry, completed, bytes)
        marker = { row, identity: record.identity }
        await plan.refreshDirectory(plan.sourceRow, [[plan.markerName, plan.childStamp(completed)]])
        await plan.assertCurrent()
        admitted = true
      } catch (error) { throw attach(error) }
    },
    async create(directory, recordMade) {
      if (!admitted || moved || closed || directory !== path.dirname(plan.destination)) throw failure("archive parent creation is not admitted")
      const missing = []
      for (let cursor = directory; !plan.parentRow(cursor); cursor = path.dirname(cursor)) {
        if (cursor === path.dirname(cursor) || !cursor.startsWith(`${plan.root}${path.sep}`)) throw failure("archive parent leaves its admitted root")
        missing.push(cursor)
      }
      try {
        for (const file of missing.reverse()) {
          await plan.assertCurrent()
          const parent = plan.parentRow(path.dirname(file))
          let found
          try { found = await plan.step("parent absence", () => io.lstat(file, { bigint: true })) }
          catch (error) { if (error.code !== "ENOENT") throw error }
          if (found) throw failure("an archive parent appeared after admission")
          const record = event("mkdir", file)
          await plan.step("owned archive parent mkdir", () => io.mkdir(file, { mode: 0o700 }), () => { record.returned = true })
          retain = true
          const original = await plan.step("created parent original name", () => io.lstat(file, { bigint: true }))
          if (!original.isDirectory() || original.isSymbolicLink() || (original.mode & 0o777n) !== 0o700n)
            throw failure("created parent type/mode is unqualified")
          record.identity = plan.identity(original)
          const entry = await plan.open(file, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK, "created archive parent")
          const stat = await plan.step("created parent descriptor", () => entry.handle.stat({ bigint: true }))
          const named = await plan.step("created parent name", () => io.lstat(file, { bigint: true }))
          if (!stat.isDirectory() || !same(plan.version(original), plan.version(stat)) ||
            !same(plan.version(stat), plan.version(named))) throw failure("created parent identity is unknown")
          const row = await plan.ownDirectory(file, entry, stat)
          await plan.refreshDirectory(parent, [[path.basename(file), plan.childStamp(stat)]])
          created.set(file, row); record.identity = plan.identity(stat); recordMade(file)
          retain = false
        }
      } catch (error) { retain = true; throw attach(error) }
    },
    async remove(file) {
      const row = created.get(file)
      if (!row || retain || moved || closed) throw failure("created directory cleanup is not qualified")
      await plan.assertCurrent()
      if (row.children.size) throw failure("created archive parent is not empty")
      const parent = plan.parentRow(path.dirname(file))
      await plan.step("remove own empty archive parent", () => io.rmdir(file))
      plan.rows.delete(row.relative)
      await plan.refreshDirectory(parent, [[path.basename(file), null]])
      created.delete(file)
    },
    async move(beforeMove) {
      if (!admitted || moved || closed || typeof beforeMove !== "function") throw failure("aggregate move requires one admitted session")
      try {
        await beforeMove(); await plan.assertCurrent()
        const source = plan.rows.get(plan.sourcePrefix)
        const oldParent = plan.parentRow(path.dirname(plan.source)), newParent = plan.parentRow(path.dirname(plan.destination))
        if (!newParent) throw failure("archive parent has not been qualified")
        const record = event("move", plan.source)
        retain = true
        await plan.step("archive directory rename", () => io.rename(plan.source, plan.destination), () => {
          record.returned = true; moved = true; plan.markMoved(); record.destination = plan.destination
        })
        await plan.refreshDirectory(oldParent, [[path.basename(plan.source), null]])
        await plan.refreshDirectory(newParent, [[path.basename(plan.destination), plan.childStamp(source.stat)]])
        await plan.refreshDirectory(source, [])
        await plan.assertCurrent()
      } catch (error) { throw attach(error) }
    },
    async applyFiles() {
      if (!moved || closed) throw failure("aggregate file application requires its original completed move")
      try {
        for (const row of plan.changed) {
          await plan.assertCurrent()
          const target = plan.currentPath(row), parent = plan.parentRow(path.dirname(target))
          if (!parent) throw failure("replacement parent is not admitted")
          const temporary = `${target}.desk-archive-${randomUUID()}.tmp`
          const record = event("stage", temporary)
          const entry = await plan.open(temporary, FS.O_RDWR | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_NONBLOCK,
            "archive replacement", 0o600)
          const originalStage = await plan.step("created stage identity", () => entry.handle.stat({ bigint: true }))
          if (!originalStage.isFile() || originalStage.nlink !== 1n) throw failure("archive stage is not a single-link regular file")
          stages.set(temporary, { entry, identity: plan.identity(originalStage) })
          record.identity = plan.identity(originalStage); record.returned = true
          await plan.refreshDirectory(parent, [[path.basename(temporary), plan.childStamp(originalStage)]])
          await writeOwned(entry, row.finalBytes, "archive positional write")
          await plan.step("archive replacement mode", () => entry.handle.chmod(row.mode))
          if (!(await plan.readBytes(entry, row.finalBytes.length)).equals(row.finalBytes)) throw failure("archive stage bytes differ from the final map")
          const staged = await plan.step("completed stage identity", () => entry.handle.stat({ bigint: true }))
          if (plan.identity(staged) !== plan.identity(originalStage) || staged.nlink !== 1n ||
            Number(staged.mode & 0o777n) !== row.mode) throw failure("archive stage identity/mode changed")
          await plan.assertCurrent()
          const stageName = await plan.step("rename source name", () => io.lstat(temporary, { bigint: true }))
          const stageFD = await plan.step("rename source descriptor", () => entry.handle.stat({ bigint: true }))
          if (!same(plan.version(staged), plan.version(stageName)) || !same(plan.version(staged), plan.version(stageFD)) ||
            !(await plan.readBytes(entry, row.finalBytes.length)).equals(row.finalBytes)) throw failure("archive rename source is not the owned staged version")
          await plan.assertReplacementTarget(row)
          const replacement = event("replace", target)
          await plan.step("archive owner replacement", () => io.rename(temporary, target), () => { replacement.returned = true })
          const installed = await plan.step("installed name", () => io.lstat(target, { bigint: true }))
          const opened = await plan.step("installed owned descriptor", () => entry.handle.stat({ bigint: true }))
          if (plan.identity(installed) !== plan.identity(staged) || !same(plan.version(installed), plan.version(opened)) ||
            installed.mode !== staged.mode || installed.size !== staged.size || installed.mtimeNs !== staged.mtimeNs ||
            installed.nlink !== 1n || !(await plan.readBytes(entry, row.finalBytes.length)).equals(row.finalBytes))
            throw failure("installed archive file is not the previously owned stage")
          row.entry = entry; row.stat = opened; row.version = plan.version(opened); row.expectedBytes = row.finalBytes
          stages.delete(temporary)
          await plan.refreshDirectory(parent, [[path.basename(temporary), null], [path.basename(target), plan.childStamp(opened)]])
        }
        await plan.assertCurrent()
        receipt.effectsCompleted = true
      } catch (error) { throw attach(error) }
    },
    async close(primary) {
      if (closed) return
      closed = true
      try {
        if (!primary && receipt.effectsCompleted) {
          await plan.assertCurrent()
          receipt.finalValidated = true
        }
        await plan.close()
        receipt.closed = true
        if (plan.now() >= plan.evidenceDeadline) throw failure("archive evidence/descriptor settlement deadline expired")
        if (primary || !receipt.finalValidated || !marker) return
        // Closed descriptors cannot be reused. Renew the previously observed named versions, not new expected bytes.
        await plan.assertCurrent()
        const file = plan.currentPath(marker.row)
        const named = await plan.step("marker retirement name", () => io.lstat(file, { bigint: true }))
        if (plan.identity(named) !== marker.identity || !same(plan.version(named), marker.row.version))
          throw failure("archive marker retirement lost its original inode")
        const record = event("marker_retire", file)
        await plan.step("retire original archive marker", () => io.unlink(file), () => { record.returned = true })
        let remaining
        try { remaining = await plan.step("marker retired absence", () => io.lstat(file, { bigint: true })) }
        catch (error) { if (error.code !== "ENOENT") throw error }
        if (remaining) throw failure("archive marker retirement is unqualified")
        receipt.marker.retired = true
        receipt.phase = "final_complete"
        plan.rows.delete(marker.row.relative)
        plan.sourceRow.children.delete(plan.markerName)
        await plan.refreshDirectory(plan.sourceRow, [[plan.markerName, null]])
        await plan.assertCurrent()
        retain = false
      } catch (error) {
        try { await plan.close() } catch (closeError) { receipt.closeFailure = closeError.message }
        throw attach(error)
      }
    },
  }
}

// The default task lifecycle captures before its corresponding prepareArchiveState.
// A moveArchive override is a legacy transport seam, never default-native proof.
export async function openArchiveMoveSession({ source, destination, aggregate }, dependencies = {}) {
  if (aggregate) {
    if ((dependencies.platform ?? process.platform) !== "darwin" && (dependencies.platform ?? process.platform) !== "linux")
      throw new Error("task_archive: aggregate archive provider is POSIX-only")
    return openAggregateSession(aggregate, dependencies)
  }
  if ((dependencies.platform ?? process.platform) === "win32") {
    const { openArchiveHandleSession } = await import("./archive-native-session.js")
    return openArchiveHandleSession({ source, destination }, dependencies)
  }
  return {
    async admit() {},
    async move(beforeMove) {
      await beforeMove()
      await fs.rename(source, destination)
    },
    async close() {},
  }
}
