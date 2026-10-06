// Frontmatter + markdown file helpers shared by the runtime CRUD tools.
//
// Wraps gray-matter (a CommonJS module) for ESM consumers, exposes a
// canonical ISO-timestamp helper, plus small file-IO conveniences so each
// tool module stays focused on its contract.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { nfc } from "@adraffy/ens-normalize"
import matter from "gray-matter"
import { caseFold } from "unicode-case-folding"
import letterRegex from "./unicode-16/letter.cjs"
import markRegex from "./unicode-16/mark.cjs"
import numberRegex from "./unicode-16/number.cjs"

const windowsReservedBasename = /^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])$/u

function normalizeNfc(value) {
  const codePoints = nfc(Array.from(value, (character) => character.codePointAt(0)))
  let result = ""
  for (let offset = 0; offset < codePoints.length; offset += 4096) {
    result += String.fromCodePoint(...codePoints.slice(offset, offset + 4096))
  }
  return result
}

function filenameKey(value) {
  return normalizeNfc(caseFold(normalizeNfc(String(value))))
}

/** Current UTC time in the canonical `YYYY-MM-DDTHH:MM:SSZ` shape. */
export function nowIso() {
  // Trim milliseconds — the schema example uses second precision.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** Today's date as `YYYY-MM-DD` (UTC). */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Read a markdown file and return its parsed frontmatter + body.
 * Throws a clear error if the file doesn't exist.
 */
export async function readMarkdown(filePath) {
  let raw
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`file does not exist: ${filePath}`)
    }
    throw err
  }
  const parsed = matter(raw)
  return { data: parsed.data, content: parsed.content }
}

/**
 * Serialize frontmatter + body to a markdown string. gray-matter.stringify
 * writes a `---\n<yaml>\n---\n<body>` document.
 */
export function serializeMarkdown(data, content) {
  // gray-matter.stringify strips a leading newline from content; normalize
  // body so there's always a blank line between frontmatter and body when
  // body is non-empty.
  const body = content == null ? "" : String(content)
  return matter.stringify(body.startsWith("\n") ? body : `\n${body}`, data)
}

/** Write a markdown file with frontmatter, creating parent dirs as needed. */
export async function writeMarkdown(filePath, data, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, serializeMarkdown(data, content), "utf8")
}

// A YAML plain scalar is safe here only for the narrow shapes this
// function's own callers actually pass (a track slug, a status word, a
// task reference such as `other-track/other-slug`): starts with a letter,
// then letters, digits, `-`, `_`, or `/`, and never one of YAML's own
// reserved plain-scalar spellings. Everything else — including every
// timestamp `patchFrontmatterFields` writes, which always starts with a
// digit — is double-quoted, so its type survives the next parse (an
// unquoted `2026-09-25T09:00:00Z` is a Date under gray-matter's default
// schema, not a string).
const SAFE_BARE_SCALAR = /^[A-Za-z][A-Za-z0-9_/-]*$/u
const YAML_RESERVED_WORD = /^(?:true|false|null|~|yes|no|on|off)$/iu

function encodeScalar(value) {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value)
  const text = String(value)
  if (SAFE_BARE_SCALAR.test(text) && !YAML_RESERVED_WORD.test(text)) return text
  return `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n")}"`
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// A field's own encoded lines: a one-line `key: value` for a scalar, or a
// `key:` header plus one `  subkey: value` line per own-enumerable entry
// for a plain object (one level deep -- the only shape a patched field
// needs today, `task_archive`'s `evidence: { kind, ref, recorded_at }`).
// Every line but the first is indented, so the surgical-replace loop's own
// `/^\s/u.test(line)` guard skips back over them on the next iteration
// instead of misreading one as another top-level field.
function encodeFieldLines(key, value) {
  if (Array.isArray(value)) return value.length === 0 ? [`${key}: []`] : [`${key}:`, ...value.map((item) => `  - ${encodeScalar(item)}`)]
  if (!isPlainObject(value)) return [`${key}: ${encodeScalar(value)}`]
  const lines = [`${key}:`]
  for (const [subKey, subValue] of Object.entries(value)) {
    lines.push(`  ${subKey}: ${encodeScalar(subValue)}`)
  }
  return lines
}

