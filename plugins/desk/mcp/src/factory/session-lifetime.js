import { constants, promises as fs } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { isPlainObject } from "./schema.js"
import { normalizeTimestamp } from "./time.js"

const MAX_LINE_BYTES = 1024 * 1024
const COPILOT_ACTIVITY = new Set(["session.start", "session.resume", "assistant.turn_start", "user.message"])
const CLAUDE_ACTIVITY = new Set(["session.resume", "user", "assistant"])

function invalidatesEnd(text, marker) {
  if (text.trim() === "") return false
  let event
  try { event = JSON.parse(text) } catch { return true }
  if (!isPlainObject(event)) return true
  if (event.agentId != null || event.isSidechain === true) return false
  if (event.sessionId !== undefined && event.sessionId !== marker.session_id) return false
  const activity = marker.host === "copilot-cli" ? COPILOT_ACTIVITY : CLAUDE_ACTIVITY
  if (!activity.has(event.type)) return false
  const at = normalizeTimestamp(event.timestamp)
  return at === null || at > marker.ended_at
}

// Only lifecycle metadata leaves this bounded streaming pass. Unknown evidence cannot certify closure.
async function hasLaterActivity(marker) {
  const handle = await fs.open(marker.log_path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("source_unreadable")
    const buffer = Buffer.alloc(64 * 1024)
    const decoder = new StringDecoder("utf8")
    let pending = ""
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) return invalidatesEnd(pending + decoder.end(), marker)
      const parts = decoder.write(buffer.subarray(0, bytesRead)).split("\n")
      for (let index = 0; index < parts.length; index++) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(parts[index]) > MAX_LINE_BYTES) return true
        pending += parts[index]
        if (index < parts.length - 1) {
          if (invalidatesEnd(pending, marker)) return true
          pending = ""
        }
      }
    }
  } finally {
    await handle.close()
  }
}

export async function reconcileMarker(marker) {
  if (marker.ended_at !== null && marker.end_reason !== null && !(await hasLaterActivity(marker))) return marker
  return { ...marker, ended_at: null, end_reason: null }
}
