// Scoped checks for the ordinary archive primitive, not mutation custody.
// Nonparticipating editors are not excluded; late failures retain actual state.
import { promises as fs } from "node:fs"
import { constants as FS } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { caseFold } from "unicode-case-folding"
import { isPathContained } from "../util/paths.js"
import { indexEntries, stagePaths, commitIndexPaths } from "../util/git-stage.js"
import { setTaskArchiveLinks } from "./track-row.js"
import { setTaskState } from "./track-row.js"
import { planArchiveLinks } from "../util/archive-link-plan.js"
import markdown from "../util/markdown-links.cjs"

export const ARCHIVE_LIMITS = Object.freeze({ directories: 512, entries: 4096, depth: 16, documents: 256,
  documentBytes: 1048576, textBytes: 16777216, totalBytes: 67108864,
  changedFiles: 64, changedBytes: 8388608, references: 4096 })
const aggregateVersion = stat => Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]))
const aggregateIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const aggregateFault = (code, message) => Object.assign(new Error(`task_archive: ${message}`), { code })
const ARCHIVE_MARKER = ".desk-archive-operation.json"
const markerDirectoryId = stat => `${aggregateIdentity(stat)}:${stat.birthtimeNs}`

/** Presence is a negative compatibility signal, never a parsed permission or completion record. */
export async function archiveMarkerState({ effectiveRoot, srcDir, archiveDir, deadline, expected }) {
  const observed = []
  const checkpoint = () => {
    if (deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline))
      throw aggregateFault("archive_deadline", "archive marker observation expired")
  }
  const read = async (label, work) => { checkpoint(); const value = await work(); checkpoint(); return value }
  try {
    const root = await read("root realpath", () => fs.realpath(effectiveRoot))
    const rootStat = await read("root marker stat", () => fs.lstat(root, { bigint: true }))
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unqualified marker root")
    const bindings = { root: markerDirectoryId(rootStat), source: null, destination: null }
    observed.push({ path: root, version: aggregateVersion(rootStat), absent: false })
    for (const [placement, logical] of [["source", srcDir], ["destination", archiveDir]]) {
      const suffix = path.relative(effectiveRoot, logical)
      if (path.isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${path.sep}`)) throw new Error("marker observation leaves scope")
      let cursor = root, directory, missing = false
      for (const name of suffix.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, name)
        let stat
        try { stat = await read("marker ancestry", () => fs.lstat(cursor, { bigint: true })) }
        catch (error) {
          if (error.code !== "ENOENT") throw error
          observed.push({ path: cursor, absent: true }); missing = true; break
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw aggregateFault("archive_marker_unsafe_ancestry", "unsafe marker ancestry")
        observed.push({ path: cursor, version: aggregateVersion(stat), absent: false })
        directory = stat
      }
      if (missing) continue
      if (!directory) directory = rootStat
      bindings[placement] = markerDirectoryId(directory)
      const file = path.join(cursor, ARCHIVE_MARKER)
      try {
        const stat = await read("marker presence", () => fs.lstat(file, { bigint: true }))
        return { state: "present", placement, path: file, bindings, markerIdentity: aggregateIdentity(stat) }
      } catch (error) { if (error.code !== "ENOENT") throw error }
    }
    for (const item of observed) {
      let stat
      try { stat = await read("marker placement recheck", () => fs.lstat(item.path, { bigint: true })) }
      catch (error) { if (error.code !== "ENOENT") throw error }
      if (item.absent ? stat !== undefined : !stat || !sameValue(aggregateVersion(stat), item.version))
        throw new Error("marker directory placement changed during observation")
    }
    if (expected && !sameValue(expected, bindings)) throw new Error("selected archive directory generation changed")
    checkpoint()
    return { state: "absent", bindings }
  } catch (error) {
    return { state: "unverified", reason: error.code ?? "archive_marker_unverified" }
  }
}

/** Metadata-only routing; it never asks Git to discover a repository. */
export async function archiveHasGit(root, deadline, now = Date.now) {
  if (now() >= deadline) throw aggregateFault("archive_deadline", "archive admission deadline expired")
  for (let cursor = await fs.realpath(root); ; cursor = path.dirname(cursor)) {
    if (now() >= deadline) throw aggregateFault("archive_deadline", "archive admission deadline expired")
    try { await fs.lstat(path.join(cursor, ".git")); return true }
    catch (error) { if (error.code !== "ENOENT") throw error }
    if (now() >= deadline) throw aggregateFault("archive_deadline", "archive admission deadline expired")
    if (path.dirname(cursor) === cursor) return false
  }
}

/** Original observations and prospective bytes, owned by one live archive session. */
export async function prepareArchiveAggregate({ effectiveRoot, srcDir, archiveDir, slug, trackFile,
  deadline, evidenceDeadline, composeCard, status, cardObservation, now = Date.now, limits = ARCHIVE_LIMITS }) {
  const receipt = { scope: "posix_no_git_archive", deadline, evidenceDeadline, effects: [], descriptors: [], directoryReaders: [],
    observation: "optimistic_currentness", coverage: "effective_person_root_with_typed_external_storage_boundaries" }
  const rows = new Map(), handles = new Set(), directoryReaders = new Set()
  let closed = false, moved = false, admittedBytes = 0, textBytes = 0, documentCount = 0, referenceCount = 0
  let observedEntries = 1
  const counts = { entries: 0, directories: 0 }
  const check = () => {
    if (now() >= deadline) throw aggregateFault("archive_deadline", "archive admission/effect deadline expired")
  }
  const step = async (label, work, capture) => {
    check()
    const result = await work()
    capture?.(result)
    check()
    return result
  }
  const closeHandle = async (entry) => {
    if (entry.closed || entry.closeUnknown) return
    try {
      await entry.handle.close(); entry.closed = true; entry.record.closed = true
      entry.record.closedAt = now(); entry.record.lateClose = now() >= evidenceDeadline
    }
    catch (error) { entry.closeUnknown = true; entry.record.closeUnknown = true; throw error }
  }
  const close = async () => {
    if (closed) return
    closed = true
    let primary
    for (const resources of [directoryReaders, handles]) for (const entry of resources) {
      try { await closeHandle(entry) } catch (error) { primary ??= error }
    }
    if (receipt.directoryReaders.some(record => record.acquireUnknown || record.closeUnknown))
      primary ??= aggregateFault("archive_directory_unknown", "archive directory-reader settlement is unqualified")
    if (now() >= evidenceDeadline) primary ??= aggregateFault("archive_evidence_deadline", "archive descriptor settlement exceeded its original evidence cutoff")
    if (primary) { if (Object.isExtensible(primary)) primary.archiveAggregate = receipt; throw primary }
  }
  const open = async (file, flags, purpose, mode) => {
    const record = { file, purpose, acquired: false, closed: false }
    receipt.descriptors.push(record)
    let entry
    await step(`open ${purpose}`, () => fs.open(file, flags, mode), handle => {
      entry = { handle, record, closed: false }
      handles.add(entry); record.acquired = true; record.fd = handle.fd; record.openedAt = now()
    })
    return entry
  }
  const readNames = async (file, maximum, code, reserve = false) => {
    const record = { file, acquired: false, closed: false, entriesRead: 0, retained: 0, readAttempts: 0, unknownReturns: 0 }
    receipt.directoryReaders.push(record)
    if (closed) receipt.closed = false
    let entry, primary
    try {
      await step("open bounded directory reader", () => {
        record.acquireAttempted = true
        return fs.opendir(file, { bufferSize: 1 })
      }, handle => {
        entry = { handle, record, closed: false }
        directoryReaders.add(entry); record.acquired = true; record.openedAt = now()
      })
      const names = []
      for (;;) {
        let invoked = false, captured = false, next
        try {
          next = await step("bounded directory read", () => {
            invoked = true; record.readAttempts++
            return entry.handle.read()
          }, value => {
            if (value !== null && typeof value?.name !== "string")
              throw aggregateFault("archive_directory_unknown", "directory reader returned an invalid entry")
            if (value !== null) record.entriesRead++
            captured = true
          })
        } catch (error) { if (invoked && !captured) record.unknownReturns++; throw error }
        if (next === null) break
        if (names.length >= maximum) throw aggregateFault(code, "archive directory entry/member limit exceeded")
        if (reserve) observedEntries++
        names.push(next.name); record.retained = names.length
      }
      return names.sort()
    } catch (error) {
      primary = error
      if (record.acquireAttempted && !entry) record.acquireUnknown = true
      throw error
    } finally {
      if (entry) {
        try { await closeHandle(entry) }
        catch (error) {
          if (!primary) throw error
          receipt.directoryCloseFailure = error.message
          console.error("desk_archive: directory_close_unqualified")
        }
      }
      if (closed) receipt.closed = [...handles, ...directoryReaders].every(resource => resource.closed) &&
        !receipt.directoryReaders.some(item => item.acquireUnknown || item.closeUnknown)
      if (!primary) check()
    }
  }
  const root = await step("root", () => fs.realpath(effectiveRoot))
  const source = path.join(root, path.relative(effectiveRoot, srcDir))
  const destination = path.join(root, path.relative(effectiveRoot, archiveDir))
  if (!isPathContained(root, source) || !isPathContained(root, destination))
    throw aggregateFault("archive_scope", "archive path leaves the effective person root")
  const sourcePrefix = relative(root, source), destinationPrefix = relative(root, destination)
  const markerState = await archiveMarkerState({ effectiveRoot, srcDir, archiveDir, deadline })
  if (markerState.state !== "absent") throw aggregateFault("archive_marker_pending", "unqualified_original_map")
  const currentPath = row => moved && (row.relative === sourcePrefix || row.relative.startsWith(`${sourcePrefix}/`))
    ? path.join(destination, row.relative.slice(sourcePrefix.length)) : row.path
  const kind = stat => stat.isDirectory() ? "directory" : stat.isFile() ? "regular_file" : "unsupported"
  const childStamp = stat => ({ identity: aggregateIdentity(stat), kind: kind(stat) })
  const readBytes = async (entry, expectedSize) => {
    const buffer = Buffer.alloc(65536), chunks = []
    let position = 0
    for (;;) {
      const { bytesRead } = await step("descriptor read", () => entry.handle.read(buffer, 0,
        Math.min(buffer.length, expectedSize - position + 1), position))
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length ||
        position + bytesRead > expectedSize) throw aggregateFault("archive_changed", "descriptor bytes changed during read")
      if (bytesRead) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      position += bytesRead
      if (bytesRead === 0) {
        if (position !== expectedSize) throw aggregateFault("archive_changed", "descriptor ended before its admitted size")
        return Buffer.concat(chunks, position)
      }
    }
  }
  const content = async row => {
    if (row.before !== undefined) return row.before
    const size = Number(row.stat.size)
    if (!Number.isSafeInteger(size) || size < 0 || admittedBytes + size > limits.totalBytes)
      throw aggregateFault("archive_limit", "archive companion/target byte limit exceeded")
    admittedBytes += size
    row.entry = await open(row.path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK, "original file")
    const before = await step("opened file stat", () => row.entry.handle.stat({ bigint: true }))
    if (!sameValue(aggregateVersion(before), row.version)) throw aggregateFault("archive_changed", "opened file is not the original admitted version")
    row.before = await readBytes(row.entry, size)
    const after = await step("read file stat", () => row.entry.handle.stat({ bigint: true }))
    const named = await step("read named stat", () => fs.lstat(row.path, { bigint: true }))
    if (!sameValue(aggregateVersion(before), aggregateVersion(after)) ||
      !sameValue(aggregateVersion(before), aggregateVersion(named))) throw aggregateFault("archive_changed", "archive input changed while reading")
    row.expectedBytes = row.before
    return row.before
  }
  const visit = async (file, depth) => {
    check()
    if (depth > limits.depth || counts.entries >= limits.entries) throw aggregateFault("archive_limit", "archive inventory entry/depth limit exceeded")
    const stat = await step("inventory stat", () => fs.lstat(file, { bigint: true }))
    const type = kind(stat), rel = relative(root, file)
    if (type === "unsupported" || stat.isSymbolicLink() || type === "regular_file" && (stat.nlink !== 1n || (stat.mode & 0o7000n) !== 0n))
      throw aggregateFault("archive_unsafe_type", "archive inventory contains a symlink, alias or unsupported file")
    const storage = [".git", "node_modules"].includes(path.basename(file))
    if (storage && (rel === sourcePrefix || rel.startsWith(`${sourcePrefix}/`)))
      throw aggregateFault("archive_scope", "excluded storage inside the moved source cannot be admitted")
    if (storage && type !== "directory")
      throw aggregateFault("archive_unsafe_type", "excluded storage boundary must be a directory")
    counts.entries++
    const row = { path: file, relative: rel, stat, version: aggregateVersion(stat), type,
      mode: Number(stat.mode & 0o777n), children: null }
    if (rel === `${sourcePrefix}/task.md` && cardObservation &&
      (cardObservation.state !== "present" || !sameValue(row.version, cardObservation.version) ||
        row.mode !== cardObservation.mode))
      throw aggregateFault("archive_card_changed", "original completion card changed before inventory read")
    rows.set(rel, row)
    if (type === "directory") {
      if (++counts.directories > limits.directories) throw aggregateFault("archive_limit", "archive directory limit exceeded")
      row.entry = await open(file, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | FS.O_NONBLOCK, "directory")
      if (storage) { row.opaque = true; return row }
      row.children = new Map()
      const names = await readNames(file, limits.entries - observedEntries, "archive_limit", true)
      for (const name of names) {
        const child = await visit(path.join(file, name), depth + 1)
        row.children.set(name, childStamp(child.stat))
      }
      const named = await step("directory readback", () => fs.lstat(file, { bigint: true }))
      if (!sameValue(row.version, aggregateVersion(named))) throw aggregateFault("archive_changed", "directory membership changed during inventory")
    } else if (/\.(?:md|markdown)$/iu.test(file)) {
      const size = Number(stat.size)
      if (++documentCount > limits.documents || size > limits.documentBytes || textBytes + size > limits.textBytes)
        throw aggregateFault("archive_limit", "archive Markdown inventory exceeds its byte/file bound")
      textBytes += size
      await content(row)
    } else if (rel === sourcePrefix || rel.startsWith(`${sourcePrefix}/`)) await content(row)
    return row
  }
  const assertDirectory = async row => {
    const file = currentPath(row)
    if (row.entry.closeUnknown) throw aggregateFault("archive_changed", "directory descriptor closure is unqualified")
    const opened = row.entry.closed ? null : await step("directory fd currentness", () => row.entry.handle.stat({ bigint: true }))
    const named = await step("directory named currentness", () => fs.lstat(file, { bigint: true }))
    if (row.opaque) {
      if (!named.isDirectory() || aggregateIdentity(named) !== aggregateIdentity(row.stat) || named.mode !== row.stat.mode ||
        opened && (aggregateIdentity(opened) !== aggregateIdentity(row.stat) || opened.mode !== row.stat.mode))
        throw aggregateFault("archive_changed", "excluded directory boundary changed after admission")
      return
    }
    if (opened && !sameValue(aggregateVersion(opened), row.version) || !sameValue(aggregateVersion(named), row.version))
      throw aggregateFault("archive_changed", "directory generation/version changed after admission")
    const names = await readNames(file, row.children.size, "archive_changed")
    if (!sameValue(names, [...row.children.keys()].sort())) throw aggregateFault("archive_changed", "directory members changed after admission")
    for (const [name, expected] of row.children) {
      const stat = await step("directory child identity", () => fs.lstat(path.join(file, name), { bigint: true }))
      if (!sameValue(childStamp(stat), expected)) throw aggregateFault("archive_changed", "directory child identity changed")
    }
  }
  const assertFile = async row => {
    const file = currentPath(row)
    const named = await step("file named currentness", () => fs.lstat(file, { bigint: true }))
    if (!sameValue(aggregateVersion(named), row.version)) throw aggregateFault("archive_changed", "file generation/version changed after admission")
    if (row.entry?.closeUnknown) throw aggregateFault("archive_changed", "file descriptor closure is unqualified")
    if (row.entry && !row.entry.closed) {
      const opened = await step("file descriptor currentness", () => row.entry.handle.stat({ bigint: true }))
      if (!sameValue(aggregateVersion(opened), row.version) ||
        !(await readBytes(row.entry, row.expectedBytes.length)).equals(row.expectedBytes))
        throw aggregateFault("archive_changed", "held input bytes changed after admission")
      const after = await step("file fd after read", () => row.entry.handle.stat({ bigint: true }))
      if (!sameValue(aggregateVersion(after), row.version))
        throw aggregateFault("archive_changed", "original file changed during currentness read")
    }
  }
  const assertCurrent = async () => {
    check()
    if (await archiveHasGit(root, deadline, now)) throw aggregateFault("archive_git_changed", "a Git marker appeared during noGit archive admission")
    for (const row of rows.values()) {
      if (row.type === "directory") await assertDirectory(row)
      else await assertFile(row)
    }
    check()
  }
  const assertReplacementTarget = async row => {
    const file = currentPath(row), parent = parentRow(path.dirname(file))
    if (!parent || !row.entry || row.entry.closed || row.entry.closeUnknown)
      throw aggregateFault("archive_changed", "original replacement admission is unavailable")
    await assertDirectory(parent)
    await assertFile(row)
    const directory = await step("last original parent admission", () => fs.lstat(path.dirname(file), { bigint: true }))
    if (!sameValue(aggregateVersion(directory), parent.version))
      throw aggregateFault("archive_changed", "original replacement parent changed")
    const named = await step("last original target admission", () => fs.lstat(file, { bigint: true }))
    if (!sameValue(aggregateVersion(named), row.version))
      throw aggregateFault("archive_changed", "original replacement target changed")
  }
  const parentRow = file => [...rows.values()].find(row => row.type === "directory" && currentPath(row) === file)
  const refreshDirectory = async (row, changes) => {
    const expected = new Map(row.children)
    for (const [name, next] of changes) {
      if (next === null) expected.delete(name)
      else expected.set(name, next)
    }
    const file = currentPath(row)
    if (row.entry.closeUnknown) throw aggregateFault("archive_changed", "parent descriptor closure is unqualified")
    const stat = await step("own parent transition", () => row.entry.closed
      ? fs.lstat(file, { bigint: true }) : row.entry.handle.stat({ bigint: true }))
    const named = await step("own parent name transition", () => fs.lstat(file, { bigint: true }))
    if (aggregateIdentity(stat) !== aggregateIdentity(row.stat) || stat.mode !== row.stat.mode ||
      !sameValue(aggregateVersion(stat), aggregateVersion(named))) throw aggregateFault("archive_changed", "own parent generation changed")
    row.children = expected; row.stat = stat; row.version = aggregateVersion(stat)
    await assertDirectory(row)
  }
  try {
    await visit(root, 0)
    if (rows.has(destinationPrefix)) throw aggregateFault("archive_occupied", "archive destination is occupied")
    if (cardObservation) {
      const card = rows.get(`${sourcePrefix}/task.md`)
      if (cardObservation.state === "absent" ? card !== undefined :
        cardObservation.state !== "present" || !card || card.type !== "regular_file" ||
        !Buffer.isBuffer(cardObservation.bytes) || !card.before?.equals(cardObservation.bytes) ||
        card.mode !== cardObservation.mode || !sameValue(card.version, cardObservation.version))
        throw aggregateFault("archive_card_changed", "original completion card differs from aggregate admission")
      receipt.completionCard = Object.freeze({ state: cardObservation.state,
        ...(card ? { identity: aggregateIdentity(card.stat), version: Object.freeze({ ...card.version }),
          mode: card.mode, byteCount: card.before.length, sha256: hash(card.before) } : {}) })
    }
    const documents = [], entries = [...rows.values()].map(row => ({
      path: row.relative === "" ? "." : row.relative, type: row.type, ancestry: ["directory"],
    }))
    for (const row of rows.values()) if (row.before !== undefined && /\.(?:md|markdown)$/iu.test(row.relative)) {
      let text
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row.before) }
      catch { throw aggregateFault("archive_encoding", "archive Markdown must be lossless UTF-8") }
      const extracted = markdown.extractMarkdownLinks(text, { foldLabel: caseFold })
      if (extracted.diagnostics.some(item => item.code === "parse_budget_exceeded"))
        throw aggregateFault("archive_parse", "archive link extraction exceeded its bound")
      referenceCount += extracted.links.length
      if (referenceCount > limits.references) throw aggregateFault("archive_limit", "archive reference limit exceeded")
      for (const link of extracted.links) {
        const value = link.destination
        if (!value || /^[/?#]/u.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) continue
        let target
        try {
          if (value.includes("\\") || /%(?:2f|5c)/iu.test(value)) throw new Error("ambiguous separator")
          target = path.posix.normalize(path.posix.join(path.posix.dirname(row.relative), decodeURIComponent(value.split(/[?#]/u, 1)[0]))).replace(/\/$/u, "")
        } catch { throw aggregateFault("archive_target", "archive local target encoding/separator is unqualified") }
        if (target === ".." || target.startsWith("../") || path.posix.isAbsolute(target))
          throw aggregateFault("archive_scope", "archive link target leaves the effective person root")
        const referent = rows.get(target === "." ? "" : target)
        if (!referent) throw aggregateFault("archive_target", `archive local target is missing: ${target}`)
        if (referent.type === "regular_file") await content(referent)
      }
      documents.push({ path: row.relative, before: row.before, mode: row.mode,
        identity: { dev: String(row.stat.dev), ino: String(row.stat.ino), type: row.type },
        version: { size: String(row.stat.size), mtimeNs: String(row.stat.mtimeNs), ctimeNs: String(row.stat.ctimeNs) },
        ancestry: ["directory"], observation: "stable" })
    }
    const plan = planArchiveLinks({ sourcePrefix, destinationPrefix, documents, entries })
    if (plan.refusals.length) throw aggregateFault("archive_link_refused", `archive link plan refused: ${plan.refusals[0].code}`)
    let changedBytes = 0
    const changed = []
    for (const item of plan.files) {
      const row = rows.get(item.beforePath)
      let after = item.after
      if (trackFile && row.path === path.join(root, path.relative(effectiveRoot, trackFile))) {
        const helper = setTaskArchiveLinks(item.before, slug)
        if (helper !== null) {
          const beforeBytes = row.before, helperBytes = Buffer.from(helper)
          let left = 0, suffix = 0
          while (left < beforeBytes.length && left < helperBytes.length && beforeBytes[left] === helperBytes[left]) left++
          while (suffix < beforeBytes.length - left && suffix < helperBytes.length - left &&
            beforeBytes[beforeBytes.length - 1 - suffix] === helperBytes[helperBytes.length - 1 - suffix]) suffix++
          const right = beforeBytes.length - suffix
          const selected = item.patches.filter(patch => patch.byteStart <= right && patch.byteEnd > left)
          let cursor = 0
          const chunks = []
          for (const patch of selected) {
            chunks.push(beforeBytes.subarray(cursor, patch.byteStart), Buffer.from(patch.replacement)); cursor = patch.byteEnd
          }
          chunks.push(beforeBytes.subarray(cursor))
          if (!Buffer.concat(chunks).equals(helperBytes)) throw aggregateFault("archive_composition", "structured row helper cannot be reconstructed from admitted original destinations")
        }
        if (status) after = setTaskState(after, slug, status) ?? after
      }
      if (row.relative === `${sourcePrefix}/task.md` && composeCard) {
        check(); after = await composeCard(after); check()
      }
      const final = Buffer.from(after)
      if (final.length > limits.documentBytes) throw aggregateFault("archive_limit", "archive final Markdown exceeds its byte bound")
      row.finalBytes = final
      if (!final.equals(row.before)) {
        if (!row.relative.startsWith(`${sourcePrefix}/`) && row.relative.split("/").some(part => part.startsWith("_")))
          throw aggregateFault("archive_scope", "archive would rewrite a reserved or historical owner")
        changedBytes += final.length; changed.push(row)
        if (changed.length > limits.changedFiles || changedBytes > limits.changedBytes) throw aggregateFault("archive_limit", "archive changed-owner bound exceeded")
      }
    }
    await assertCurrent()
    const sourceRow = rows.get(sourcePrefix)
    if (!sourceRow || sourceRow.type !== "directory") throw aggregateFault("archive_source", "archive source directory is unavailable")
    changed.sort((a, b) => Number(!a.relative.startsWith(`${sourcePrefix}/`)) - Number(!b.relative.startsWith(`${sourcePrefix}/`)) ||
      a.relative.localeCompare(b.relative))
    const mappedPath = file => file === sourcePrefix || file.startsWith(`${sourcePrefix}/`)
      ? destinationPrefix + file.slice(sourcePrefix.length) : file
    receipt.originalMap = Object.freeze([...rows.values()].map(row => Object.freeze({
      path: row.relative, type: row.type, mode: row.mode, identity: aggregateIdentity(row.stat),
      version: Object.freeze({ ...row.version }),
      ...(row.before === undefined ? {} : { byteCount: row.before.length, sha256: hash(row.before) }),
      ...(row.children ? { children: Object.freeze([...row.children].map(([name, value]) => Object.freeze({ name, ...value }))) } : {}),
    })))
    receipt.finalMap = Object.freeze([...rows.values()].filter(row => row.before !== undefined).map(row => Object.freeze({
      beforePath: row.relative, afterPath: mappedPath(row.relative), mode: row.mode,
      byteCount: (row.finalBytes ?? row.before).length, sha256: hash(row.finalBytes ?? row.before),
      rewritten: row.finalBytes !== undefined && !row.finalBytes.equals(row.before),
    })))
    receipt.links = Object.freeze(plan.links.map(link => Object.freeze({ ...link })))
    receipt.markerSlot = Object.freeze({ source: path.join(source, ARCHIVE_MARKER),
      destination: path.join(destination, ARCHIVE_MARKER), original: "absent", expectedSuccess: "absent" })
    return { root, source, destination, sourcePrefix, destinationPrefix, rows, changed, receipt, deadline, evidenceDeadline,
      now, check, step, close, handles, open, closeHandle, readBytes, assertCurrent, assertReplacementTarget, currentPath, parentRow, refreshDirectory,
      version: aggregateVersion, identity: aggregateIdentity, childStamp,
      sourceRow, markerName: ARCHIVE_MARKER,
      async ownFile(file, entry, stat, bytes) {
        const row = { path: file, relative: relative(root, file), type: "regular_file", stat,
          mode: Number(stat.mode & 0o777n), version: aggregateVersion(stat), entry, expectedBytes: bytes, generated: true }
        rows.set(row.relative, row)
        return row
      },
      markMoved() { moved = true },
      get moved() { return moved },
      async ownDirectory(file, entry, stat) {
        const row = { path: file, relative: relative(root, file), type: "directory", stat, mode: Number(stat.mode & 0o777n),
          version: aggregateVersion(stat), entry, children: new Map() }
        rows.set(row.relative, row)
        return row
      } }
  } catch (error) {
    try { await close() } catch (closeError) {
      receipt.closeFailure = closeError.message
      if (Object.isExtensible(error)) error.archiveCloseError = closeError.message
    }
    if (Object.isExtensible(error)) error.archiveAggregate = receipt
    throw error
  }
}

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
  const answer = spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: 10000, ...(input === undefined ? {} : { input }) })
  if (answer.status !== 0) throw new Error(`task_archive: Git precondition unavailable (${args[0]}): ${answer.stderr || answer.error?.code || answer.status}`)
  return answer.stdout
}
function gitBoolean(root, name, spawnGit) {
  const answer = spawnGit("git", ["-C", root, "config", "--bool", "--get", name], { windowsHide: true, encoding: "utf8", timeout: 10000 })
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
  const head = spawnGit("git", ["-C", top, "rev-parse", "--verify", "-q", "HEAD"], { windowsHide: true, encoding: "utf8", timeout: 10000 })
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
    if (identity(after) !== entry.identity || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("task_archive: source changed while its bytes were being admitted")
    result.set(key, entry)
  }
  await visit(directory, "")
  return result
}
function sameTree(actual, expected) {
  return actual.size === expected.size && [...expected].every(([key, entry]) => {
    const found = actual.get(key)
    return found && found.identity === entry.identity &&
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
async function publishExpected(git, paths, expected, message, stagingPaths = paths, beforeEffect) {
  if (beforeEffect) await beforeEffect()
  assertGitState(git)
  const staged = stagePaths(git.root, stagingPaths, git.spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  let entries = indexEntries(git.root, paths, git.spawnGit)
  const normalStage = new Map([...expected].map(([file, entry]) => [file, { sha: entry.stageSha, mode: entry.stageMode }]))
  if (!indexMatches(entries, normalStage))
    return { status: "failed", reason: "staged archive differs from the admitted bytes; no commit was attempted" }
  const metadata = [...expected].filter(([, entry]) => entry.mode !== entry.stageMode || entry.sha !== entry.stageSha)
  if (metadata.length) {
    if (beforeEffect) {
      await beforeEffect()
      if (!indexMatches(indexEntries(git.root, paths, git.spawnGit), normalStage))
        return { status: "failed", reason: "staged archive changed before metadata staging; outside edits retained" }
    }
    const input = metadata.map(([file, entry]) => `${entry.mode} ${entry.sha}\t${file}\0`).join("")
    const updated = git.spawnGit("git", ["-C", git.root, "update-index", "-z", "--index-info"],
      { windowsHide: true, encoding: "utf8", timeout: 10000, input })
    if (updated.status !== 0) return { status: "failed", reason: updated.stderr || updated.error?.code || "Git metadata staging failed" }
    entries = indexEntries(git.root, paths, git.spawnGit)
  }
  if (!indexMatches(entries, expected))
    return { status: "failed", reason: "the admitted Git mode/type metadata could not be staged" }
  if (beforeEffect) {
    await beforeEffect()
    entries = indexEntries(git.root, paths, git.spawnGit)
    if (!indexMatches(entries, expected))
      return { status: "failed", reason: "staged archive changed before commit; outside edits retained" }
  }
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

export async function prepareArchiveState({ effectiveRoot, srcDir, archiveDir, srcFile, trackPlan, trackFile, slug, spawnGit,
  relocated = false, beforeEffect }) {
  const snapshot = await tree(relocated ? archiveDir : srcDir)
  const fence = await ancestry(effectiveRoot, archiveDir)
  const git = await gitContext(effectiveRoot, spawnGit)
  let track = null
  let tracked = []
  let originals = new Map()
  let sourceIndex = new Map()
  let destinationIndex = new Map()
  let stagedRelocation = false
  let recoveredTrack = false
  let trackEntry = null
  if (git) {
    const source = gitPath(git, srcDir)
    const destination = gitPath(git, archiveDir)
    const card = gitPath(git, srcFile)
    const entries = indexEntries(git.root, [source], spawnGit)
    if (entries === null || entries.some((entry) => entry.stage !== "0" || entry.mode === "160000"))
      throw new Error("task_archive: source index conflicts/submodules cannot be admitted; nothing was moved")
    const baseline = new Map(headEntries(git, srcDir).map((entry) => [entry.path, entry]))
    sourceIndex = new Map(entries.map((entry) => [entry.path, entry]))
    if (relocated && entries.length === 0 && baseline.size > 0) {
      destinationIndex = new Map([...baseline].map(([file, entry]) =>
        [`${destination}${file.slice(source.length)}`, entry]))
      if (headEntries(git, archiveDir).length ||
          !indexMatches(indexEntries(git.root, [destination], spawnGit), destinationIndex))
        throw new Error("task_archive: the interrupted staged move does not exactly match the source HEAD; preserve the index and archive before retrying")
      stagedRelocation = true
    } else destinationVacant(git, archiveDir)
    originals = stagedRelocation ? baseline : sourceIndex
    tracked = [...originals.keys()]
    for (const [name, entry] of snapshot) {
      if (entry.kind !== "directory" && name !== "task.md" && !originals.has(`${source}/${name}`))
        throw new Error("task_archive: an untracked companion is not implicitly owned; nothing was moved")
    }
    if (relocated) {
      if (!stagedRelocation && (entries.length === 0 || entries.length !== baseline.size ||
          entries.some((entry) => baseline.get(entry.path)?.sha !== entry.sha || baseline.get(entry.path)?.mode !== entry.mode)))
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
    for (const entry of originals.values()) {
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
    }
    if (stagedRelocation && trackFile) {
      const key = gitPath(git, trackFile)
      const held = headEntries(git, trackFile)
      if (held.length === 1 && ["100644", "100755"].includes(held[0].mode)) {
        const before = readGit(git.root, ["show", `${git.head}:${key}`], spawnGit)
        const after = setTaskArchiveLinks(before, slug)
        if (after !== null) {
          const stat = await fs.lstat(trackFile)
          const expected = { mode: held[0].mode, sha: cleanHash(git, trackFile, Buffer.from(after)), path: key, stage: "0" }
          if (!stat.isFile() || gitMode({ kind: "file", mode: stat.mode & 0o777 }, held[0], git) !== held[0].mode ||
              await fs.readFile(trackFile, "utf8") !== after ||
              !indexMatches(indexEntries(git.root, [key], spawnGit), new Map([[key, expected]])))
            throw new Error("task_archive: the interrupted track link update differs from its source HEAD; outside edits were retained")
          trackPlan = { file: trackFile, before: after, after }
          trackEntry = expected
          recoveredTrack = true
        }
      }
    }
  }
  if (trackPlan) {
    const stat = await fs.lstat(trackPlan.file, { bigint: true })
    if (!stat.isFile()) throw new Error("task_archive: a track link update requires a regular track card")
    track = { ...trackPlan, identity: identity(stat), mode: Number(stat.mode & 0o777n) }
  }
  if (git) {
    if (track && !recoveredTrack && [
      ["diff", "--name-only", "--", gitPath(git, track.file)],
      ["diff", "--cached", "--name-only", "--", gitPath(git, track.file)],
      ["ls-files", "--others", "--", gitPath(git, track.file)],
    ].some((args) => readGit(git.root, args, spawnGit).trim()))
      throw new Error("task_archive: the track row/link has outside edits; nothing was moved")
    if (track) {
      const held = indexEntries(git.root, [gitPath(git, track.file)], spawnGit)
      if (held === null || held.length !== 1 || held[0].stage !== "0" || !["100644", "100755"].includes(held[0].mode))
        throw new Error("task_archive: the track's regular Git file state could not be qualified")
      if (recoveredTrack && !indexMatches(held, new Map([[trackEntry.path, trackEntry]])))
        throw new Error("task_archive: interrupted track index changed during preflight; outside staged bytes were retained")
      trackEntry = held[0]
    }
  }
  async function assertTrack() {
    if (!track) return
    const stat = await fs.lstat(track.file, { bigint: true })
    if (identity(stat) !== track.identity || !Buffer.from(await fs.readFile(track.file)).equals(Buffer.from(track.before)))
      throw new Error("task_archive: the track changed after preflight; outside edits were retained")
  }
  function assertSourceIndex() {
    if (!indexMatches(indexEntries(git.root, [gitPath(git, srcDir)], spawnGit), sourceIndex))
      throw new Error("task_archive: source index changed after preflight; outside staged bytes were retained")
  }
  function assertDestinationIndex() {
    if (!stagedRelocation) return destinationVacant(git, archiveDir)
    if (headEntries(git, archiveDir).length ||
        !indexMatches(indexEntries(git.root, [gitPath(git, archiveDir)], spawnGit), destinationIndex))
      throw new Error("task_archive: interrupted destination index changed after preflight; outside staged bytes were retained")
    if (track && !indexMatches(indexEntries(git.root, [gitPath(git, track.file)], spawnGit),
      new Map([[trackEntry.path, trackEntry]])))
      throw new Error("task_archive: interrupted track index changed after preflight; outside staged bytes were retained")
  }
  return {
    git, snapshot, fence, trackPlan,
    async atUse() {
      await fence.assert()
      await assertTrack()
      if (!sameTree(await tree(relocated ? archiveDir : srcDir), snapshot))
        throw new Error("task_archive: source changed after preflight")
      if (await present(relocated ? srcDir : archiveDir))
        throw new Error("task_archive: the other archive path appeared before publication")
      if (git) {
        assertDestinationIndex()
        assertSourceIndex()
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
      if (beforeEffect) await beforeEffect()
      if (!git) return undefined
      assertDestinationIndex()
      assertSourceIndex()
      if (headSha(git) !== git.head) throw new Error("task_archive: HEAD changed before publication")
      const expected = new Map()
      const source = gitPath(git, srcDir)
      const destination = gitPath(git, archiveDir)
      for (const [name, entry] of snapshot) {
        if (entry.kind === "directory") continue
        const mode = gitMode(entry, originals.get(`${source}/${name}`), git)
        const sha = blobHash(git, path.join(archiveDir, name), entry.bytes, mode)
        const key = `${destination}/${name}`
        const stageMode = gitMode(entry, destinationIndex.get(key), git)
        expected.set(key, { sha, mode, stageMode,
          stageSha: stageMode === mode ? sha : blobHash(git, path.join(archiveDir, name), entry.bytes, stageMode) })
      }
      if (track) {
        const bytes = Buffer.from(track.after)
        const sha = cleanHash(git, track.file, bytes), mode = gitMode({ kind: "file", mode: track.mode }, trackEntry, git)
        expected.set(gitPath(git, track.file), { sha, mode, stageSha: sha, stageMode: mode })
      }
      const paths = [...new Set([...tracked, ...expected.keys()])]
      return publishExpected(git, paths, expected, message, stagedRelocation ? [...expected.keys()] : paths, beforeEffect)
    },
  }
}

export async function prepareArchivedCardPublication({ effectiveRoot, file, before, spawnGit, beforeEffect }) {
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
      if (beforeEffect) await beforeEffect()
      if (!git) return undefined
      const mode = gitMode({ kind: "file", mode: Number(stat.mode & 0o777n) }, previous, git)
      const sha = cleanHash(git, physical, Buffer.from(expected))
      return publishExpected(git, [key], new Map([[key, { sha, mode, stageSha: sha, stageMode: mode }]]), message, [key], beforeEffect)
    },
  }
}

function headSha(git) {
  const answer = git.spawnGit("git", ["-C", git.root, "rev-parse", "--verify", "-q", "HEAD"], { windowsHide: true, encoding: "utf8", timeout: 10000 })
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
  const uncertain = error.archiveMove?.released && error.archiveMove.movement === "unconfirmed"
  error.archive_phase = outside ? "relocated_outside_boundary" : published ? "archived_publication_complete" :
    uncertain ? "relocation_outcome_uncertain" : moved ? "relocated_publication_unconfirmed" : actual === null ? "relocation_outcome_uncertain" : "not_moved"
  if (uncertain) {
    error.possible_late_effect = error.archiveMove.retirement !== "confirmed"
    error.observed_placement = actual
    error.message += `; possible_late_effect=${error.possible_late_effect}; reconcile observed placement before any retry`
  }
  if (error.created_parents === "retained_until_native_retirement_resolved")
    error.message += "; created_parents=retained_until_native_retirement_resolved; do not retry or reuse parents until native retirement is resolved"
  if (error.native_close_failure) error.message += `; ${error.native_close_failure}`
  error.actual_path = actual === null ? null : path.join(actual, "task.md")
  error.path = error.actual_path
  if (actual === null) error.last_known_path = path.join(archiveDir, "task.md")
  error.message += `; archive_phase=${error.archive_phase}; actual_path=${error.actual_path ?? "unknown"}; no rollback or unknown publication was attempted`
  return error
}
