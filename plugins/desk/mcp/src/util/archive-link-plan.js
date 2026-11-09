import path from "node:path"
import { createHash } from "node:crypto"
import { caseFold } from "unicode-case-folding"
import markdown from "./markdown-links.cjs"

const decimal = value => typeof value === "string" && /^\d+$/u.test(value)
const hash = text => createHash("sha256").update(text).digest("hex")
const inside = (prefix, file) => prefix === "" || file === prefix || file.startsWith(`${prefix}/`)
const relativePath = value => typeof value === "string" && value !== "" &&
  value.isWellFormed() && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/u.test(value) &&
  !value.includes("\\") && !value.includes("\0") &&
  !value.split("/").some(part => part === "" || part === "." || part === "..")
const safeAncestry = entries => Array.isArray(entries) && entries.length > 0 &&
  entries.every(entry => (typeof entry === "string" ? entry : entry?.type) === "directory")
const encodeSegment = value => encodeURIComponent(value).replace(/[!'()*]/gu,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
const targetPath = value => path.posix.normalize(value).replace(/\/$/u, "")

/**
 * Proposals from supplied observations only, with no IO or authority.
 * Refusals prohibit applying the plan; even an unrefused plan needs live revalidation.
 */
export function planArchiveLinks({ sourcePrefix, destinationPrefix, scopePrefix = "", documents, entries } = {}) {
  if (!Array.isArray(documents) || !Array.isArray(entries))
    throw new TypeError("Archive-link planning requires supplied document and target inventories")
  const refusals = []
  const files = []
  const links = []
  const currentness = { requiresLiveReadback: true, basis: "supplied_observations" }
  const answer = { kind: "archive_link_plan", coverage: "supplied_inventory_only",
    files, links, refusals, currentness }
  if (!relativePath(sourcePrefix) || !relativePath(destinationPrefix) ||
      scopePrefix !== "" && !relativePath(scopePrefix) ||
      !inside(scopePrefix, sourcePrefix) || !inside(scopePrefix, destinationPrefix) ||
      inside(sourcePrefix, destinationPrefix) || inside(destinationPrefix, sourcePrefix)) {
    refusals.push({ code: "invalid_move_prefix" })
    return answer
  }
  const move = file => inside(sourcePrefix, file)
    ? destinationPrefix + file.slice(sourcePrefix.length) : file
  const targetEntries = new Map()
  for (const entry of entries) {
    if (!relativePath(entry?.path)) {
      refusals.push({ code: "invalid_target_inventory" })
      continue
    }
    if (targetEntries.has(entry.path)) refusals.push({ code: "duplicate_target_observation", path: entry.path })
    else targetEntries.set(entry.path, entry)
  }
  const owners = new Set()
  for (const [documentIndex, document] of documents.entries()) {
    const file = document?.path
    const refuse = (code, detail = {}) => refusals.push({ code,
      ...(relativePath(file) && inside(scopePrefix, file) ? { path: file } : { documentIndex }), ...detail })
    if (!relativePath(file) || !inside(scopePrefix, file)) {
      refuse("document_outside_scope")
      continue
    }
    if (owners.has(file)) {
      refuse("duplicate_document")
      continue
    }
    owners.add(file)
    if (document.identity?.type !== "regular_file") {
      refuse("document_not_regular")
      continue
    }
    if (!safeAncestry(document.ancestry)) {
      refuse("unsafe_ancestry")
      continue
    }
    let before
    if (Buffer.isBuffer(document.before)) {
      try { before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(document.before) }
      catch (error) {
        if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error
        refuse("invalid_utf8_input")
        continue
      }
    } else if (typeof document.before === "string" && document.before.isWellFormed()) before = document.before
    else {
      refuse("invalid_utf8_input")
      continue
    }
    const version = document.version
    if (!decimal(document.identity.dev) || !decimal(document.identity.ino) ||
        !Number.isInteger(document.mode) || document.mode < 0 || document.mode > 0o777 ||
        !decimal(version?.size) || !decimal(version?.mtimeNs) || !decimal(version?.ctimeNs) ||
        BigInt(version.size) !== BigInt(Buffer.byteLength(before))) {
      refuse("input_version_mismatch")
      continue
    }
    if (document.observation !== undefined && document.observation !== "stable") {
      refuse("input_not_current")
      continue
    }
    const identity = { dev: document.identity.dev, ino: document.identity.ino, type: "regular_file" }
    const observedVersion = { size: version.size, mtimeNs: version.mtimeNs, ctimeNs: version.ctimeNs }
    const afterPath = move(file)
    const patches = []
    const scanned = markdown.extractMarkdownLinks(before, { foldLabel: caseFold })
    for (const diagnostic of scanned.diagnostics) {
      if (diagnostic.code === "parse_budget_exceeded") refuse(diagnostic.code, { start: diagnostic.start })
    }
    for (const node of scanned.links) {
      const destination = node.destination
      if (/^[A-Za-z]:[\\/]/u.test(destination)) {
        refuse("ambiguous_drive_reference", { start: node.start })
        continue
      }
      if (destination === "" || /^[/?#]/u.test(destination) ||
          /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)) continue
      const suffixAt = destination.search(/[?#]/u)
      const semanticEnd = suffixAt === -1 ? destination.length : suffixAt
      const semanticPath = destination.slice(0, semanticEnd)
      const rawEnd = node.decodedOffsets[semanticEnd]
      const rawPath = node.raw.slice(0, rawEnd)
      if (scanned.diagnostics.some(diagnostic =>
        diagnostic.start >= node.start && diagnostic.start < node.end)) {
        refuse("unsupported_destination", { start: node.start })
        continue
      }
      if (/%(?:2f|5c)/iu.test(semanticPath)) {
        refuse("encoded_separator", { start: node.start })
        continue
      }
      if (semanticPath.includes("\\") || /\\\//u.test(rawPath)) {
        refuse("ambiguous_separator", { start: node.start })
        continue
      }
      let decoded
      try { decoded = decodeURIComponent(semanticPath) }
      catch (error) {
        if (!(error instanceof URIError)) throw error
        refuse("invalid_encoding", { start: node.start })
        continue
      }
      const oldTarget = targetPath(path.posix.join(path.posix.dirname(file), decoded))
      if (afterPath === file && !inside(sourcePrefix, oldTarget)) continue
      if (oldTarget === ".." || oldTarget.startsWith("../") || path.posix.isAbsolute(oldTarget)) {
        refuse("target_outside_desk", { start: node.start })
        continue
      }
      const target = targetEntries.get(oldTarget)
      if (!target || !safeAncestry(target.ancestry)) {
        refuse("target_unqualified", { start: node.start })
        continue
      }
      if (!["regular_file", "directory"].includes(target.type)) {
        refuse("target_not_regular", { start: node.start })
        continue
      }
      const newTarget = move(oldTarget)
      const unchanged = targetPath(path.posix.join(path.posix.dirname(afterPath), decoded)) === newTarget
      let newPath = unchanged ? decoded : path.posix.relative(path.posix.dirname(afterPath), newTarget) || "."
      if (!unchanged && decoded.endsWith("/") && !newPath.endsWith("/")) newPath += "/"
      links.push({ oldOwner: file, newOwner: afterPath, oldTarget, newTarget, oldPath: decoded, newPath,
        start: node.start, end: node.end })
      if (unchanged) continue
      const rawParts = rawPath.split("/")
      const semanticParts = semanticPath.split("/")
      if (rawParts.length !== semanticParts.length) {
        refuse("ambiguous_separator", { start: node.start })
        continue
      }
      const oldParts = semanticParts.map(part => decodeURIComponent(part))
      const newParts = newPath.split("/")
      let common = 0
      while (common < oldParts.length && common < newParts.length &&
          oldParts[oldParts.length - 1 - common] === newParts[newParts.length - 1 - common]) common++
      let rewritten = [
        ...newParts.slice(0, newParts.length - common).map(encodeSegment),
        ...rawParts.slice(rawParts.length - common),
      ].join("/")
      if (rawPath.startsWith("./") && !rewritten.startsWith(".") && rewritten !== "") rewritten = `./${rewritten}`
      const replacement = rewritten + node.raw.slice(rawEnd)
      patches.push({ start: node.start, end: node.end, raw: node.raw, replacement,
        byteStart: Buffer.byteLength(before.slice(0, node.start)),
        byteEnd: Buffer.byteLength(before.slice(0, node.end)) })
    }
    let cursor = 0
    let after = ""
    for (const patch of patches) {
      if (patch.start < cursor) {
        refuse("overlapping_destination_spans", { start: patch.start })
        after = before
        cursor = before.length
        break
      }
      after += before.slice(cursor, patch.start) + patch.replacement
      cursor = patch.end
    }
    after += before.slice(cursor)
    files.push({ beforePath: file, afterPath, before, after, mode: document.mode,
      identity: { ...identity }, version: { ...observedVersion }, beforeSha256: hash(before),
      afterSha256: hash(after), patches, currentnessRequirements: {
        requiresLiveReadback: true, originalPath: file, identity: { ...identity },
        version: { ...observedVersion }, beforeSha256: hash(before),
      } })
  }
  return answer
}
