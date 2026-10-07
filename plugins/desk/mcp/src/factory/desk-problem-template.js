// The public-safe Desk-problem issue template (spec.md §1, "The public-safe
// issue template"): structured fields only, mirroring `kaizen-file.js`'s
// `publicCard` shape -- reusing its credential/path/email scrub (`isGeneric`,
// `PRIVATE_TEXT`) and its title normalization (`normalizeTitle`) rather than
// duplicating them (spec.md, "Notes for whoever reviews this" / ruling 5).
//
// One new scrub lives here, because `PRIVATE_TEXT` only catches machine
// paths and emails, not desk-relative paths such as `<track>/<task>/
// planning.md`: `redactDeskRelativePaths` reduces any such path to a count
// and a reserved-directory category before the text ever reaches a rendered
// issue body. Desk's own reserved top-level names (`_meta`, `_friction`,
// `_planning`, `.gitignore`) are not desk content -- every desk has them --
// so a short reserved-name-only path (`_meta/friction.md`) survives
// verbatim; a path that carries more than that (a real track or task name
// nested under one, or any ordinary desk-relative path at all) is reduced to
// its category.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { isGeneric, normalizeTitle } from "./kaizen-file.js"
import { deskProblemFingerprint, normalizeErrorSignature } from "./desk-problem-fingerprint.js"

export const FINGERPRINT_PREFIX = "<!-- desk-problem-fingerprint: "
// Desk's own fixed structural names: present on every desk, so naming one
// reveals nothing about a specific operator's project or task.
const RESERVED_DESK_NAMES = Object.freeze(["_meta", "_friction", "_planning", ".gitignore"])
const GENERIC_PLACEHOLDER = "(error text withheld -- it carried a credential- or machine-path-shaped string that did not clear the public-safe scrub)"

// A relative, slash-separated path shape: two or more segments of ordinary
// filename characters. A bare word with no slash is never touched here --
// it could be any ambient word, not necessarily desk-relative -- and an
// absolute or `~`-relative path is already `PRIVATE_TEXT`'s job.
const DESK_PATH_LIKE = /[\w.-]+(?:\/[\w.-]+)+/gu
const MARKER = "\u0000"

/**
 * `redactDeskRelativePaths(text) -> string`: replaces every desk-relative
 * path shape in `text` with one summary phrase such as `1 path (1
 * task-scoped)` or `2 paths (1 under _meta/, 1 task-scoped)` -- never the
 * paths themselves. A path whose only content beyond a reserved directory
 * name is a single file (`_meta/friction.md`) survives verbatim: it names no
 * private project. A deeper path under a reserved directory, or any
 * ordinary (non-reserved) desk-relative path, is redacted and counted.
 */
export function redactDeskRelativePaths(text) {
  if (typeof text !== "string" || text === "") return text
  const counts = { taskScoped: 0, reserved: {} }
  let sawAny = false
  const marked = text.replace(DESK_PATH_LIKE, (match) => {
    const segments = match.split("/")
    const [first] = segments
    if (RESERVED_DESK_NAMES.includes(first) && segments.length <= 2) return match
    sawAny = true
    if (RESERVED_DESK_NAMES.includes(first)) counts.reserved[first] = (counts.reserved[first] ?? 0) + 1
    else counts.taskScoped += 1
    return MARKER
  })
  if (!sawAny) return marked
  const reservedTotal = Object.values(counts.reserved).reduce((sum, n) => sum + n, 0)
  const total = counts.taskScoped + reservedTotal
  const parts = [
    ...Object.entries(counts.reserved).map(([name, n]) => `${n} under ${name}/`),
    ...(counts.taskScoped > 0 ? [`${counts.taskScoped} task-scoped`] : []),
  ]
  const summary = `${total} path${total === 1 ? "" : "s"} (${parts.join(", ")})`
  let first = true
  return marked
    .replace(new RegExp(MARKER, "gu"), () => {
      if (!first) return ""
      first = false
      return summary
    })
    .replace(/[ \t]{2,}/gu, " ")
    .trim()
}

/**
 * `deskProblemCard({ mechanism, deskVersion, host, rawText, fixAttempt,
 * fingerprint }) -> { title, body }`: the issue a Desk-problem filing opens.
 * `fingerprint` is optional -- when the caller has already computed one (to
 * search for a duplicate before deciding whether to file), it is reused
 * verbatim so the card's embedded marker can never drift from the fingerprint
 * that decided whether to file; when omitted, it is derived the same way,
 * from `mechanism` and `rawText`'s normalized signature.
 */
export function deskProblemCard({
  mechanism, deskVersion = "unknown", host = "unknown", rawText = "", fixAttempt = "not recorded", fingerprint,
} = {}) {
  const signature = normalizeErrorSignature(rawText)
  const hash = fingerprint ?? deskProblemFingerprint(mechanism, signature)
  const redacted = redactDeskRelativePaths(rawText)
  const safeText = redacted.trim() !== "" && isGeneric(redacted) ? redacted : GENERIC_PLACEHOLDER
  const title = normalizeTitle(`${mechanism}: ${signature || "failure"}`)
  const body = [
    "A Desk mechanism failed at its own job and filed this automatically (the `desk-problem` skill's procedure). A public issue carries structured fields only; nothing about the operator, the machine, or the specific project is included.",
    "",
    `- Mechanism: \`${mechanism}\``,
    `- Desk version: \`${deskVersion}\``,
    `- Host: \`${host}\``,
    `- Error: ${safeText}`,
    `- Fix attempted: ${fixAttempt}`,
    "",
    `${FINGERPRINT_PREFIX}${hash} -->`,
  ].join("\n")
  return { title, body }
}
