// A readiness state directory under a symlinked ancestor is a real user's layout (a home under /home linked elsewhere,
// ~/.cache on another disk, macOS /var -> /private/var), not an attack; only a link at the directory itself is refused.
// Boot acceptance round 6 lost the search index to "journal has unsafe state directory ancestry" on a /var temp HOME.

import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { resolveStateDirectory } from "../../../../../plugins/desk/mcp/src/readiness/state-path.js"
import { callTool, connectOrStartController } from "../../../../../plugins/desk/mcp/src/server.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { startInProcess } from "../runtime/_in_process_desk.js"

test("a state directory under a symlinked ancestor resolves to the real path, existing or not", async () => {
  const root = await mkTempRoot("desk-state-path-")
  const real = path.join(root, "real-cache")
  fs.mkdirSync(real)
  const link = path.join(root, "linked-cache")
  fs.symlinkSync(real, link, "junction")
  assert.equal(resolveStateDirectory(path.join(link, "desk", "readiness", "id", "journal")), path.join(fs.realpathSync(real), "desk", "readiness", "id", "journal"))
  fs.mkdirSync(path.join(real, "existing"))
  assert.equal(resolveStateDirectory(path.join(link, "existing")), path.join(fs.realpathSync(real), "existing"))
})

test("a state directory that is itself a link, or a file, is still refused", async () => {
  const root = await mkTempRoot("desk-state-path-own-")
  const target = path.join(root, "target")
  fs.mkdirSync(target)
  const link = path.join(root, "journal")
  fs.symlinkSync(target, link, "junction")
  assert.throws(() => resolveStateDirectory(link), /unsafe state directory ancestry/)
  const file = path.join(root, "file")
  fs.writeFileSync(file, "x")
  assert.throws(() => resolveStateDirectory(file), /unsafe state directory ancestry/)
})

test("an ancestor that is a file or a dangling link is refused", async () => {
  const root = await mkTempRoot("desk-state-path-bad-")
  const file = path.join(root, "file")
  fs.writeFileSync(file, "x")
  assert.throws(() => resolveStateDirectory(path.join(file, "journal")), /unsafe state directory ancestry/)
  assert.throws(() => resolveStateDirectory(path.join(file, "deeper", "journal")), /unsafe state directory ancestry/)
  const dangling = path.join(root, "dangling")
  fs.symlinkSync(path.join(root, "nowhere"), dangling)
  assert.throws(() => resolveStateDirectory(path.join(dangling, "journal")), /unsafe state directory ancestry/)
})

test("an ancestor that resolves to a non-directory is refused", async () => {
  const root = await mkTempRoot("desk-state-path-nondir-")
  const io = { ...fs, lstatSync: (file) => (file === "/resolved" ? { isDirectory: () => false } : fs.lstatSync(file)), realpathSync: () => "/resolved" }
  assert.throws(() => resolveStateDirectory(path.join(root, "journal"), io), /unsafe state directory ancestry/)
})

test("an unexpected filesystem error is not hidden as an ancestry problem", async () => {
  const root = await mkTempRoot("desk-state-path-io-")
  const io = { ...fs, lstatSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) } }
  assert.throws(() => resolveStateDirectory(path.join(root, "journal"), io), /denied/)
})

test("a controller whose state home sits under a symlinked ancestor journals a real MCP mutation (a home under /var -> /private/var)", async () => {
  const directory = await mkTempRoot("desk-state-path-linked-home-")
  const root = path.join(directory, "workspace")
  fs.mkdirSync(root)
  const realHome = path.join(directory, "real-home")
  fs.mkdirSync(realHome)
  const linkedHome = path.join(directory, "linked-home")
  fs.symlinkSync(realHome, linkedHome, "junction")
  let controller
  const desk = await startInProcess({
    argv: ["--root", root],
    env: {},
    readinessPolicy: { write_authority: "workspace", semantic: "unsupported", authority_provider: null },
    runtimeImporter: async () => ({
      callTool,
      async connectOrStartController(options) {
        controller = await connectOrStartController({ ...options, stateHome: path.join(linkedHome, ".cache", "desk", "readiness"), ephemeral: true })
        return controller
      },
    }),
  })
  try {
    const result = await desk.call("task_create", { track: "ops", slug: "linked", title: "durable" })
    assert.equal(result.isError, false, JSON.stringify(result.payload))
    await controller.barrier({ capability: "lexical", wait: true })
    const status = await controller.status()
    assert.equal(status.freshness.cursor.sequence, 1)
    assert.notEqual(status.convergence?.status, "failed", JSON.stringify(status.convergence))
  } finally {
    await desk.close()
    await controller?.close()
  }
})

test("the directory holding the state directory must belong to the user or root and not be world-writable unless sticky; group-writable is fine", async () => {
  const root = await mkTempRoot("desk-state-path-perm-")
  const real = fs.realpathSync(root)
  const stat = (over) => (file) => ({ ...fs.lstatSync(file), isDirectory: () => true, ...over })
  const ioWith = (over) => ({ ...fs, lstatSync: (file) => (file === real ? stat(over)(file) : fs.lstatSync(file)) })
  const target = path.join(root, "journal")
  const ok = (over, platform = "linux", uid = 501) => resolveStateDirectory(target, ioWith(over), platform, uid)
  assert.equal(ok({ uid: 501, mode: 0o40755 }), path.join(real, "journal"))
  assert.equal(ok({ uid: 0, mode: 0o40755 }), path.join(real, "journal"))
  assert.equal(ok({ uid: 501, mode: 0o41777 }), path.join(real, "journal"))
  assert.equal(ok({ uid: 501, mode: 0o40775 }), path.join(real, "journal"))
  assert.equal(ok({ uid: 501, mode: 0o40770 }), path.join(real, "journal"))
  const world = new RegExp(`unsafe state directory ancestry: ${real} is writable by everyone.*chmod o-w "${real}"`)
  assert.throws(() => ok({ uid: 501, mode: 0o40757 }), world)
  assert.throws(() => ok({ uid: 501, mode: 0o40777 }), world)
  assert.throws(() => ok({ uid: 777, mode: 0o40755 }), new RegExp(`unsafe state directory ancestry: ${real} is owned by another user \\(uid 777\\).*chown "\\$USER" "${real}"`))
  // Windows has no such modes, and a platform without uids is not checked either.
  assert.equal(ok({ uid: 777, mode: 0o40777 }, "win32"), path.join(real, "journal"))
  assert.equal(resolveStateDirectory(target, ioWith({ uid: 777, mode: 0o40777 }), "linux", null), path.join(real, "journal"))
})

test("the refusal reaches the compact desk_status as the degraded search note, naming the directory and the chmod", async () => {
  const open = await mkTempRoot("desk-state-path-world-")
  fs.chmodSync(open, 0o777)
  const real = fs.realpathSync(open)
  let refusal
  try { resolveStateDirectory(path.join(open, "journal")) } catch (error) { refusal = error }
  assert.match(refusal.message, new RegExp(`chmod o-w "${real}"`))
  // The controller turns a journal failure into a failed convergence carrying this message (controller-server.js), which the compact answer shows.
  const compact = compactStatus({ status: "ok", readiness: { state: "degraded", detail: { convergence: { status: "failed", diagnostic: { message: refusal.message } } } } })
  assert.equal(compact.state, "ready")
  assert.equal(compact.search, "degraded")
  assert.match(compact.notes.join("\n"), new RegExp(`chmod o-w "${real}"`))
})
