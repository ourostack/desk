// A failed Desk call must leave the desk as it found it, empty folders included. `withCreatedDirs` makes the folder a
// write needs, runs the write, and when the write throws removes the folders it made (each only if still empty, deepest
// first) before rethrowing. A folder that already existed, or that holds anything, is never touched.

import { promises as fs } from "node:fs"
import * as path from "node:path"

export async function withCreatedDirs(directory, work) {
  const first = await fs.mkdir(directory, { recursive: true })
  try {
    return await work()
  } catch (error) {
    if (typeof first === "string") {
      for (let dir = directory; dir.length >= first.length; dir = path.dirname(dir)) {
        try {
          await fs.rmdir(dir)
        } catch {
          break
        }
        if (dir === first) break
      }
    }
    throw error
  }
}