const FRONTMATTER_TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/u

// A block scalar's own header value: `|` or `>`, plus an optional chomp
// (`-`/`+`) and/or single-digit indent indicator in either order. Only
// this shape's continuation lines are folded/literal body text that must
// move with the field; every other value type's own line is the whole of
// it, whatever comes after in the document.
const BLOCK_SCALAR_VALUE = /^[|>][-+0-9]{0,2}$/u

// The file's own line ending, taken from its first line break: CRLF only
// when that break is literally `\r\n`, LF otherwise (including a file with
// no line breaks at all). `patchFrontmatterFields` rejoins the whole file
// with this, so a CRLF card's line endings survive a patch instead of
// being silently normalized to bare `\n` by the split/join round trip.
function detectEol(rawText) {
  const index = rawText.indexOf("\n")
  return index > 0 && rawText[index - 1] === "\r" ? "\r\n" : "\n"
}

// Splits a frontmatter value from a trailing ` # comment`, so a patched
// line can carry that comment forward instead of silently dropping it. The
// `#` only starts a comment outside a quoted string (an escaped `"` inside
// a double-quoted value doesn't end it early) and, ordinarily, only when
// whitespace precedes it — except when the whole value is nothing but a
// comment (`key: # comment`, an otherwise-empty value), which needs no
// whitespace of its own since the colon's own space already separates it.
function splitTrailingComment(text) {
  if (text.startsWith("#")) return { value: "", comment: text }
  let quote = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (quote) {
      if (quote === "\"" && escaped) {
        escaped = false
        continue
      }
      if (quote === "\"" && ch === "\\") {
        escaped = true
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "\"" || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "#" && /\s/u.test(text[index - 1])) {
      return { value: text.slice(0, index).replace(/\s+$/u, ""), comment: text.slice(index) }
    }
  }
  return { value: text, comment: "" }
}

// Whether an indented (or blank-then-indented) run right after a patched
// field's header line is that field's own nested map/list, for a field
// whose header carries no inline value at all (`repos:`, not `repos: []`).
// A blank line alone never counts — only an indented, non-blank line
// actually reachable past it does, the same test a block scalar's own
// continuation lines don't need because their header already says so.
function collectionFollows(patched, from) {
  let index = from
  while (index < patched.length && patched[index] === "") index += 1
  return index < patched.length && /^\s/u.test(patched[index])
}

/**
 * Rewrite only the named top-level frontmatter fields of `rawText`
 * (`{ key: value }`), leaving every other byte untouched: other fields'
 * quoting, key order, comments, date formats, and block scalars, plus the
 * body, survive exactly as written. A field not already present is
 * appended just before the closing fence; a field that is present, however
 * it was written (quoted, folded, a block scalar, with a trailing
 * comment), is replaced, dropping only that field's own continuation lines
 * (a block scalar's body, or a nested map/list under an otherwise-empty
 * value) — never a blank line that merely separates it from the next
 * field. A scalar value becomes one plain-scalar line, carrying that same
 * trailing comment when there was one; a plain-object value (one level
 * deep -- `task_archive`'s `evidence: { kind, ref, recorded_at }`) becomes
 * a `key:` header plus one indented `subkey: value` line per own entry
 * (`encodeFieldLines`), the trailing comment, if any, moving to that header
 * line. The file's own line ending (LF or CRLF) is kept.
 *
 * Returns `null` — the caller's cue to fall back to a full parse + re-dump
 * instead — when `rawText` has no `---`-fenced frontmatter to patch at
 * all, or when a field this call means to patch appears more than once at
 * top level: guessing which occurrence was meant risks silently patching
 * the one YAML itself will then ignore, since the last one wins on parse.
 *
 * This exists so a mover/renamer never has to round-trip a card's whole
 * frontmatter through `serializeMarkdown`'s YAML dump just to change
 * `track:`/`updated:`/`status:`: that round trip is what silently rewrites
 * a date-only value's format, a scalar's quoting, or a long line folded
 * into a `>-` block, even when every field's actual value is unchanged.
 */
