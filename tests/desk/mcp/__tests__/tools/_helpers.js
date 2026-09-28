// Shared scaffolding for tool tests — isolated tmp desk root + matter parsing.

// Imported first so a test file run on its own (`node --test <file>`, not
// through `npm test`) also gets the temporary HOME and XDG folders and the
// real-home write guard: these fixtures feed task_create/task_update/
// task_archive, whose terminal-status transitions write factory state under
// whatever `$XDG_STATE_HOME` resolves to at call time.
import "../_isolated_env.mjs"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after } from "node:test"
import matter from "gray-matter"

const tempDeskRoots = new Set()

// A git child a test started can still be writing under .git/objects when the file ends, so removal retries as _temp_roots.js does.
after(() => Promise.all([...tempDeskRoots].map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))))

export async function mkTempDeskRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-test-"))
  tempDeskRoots.add(root)
  return root
}

export async function readFront(filePath) {
  const raw = await fs.readFile(filePath, "utf8")
  return matter(raw)
}

export async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
