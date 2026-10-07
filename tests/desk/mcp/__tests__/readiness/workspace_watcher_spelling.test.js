import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createWorkspaceWatcher } from "../../../../../plugins/desk/mcp/src/readiness/workspace-watcher.js"

test("the workspace watcher watches the operating system's spelling of the root on Windows, never an 8.3 short name", async (t) => {
  // os.tmpdir() is deliberately not resolved: on a Windows runner it is C:\Users\RUNNER~1\..., the short spelling a user's TEMP often has too.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-watch-spelling-"))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const watched = []
  const watcher = await createWorkspaceWatcher({
    root,
    watchFactory: (target) => {
      watched.push(target)
      return { close() {}, on() {} }
    },
  })
  t.after(() => watcher.close())
  assert.deepEqual(watched, [process.platform === "win32" ? await fs.realpath(root) : root])
})
