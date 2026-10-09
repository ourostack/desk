// The desk's AGENTS.md, size-capped, as boot prints it and as a hosted Desk sends it in its MCP instructions.
//
// The hosted front door imports this before the runtime pack is restored, so it imports only `node:` modules.

import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import * as path from "node:path"

/** How much of the desk's AGENTS.md boot prints; the rest stays in the file, named by its path. */
export const AGENTS_MD_CAP_BYTES = 16 * 1024

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
    let end = buffer.subarray(0, cap).lastIndexOf(0x0a)
    if (end === -1) {
      end = cap
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
    }
    return { path: file, text: buffer.toString("utf8", 0, end), truncated: true, bytes: fstatSync(fd).size, shownBytes: end }
  } finally {
    closeSync(fd)
  }
}
