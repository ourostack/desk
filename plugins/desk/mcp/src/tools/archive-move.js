import { promises as fs } from "node:fs"

// The default task lifecycle captures before its corresponding prepareArchiveState.
// A moveArchive override is a legacy transport seam, never default-native proof.
export async function openArchiveMoveSession({ source, destination }, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) === "win32") {
    const { openArchiveHandleSession } = await import("./archive-native-session.js")
    return openArchiveHandleSession({ source, destination }, dependencies)
  }
  return {
    async admit() {},
    async move(beforeMove) {
      await beforeMove()
      await fs.rename(source, destination)
    },
    async close() {},
  }
}
