import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { scratch } from "./_session_helpers.js"

const storage = await import("../../../../../plugins/desk/mcp/src/factory/contribution-storage.js").catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {}
  throw error
})
const requireStorage = () => assert.equal(typeof storage.openContributionRootReadOnly, "function", "strict contribution storage is missing")
const scope = "a".repeat(64)
const options = { platform: "linux", store: "synthetic/proofs", intake: "b".repeat(16), ownerScope: scope }
async function setup(ctx) {
  const root = join(ctx.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory")
  await fs.mkdir(join(root, "contribution-policy"), { recursive: true, mode: 0o700 })
  return root
}

test("ContributionStorage_AbsentRootReadDoesNotCreateAnyDirectory", () => scratch(async ctx => {
  requireStorage()
  const before = await fs.readdir(ctx.base)
  assert.deepEqual(await storage.openContributionRootReadOnly(ctx.env, options), { state: "absent" })
  assert.deepEqual(await fs.readdir(ctx.base), before)
  await assert.rejects(fs.stat(ctx.env.XDG_STATE_HOME), { code: "ENOENT" })
}))

test("ContributionStorage_ClosedRoleReadsExistingBytesWithoutRepair", () => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  const file = join(root, "contribution-policy", `${scope}.json`)
  await fs.writeFile(file, "synthetic\n", { mode: 0o600 })
  const opened = await storage.openContributionRootReadOnly(ctx.env, options)
  assert.equal(opened.state, "ready")
  const before = await fs.stat(file)
  const result = await storage.readContributionFiles(opened.root, [{ role: "ledger" }, { role: "activation" }])
  assert.equal(result.state, "ready")
  assert.equal(result.files.ledger.toString(), "synthetic\n")
  assert.equal(result.files.activation, null)
  const after = await fs.stat(file)
  assert.equal(after.ctimeMs, before.ctimeMs)
  assert.equal(after.mode, before.mode)
  assert.deepEqual(await fs.readdir(root), ["contribution-policy"])
}))

for (const fault of ["linked", "symlink", "mode", "too_large"]) {
  test(`ContributionStorage_${fault}RoleRefusesWithoutRepair`, () => scratch(async ctx => {
    requireStorage()
    const root = await setup(ctx)
    const file = join(root, "contribution-policy", `${scope}.json`)
    await fs.writeFile(file, fault === "too_large" ? Buffer.alloc(1024 * 1024 + 1) : "synthetic", { mode: 0o600 })
    if (fault === "linked") await fs.link(file, join(root, "retained-link"))
    if (fault === "symlink") { await fs.rename(file, `${file}.retained`); await fs.symlink(`${file}.retained`, file) }
    if (fault === "mode") await fs.chmod(file, 0o644)
    const opened = await storage.openContributionRootReadOnly(ctx.env, options)
    const before = await fs.lstat(file)
    const result = await storage.readContributionFiles(opened.root, [{ role: "ledger" }])
    assert.equal(result.state, "unavailable")
    const after = await fs.lstat(file)
    assert.equal(after.mode, before.mode)
    assert.equal(after.ino, before.ino)
    assert.equal(after.size, before.size)
  }))
}

test("ContributionStorage_UnsafeRootRefusesWithoutChangingProtection", () => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  await fs.chmod(root, 0o755)
  const before = await fs.stat(root)
  assert.equal((await storage.openContributionRootReadOnly(ctx.env, options)).state, "unavailable")
  assert.equal((await fs.stat(root)).mode, before.mode)
}))

test("ContributionStorage_UnknownRoleAndUnbrandedRootCannotReadCallerPath", () => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  const opened = await storage.openContributionRootReadOnly(ctx.env, options)
  const request = [{ role: "ledger", path: join(ctx.base, "PRIVATE_SENTINEL") }]
  assert.equal((await storage.readContributionFiles(opened.root, request)).state, "unavailable")
  assert.equal((await storage.readContributionFiles({ path: root, ...options }, [{ role: "ledger" }])).state, "unavailable")
  assert.equal((await storage.readContributionFiles(opened.root, [{ role: "arbitrary" }])).state, "unavailable")
}))

