import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { EXACT, sameFile } from "../util/file-identity.js"

const LOCK_STALE_MS = 10 * 60 * 1000

export async function acquireLock(root) {
  const file = path.join(root, "flush.lock")
  const token = randomBytes(16).toString("hex")
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(file, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), token }))
      } finally {
        await handle.close()
      }
      return { file, token }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const stat = await fsp.stat(file, EXACT).catch(() => null)
      if (stat !== null && Date.now() - Number(stat.mtimeMs) <= LOCK_STALE_MS) return null
      const again = await fsp.stat(file, EXACT).catch(() => null)
      if (stat !== null && (again === null || !sameFile(again, stat) || again.mtimeNs !== stat.mtimeNs)) return null
      await fsp.unlink(file).catch(() => {})
    }
  }
  return null
}

export async function releaseLock({ file, token }) {
  try {
    if (JSON.parse(await fsp.readFile(file, "utf8")).token === token) await fsp.unlink(file)
  } catch {
    // Gone or replaced: never remove another owner's lock.
  }
}