export function patchFrontmatterFields(rawText, fields) {
  const eol = detectEol(rawText)
  const lines = rawText.split(/\r?\n/u)
  if (lines[0] !== "---") return null
  const end = lines.indexOf("---", 1)
  if (end === -1) return null

  const remaining = new Map(Object.entries(fields))
  const patched = lines.slice(0, end)

  const occurrences = new Map()
  for (let index = 1; index < patched.length; index += 1) {
    const line = patched[index]
    if (line === "" || /^\s/u.test(line)) continue
    const match = FRONTMATTER_TOP_LEVEL_KEY.exec(line)
    if (match) occurrences.set(match[1], (occurrences.get(match[1]) ?? 0) + 1)
  }
  for (const key of remaining.keys()) {
    if ((occurrences.get(key) ?? 0) > 1) return null
  }

  for (let index = 1; index < patched.length; index += 1) {
    const line = patched[index]
    if (line === "" || /^\s/u.test(line)) continue
    const match = FRONTMATTER_TOP_LEVEL_KEY.exec(line)
    if (!match || !remaining.has(match[1])) continue
    const { value, comment } = splitTrailingComment(line.slice(match[0].length).trim())
    let dropEnd = index + 1
    if (BLOCK_SCALAR_VALUE.test(value) || (value === "" && collectionFollows(patched, index + 1))) {
      while (dropEnd < patched.length && (patched[dropEnd] === "" || /^\s/u.test(patched[dropEnd]))) dropEnd += 1
    }
    const encodedLines = encodeFieldLines(match[1], remaining.get(match[1]))
    if (comment) encodedLines[0] = `${encodedLines[0]} ${comment}`
    patched.splice(index, dropEnd - index, ...encodedLines)
    remaining.delete(match[1])
  }
  for (const [key, value] of remaining) patched.push(...encodeFieldLines(key, value))
  return [...patched, ...lines.slice(end)].join(eol)
}

/**
 * Patch only the named top-level frontmatter fields of the file at
 * `filePath` in place (see `patchFrontmatterFields`). Falls back to a full
 * read + merge + `writeMarkdown` only when the file has no `---`-fenced
 * frontmatter to patch surgically — a malformed or fence-less card, which
 * has no pre-existing byte layout worth preserving anyway.
 */
export async function patchMarkdownFrontmatter(filePath, fields) {
  const raw = await fs.readFile(filePath, "utf8")
  const patched = patchFrontmatterFields(raw, fields)
  if (patched !== null) {
    await fs.writeFile(filePath, patched, "utf8")
    return
  }
  const parsed = matter(raw)
  await writeMarkdown(filePath, { ...parsed.data, ...fields }, parsed.content)
}

/** Check whether a path exists (file OR directory). */
export async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Find the actual directory entry that is canonically case-equivalent to a path. */
export async function findFilenameEquivalent(filePath, resolveCandidate) {
  if (typeof resolveCandidate !== "function") {
    throw new Error("filename-equivalent lookup requires a confined candidate resolver")
  }
  let names
  try {
    names = await fs.readdir(path.dirname(filePath))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  const targetKey = filenameKey(path.basename(filePath))
  const match = names.sort().find((name) => filenameKey(name) === targetKey)
  return match ? resolveCandidate(match) : null
}

function retainUnicodeSlugParts(value) {
  let result = ""
  let separatorPending = false
  let hasBase = false

  for (const character of value) {
    if (letterRegex.test(character) || numberRegex.test(character)) {
      if (separatorPending && result) result += "-"
      result += character
      separatorPending = false
      hasBase = true
    } else if (markRegex.test(character) && hasBase && !separatorPending) {
      result += character
    } else {
      separatorPending = result.length > 0
      hasBase = false
    }
  }

  return result
}

/**
 * Slugify a topic / theme to a filesystem-safe token using pinned Unicode 16
 * categories, full case folding, and canonical normalization.
 */
export function slugify(raw) {
  if (raw == null) return ""
  const retained = normalizeNfc(retainUnicodeSlugParts(String(raw)))
  const slug = retainUnicodeSlugParts(normalizeNfc(caseFold(retained)))
  return windowsReservedBasename.test(slug) ? `_${slug}` : slug
}