test("ContributionStorage_ReplacementDuringHeldReadRefusesMixedSnapshot", t => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  const file = join(root, "contribution-policy", `${scope}.json`)
  await fs.writeFile(file, "before", { mode: 0o600 })
  const opened = await storage.openContributionRootReadOnly(ctx.env, options)
  const open = fs.open
  let changed = false
  const mock = t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args)
    if (args[0] === file && !changed) {
      changed = true
      await fs.rename(file, `${file}.retained`)
      await fs.writeFile(file, "after!", { mode: 0o600 })
    }
    return handle
  })
  try {
    assert.equal((await storage.readContributionFiles(opened.root, [{ role: "ledger" }])).state, "unavailable")
    assert.equal(await fs.readFile(file, "utf8"), "after!")
  } finally { mock.mock.restore() }
}))

test("ContributionStorage_GrowingHeldFileUsesBoundedSentinelAndClosesItsDescriptor", t => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  const file = join(root, "contribution-policy", `${scope}.json`)
  await fs.writeFile(file, "old", { mode: 0o600 })
  const opened = await storage.openContributionRootReadOnly(ctx.env, options)
  const open = fs.open
  let readBudget = 0, closed = 0
  const mock = t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args)
    if (args[0] === file) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle)
      let grew = false
      t.mock.method(handle, "read", async (...readArgs) => {
        readBudget += readArgs[2]
        if (!grew) { grew = true; await fs.appendFile(file, Buffer.alloc(1024 * 1024 + 1)) }
        return read(...readArgs)
      })
      t.mock.method(handle, "close", async () => { closed += 1; return close() })
    }
    return handle
  })
  try {
    assert.equal((await storage.readContributionFiles(opened.root, [{ role: "ledger" }])).state, "unavailable")
    assert.ok(readBudget <= 4, "only original three bytes plus one sentinel may be requested")
    assert.equal(closed, 1)
    assert.equal((await fs.stat(file)).size, 1024 * 1024 + 4)
  } finally { mock.mock.restore() }
}))

test("ContributionStorage_ExactByteCapPassesAndOversizeOrTooManyRolesAllocateNothing", t => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  const file = join(root, "contribution-policy", `${scope}.json`)
  await fs.writeFile(file, Buffer.alloc(1024 * 1024), { mode: 0o600 })
  const opened = await storage.openContributionRootReadOnly(ctx.env, options)
  const exact = await storage.readContributionFiles(opened.root, [{ role: "ledger" }])
  assert.equal(exact.state, "ready")
  assert.equal(exact.files.ledger.length, 1024 * 1024)
  await fs.appendFile(file, "x")
  const alloc = Buffer.alloc
  let allocated = 0
  const mock = t.mock.method(Buffer, "alloc", (...args) => { allocated += args[0]; return alloc(...args) })
  try {
    assert.equal((await storage.readContributionFiles(opened.root, [{ role: "ledger" }])).state, "unavailable")
    assert.equal((await storage.readContributionFiles(opened.root, Array.from({ length: 33 }, () => ({ role: "ledger" })))).state, "unavailable")
    assert.equal(allocated, 0)
  } finally { mock.mock.restore() }
}))

test("ContributionStorage_ExpiredSnapshotBudgetRefusesBeforeAnyRoleAllocation", t => scratch(async ctx => {
  requireStorage()
  const root = await setup(ctx)
  await fs.writeFile(join(root, "contribution-policy", `${scope}.json`), "synthetic", { mode: 0o600 })
  const deadline = Date.now() + 20000
  const opened = await storage.openContributionRootReadOnly(ctx.env, { ...options, deadline })
  assert.equal(opened.state, "ready")
  const alloc = Buffer.alloc
  let allocated = 0
  t.mock.method(Date, "now", () => deadline + 1)
  t.mock.method(Buffer, "alloc", (...args) => { allocated += args[0]; return alloc(...args) })
  const result = await storage.readContributionFiles(opened.root, [{ role: "ledger" }])
  assert.equal(result.code, "deadline")
  assert.equal(allocated, 0)
}))
