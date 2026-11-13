// Rewrites the relative Markdown links in one file for a folder move, touching only the destination spans.
// Paths are desk-relative and posix. Pure: text in, text out.
import { extractMarkdownLinks } from "./markdown-links.cjs"

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/u
const UNWRITABLE_RAW = /[\u0000-\u001f\u007f<>\\#?]/u

const segments = (dir) => (dir === "." ? [] : dir.split("/"))
const dirOf = (file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".")
const under = (target, prefix) => target === prefix || target.startsWith(`${prefix}/`)
const moved = (target, sourcePrefix, destinationPrefix) =>
  under(target, sourcePrefix) ? destinationPrefix + target.slice(sourcePrefix.length) : target

function normalize(dir, rel) {
  const out = []
  for (const part of [...segments(dir), ...rel.split("/")]) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else out.push("..")
    } else out.push(part)
  }
  return out.join("/") || "."
}

function relativeFrom(fromDir, to) {
  const from = segments(fromDir), target = segments(to)
  let common = 0
  while (common < from.length && common < target.length && from[common] === target[common]) common++
  return [...from.slice(common).map(() => ".."), ...target.slice(common)].join("/") || "."
}

function decodeSegment(segment) {
  try { return decodeURIComponent(segment) } catch { return segment }
}

function encodeSegment(segment, percentForm) {
  if (!percentForm) return segment
  return encodeURIComponent(segment).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function writableRaw(segment, angle) {
  if (UNWRITABLE_RAW.test(segment) || PERCENT_ESCAPE.test(segment)) return false
  return angle || !/[\s()]/u.test(segment)
}

// Returns the new destination text, `null` when the link needs no change, or `{ reason }` when it cannot be written.
function relinkDestination(link, { filePath, oldPath, sourcePrefix, destinationPrefix }) {
  const destination = link.destination
  if (destination === "" || SCHEME.test(destination) || destination.startsWith("#") ||
      destination.startsWith("?") || destination.startsWith("/")) return null
  const cut = destination.search(/[?#]/u)
  const pathPart = cut === -1 ? destination : destination.slice(0, cut)
  const suffix = cut === -1 ? "" : destination.slice(cut)
  const rawParts = pathPart.split("/")
  const decodedParts = rawParts.map(decodeSegment)
  const target = normalize(dirOf(oldPath), decodedParts.join("/"))
  const relocated = moved(target, sourcePrefix, destinationPrefix)
  if (relocated === target && filePath === oldPath) return null
  if (relocated === ".." || relocated.startsWith("../")) return { reason: "the target is outside the desk after the move" }
  if (link.destination !== link.raw) return { reason: "the destination uses backslash or entity escapes, so it was not rewritten" }

  let rel = relativeFrom(dirOf(filePath), relocated)
  if (pathPart.endsWith("/") && !rel.endsWith("/")) rel += "/"
  const percentForm = PERCENT_ESCAPE.test(pathPart)
  const rawByDecoded = new Map(decodedParts.map((decoded, index) => [decoded, rawParts[index]]))
  const out = []
  for (const part of rel.split("/")) {
    if (part === "" || part === "." || part === "..") { out.push(part); continue }
    if (rawByDecoded.has(part)) { out.push(rawByDecoded.get(part)); continue }
    if (!percentForm && !writableRaw(part, link.angle)) {
      return { reason: `the new path needs a character the original form cannot hold (${JSON.stringify(part)})` }
    }
    out.push(encodeSegment(part, percentForm))
  }
  const next = out.join("/") + suffix
  return next === link.raw ? null : next
}

/**
 * Rewrites every relative link in `text` for a move of `sourcePrefix` to `destinationPrefix`. `filePath` is the file's
 * desk-relative path after the move. Returns `{ text, rewritten, unresolved }`; `text` is the input string when nothing changed.
 */
export function rewriteForMove({ text, filePath, sourcePrefix, destinationPrefix }) {
  if (typeof text !== "string") throw new TypeError("rewriteForMove requires the file's text")
  const oldPath = under(filePath, destinationPrefix)
    ? sourcePrefix + filePath.slice(destinationPrefix.length) : filePath
  const parsed = extractMarkdownLinks(text)
  if (parsed.diagnostics.some((diagnostic) => diagnostic.code === "parse_budget_exceeded")) {
    return { text, rewritten: 0, unresolved: [{ destination: null, reason: "the link parser ran out of work budget, so this file's links were not checked" }] }
  }
  const edits = [], unresolved = []
  for (const link of parsed.links) {
    const result = relinkDestination(link, { filePath, oldPath, sourcePrefix, destinationPrefix })
    if (result === null) continue
    if (typeof result === "string") edits.push({ start: link.start, end: link.end, text: result })
    else unresolved.push({ destination: link.raw, reason: result.reason })
  }
  let next = text
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  }
  return { text: next, rewritten: edits.length, unresolved }
}
