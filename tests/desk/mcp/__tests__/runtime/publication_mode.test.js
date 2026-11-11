import { test } from "node:test"
import assert from "node:assert/strict"
import { applyPublicationMode, publicationArgs, publicationDeferred, PUBLICATION_ENV } from "../../../../../plugins/desk/mcp/src/runtime/publication-mode.js"
import { schedulePush } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { parseArgs } from "../../../../../plugins/desk/mcp/index.js"
import { runBootCli } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { runSessionSyncCli } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

const io = { stdout: { write() { return true } }, stderr: { write() { return true } } }

test("only the launch argument defers publication; an inherited variable is cleared", () => {
  const env = {}
  applyPublicationMode(parseArgs(["--root", "/made-up/desk", "--publication", "deferred"]), env)
  assert.equal(env[PUBLICATION_ENV], "deferred")
  assert.equal(publicationDeferred(env), true)
  for (const argv of [["--root", "/made-up/desk"], ["--publication", "later"], ["--publication"]]) {
    const inherited = { [PUBLICATION_ENV]: "deferred" }
    applyPublicationMode(parseArgs(argv), inherited)
    assert.equal(PUBLICATION_ENV in inherited, false, JSON.stringify(argv))
    assert.equal(publicationDeferred(inherited), false)
  }
})

test("a deferred server commits without starting the push worker; otherwise the worker is scheduled", () => {
  const spawned = []
  const spawnWorker = (options) => spawned.push(options.root)
  schedulePush({ root: "/made-up/deferred", env: { [PUBLICATION_ENV]: "deferred" }, spawnWorker })
  assert.deepEqual(spawned, [])
  schedulePush({ root: "/made-up/ordinary", env: {}, spawnWorker })
  assert.deepEqual(spawned, ["/made-up/ordinary"])
})

test("a deferred server hands the mode to the children it starts; an ordinary one hands nothing", () => {
  assert.deepEqual(publicationArgs({ [PUBLICATION_ENV]: "deferred" }), ["--publication", "deferred"])
  assert.deepEqual(publicationArgs({}), [])
})

test("session start and session sync set the mode from their own arguments, never from an inherited variable", async () => {
  const boot = { [PUBLICATION_ENV]: "deferred" }
  await runBootCli({ argv: ["--json"], env: boot, io, bootFn: async () => ({ boot_complete: true, status: "ready" }) })
  assert.equal(PUBLICATION_ENV in boot, false)
  const seen = []
  const syncFn = async ({ env }) => { seen.push(env[PUBLICATION_ENV]); return {} }
  await runSessionSyncCli({ argv: ["--root", "/made-up/desk"], env: { [PUBLICATION_ENV]: "deferred" }, io, syncFn })
  await runSessionSyncCli({ argv: ["--root", "/made-up/desk", "--publication", "deferred"], env: {}, io, syncFn })
  assert.deepEqual(seen, [undefined, "deferred"])
})
