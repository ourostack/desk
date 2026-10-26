// The desk's AGENTS.md, size-capped, as boot prints it and as a hosted Desk sends it in its MCP instructions.
//
// The hosted front door imports this before the runtime pack is restored, so it imports only `node:` modules.

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import * as path from "node:path"

/** How much of the desk's AGENTS.md boot prints; the rest stays in the file, named by its path. */
export const AGENTS_MD_CAP_BYTES = 16 * 1024

// Where a file longer than `cap` bytes is cut: at its last line break inside the cap, or, with none, at a character boundary.
function cutEnd(buffer, cap) {
  let end = buffer.subarray(0, cap).lastIndexOf(0x0a)
  if (end === -1) {
    end = cap
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  }
  return end
}

/** The part of `text` session start prints under `cap` bytes, cut exactly as `readAgentsMd` cuts a file. */
export function printedPart(text, cap = AGENTS_MD_CAP_BYTES) {
  const buffer = Buffer.from(text, "utf8")
  return buffer.length <= cap ? text : buffer.toString("utf8", 0, cutEnd(buffer, cap))
}

/**
 * The desk's AGENTS.md as `{ path, text, truncated, bytes, shownBytes }`, or null when the desk has none or it cannot
 * be read. A file over `cap` bytes is cut at its last line break inside the cap (or, with none, at a character
 * boundary), so a rule is never shown half-written.
 */
export function readAgentsMd(root, { cap = AGENTS_MD_CAP_BYTES } = {}) {
  const file = path.join(root, "AGENTS.md")
  let fd
  try {
    fd = openSync(file, "r")
  } catch {
    return null
  }
  try {
    // One byte past the cap tells a file of exactly `cap` bytes from a longer one.
    const buffer = Buffer.alloc(cap + 1)
    const bytesRead = readSync(fd, buffer, 0, cap + 1, 0)
    if (bytesRead <= cap) return { path: file, text: buffer.toString("utf8", 0, bytesRead), truncated: false, bytes: bytesRead, shownBytes: bytesRead }
    const end = cutEnd(buffer, cap)
    return { path: file, text: buffer.toString("utf8", 0, end), truncated: true, bytes: fstatSync(fd).size, shownBytes: end }
  } finally {
    closeSync(fd)
  }
}

/** How much of the person's AGENTS.md session start prints after the desk's (`desk` as `readAgentsMd` returned it). */
export function personAgentsCap(desk) {
  return AGENTS_MD_CAP_BYTES - (desk?.shownBytes ?? 0)
}
