// The operator's standing authority, as Copilot's session start shows it in every session the desk homes, whatever
// repository the session works in. A grant lives under a `## Standing authority` heading in the desk's AGENTS.md (in a
// Crew workspace, the person's own `desks/<alias>/AGENTS.md`), and session start copies that section into the session's
// context, because a host default such as "commit only when the user explicitly asks" gives way only to guidance the
// session actually has, and boot's full AGENTS.md print can land in a file the agent never opens.

import { closeSync, openSync, readSync } from "node:fs"
import * as path from "node:path"

/** How much of each file's section session start shows; the rest stays in the file, named by its path. */
export const STANDING_AUTHORITY_CAP_BYTES = 4 * 1024
// A grant section sits near the top of a desk's AGENTS.md; reading past this never finds one boot would show.
const READ_BYTES = 64 * 1024

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/u

function readHead(file) {
  let fd
  try {
    fd = openSync(file, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(READ_BYTES)
    const bytesRead = readSync(fd, buffer, 0, READ_BYTES, 0)
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

/** The body of the first `Standing authority` heading (any level) up to the next heading at its level or above, or null. */
export function standingAuthoritySection(text) {
  const lines = String(text ?? "").split(/\r?\n/u)
  let level = 0
  const body = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/u.test(line)) inFence = !inFence
    const heading = inFence ? null : HEADING.exec(line)
    if (level === 0) {
      if (heading && /^standing authority\b/iu.test(heading[2])) level = heading[1].length
      continue
    }
    if (heading && heading[1].length <= level) break
    body.push(line)
  }
  const section = body.join("\n").trim()
  return level === 0 || section === "" ? null : section
}

/** `text` cut to `cap` bytes at its last line break inside the cap, with a pointer to the rest. */
function capped(text, cap, file) {
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= cap) return text
  let end = buffer.subarray(0, cap).lastIndexOf(0x0a)
  if (end <= 0) end = cap
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return `${buffer.toString("utf8", 0, end).trimEnd()}\n(The section continues in ${file}.)`
}

/**
 * The startup line that shows the operator's standing authority, or "" when their file has no `Standing authority`
 * section. A solo desk's file is its root AGENTS.md. In a Crew workspace (`crew`) the root AGENTS.md is the team's and
 * grants nothing, so only the person's own `desks/<alias>/AGENTS.md` is read (`personPrefix` as `improvementPerson`
 * resolves it), and an unresolved person shows nothing; another member's desk is never read.
 */
export function standingAuthorityLine({ root, personPrefix = "", crew = false, cap = STANDING_AUTHORITY_CAP_BYTES, read = readHead }) {
  if (!root) return ""
  const files = crew ? (personPrefix ? [path.join(root, personPrefix, "AGENTS.md")] : []) : [path.join(root, "AGENTS.md")]
  const parts = []
  for (const file of files) {
    const section = standingAuthoritySection(read(file))
    if (section) parts.push(`From ${file}:\n${capped(section, cap, file)}`)
  }
  if (parts.length === 0) return ""
  return `Desk standing authority: the operator recorded these grants in their own desk. They apply in this session whatever repository it works in, and they answer host defaults that wait for an explicit request, such as "commit only when the user explicitly asks" and "never push automatically" (interaction-style, "Standing authority").\n\n${parts.join("\n\n")}`
}
