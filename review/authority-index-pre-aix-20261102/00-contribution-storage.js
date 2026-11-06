import { constants, promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { acquireLock, releaseLock } from "./flush-lock.js"
import { expandHome } from "./os-protect.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"
import { ENUMS, PATTERNS } from "./schema.js"

const MIB = 1024 * 1024
const roots = new WeakMap()
const HEX = /^[0-9a-f]{64}$/u
const INTAKE = /^[0-9a-f]{16}$/u
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const unavailable = code => ({ state: "unavailable", code })
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
const sameBytes = (a, b) => sameIdentity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const dataFields = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).every(key => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
const failure = code => { throw Object.assign(new Error(code), { contributionCode: code }) }
const knownFailure = error => error.contributionCode ??
  (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code) ? "storage_unavailable" : null)
const within = deadline => { if (Date.now() >= deadline) failure("deadline") }
async function statIfPresent(file) {
  try { return await fs.lstat(file, { bigint: true }) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
}
function safeDirectory(stat, privateMode) {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (stat.mode & BigInt(privateMode ? 0o077 : 0o022)) === 0n &&
    (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()))
}
async function inspectParents(home, destination) {
  const parents = []
  let cursor = path.parse(home).root
  for (const segment of path.relative(cursor, destination).split(path.sep)) {
    cursor = path.join(cursor, segment)
    const stat = await statIfPresent(cursor)
    if (stat === null) return { absent: true, parents }
    if (!stat.isDirectory() || stat.isSymbolicLink()) failure("path_unsafe")
    if (cursor === home || cursor.startsWith(`${home}${path.sep}`)) {
      if (!safeDirectory(stat, cursor !== home)) failure("path_unsafe")
    }
    if (await statIfPresent(path.join(cursor, ".git")) !== null) failure("path_unsafe")
    parents.push({ file: cursor, stat })
  }
  return { absent: false, parents }
}
async function currentParents(parents) {
  for (const { file, stat } of parents) {
    const current = await statIfPresent(file)
    if (current === null || !current.isDirectory() || !sameIdentity(stat, current)) failure("path_changed")
  }
}

/** Existing-root observation only; never creates, repairs protection or acquires a lock. */
export async function openContributionRootReadOnly(env, options = {}) {
  if (!dataFields(options) || Object.keys(options).some(key => !["platform", "store", "intake", "ownerScope", "deskRoot", "deadline"].includes(key)) ||
      typeof options.store !== "string" || !PATTERNS.prRepo.test(options.store) || !INTAKE.test(options.intake) ||
      !HEX.test(options.ownerScope) || options.deadline !== undefined && !Number.isFinite(options.deadline)) return unavailable("invalid_scope")
  if ((options.platform ?? process.platform) !== "linux") return unavailable("platform_unqualified")
  const homeDir = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME : os.homedir()
  const home = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim()
    ? path.resolve(expandHome(env.XDG_STATE_HOME, homeDir)) : path.join(homeDir, ".local", "state")
  const rootPath = path.join(home, "ouroboros-skills", "desk", "factory")
  const store = options.store.toLowerCase()
  const intakePath = path.join(rootPath, "contribution-control", store.replace("/", "__"), options.intake)
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 120000)
  try {
    within(deadline)
    assertNotRealStateUnderTest(home, { env })
    if (options.deskRoot !== undefined) {
      if (typeof options.deskRoot !== "string" || !path.isAbsolute(options.deskRoot)) return unavailable("invalid_scope")
      const relative = path.relative(options.deskRoot, rootPath)
      if (relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        return unavailable("path_unsafe")
    }
    const checked = await inspectParents(home, rootPath)
    if (checked.absent) return { state: "absent" }
    await currentParents(checked.parents)
    within(deadline)
    const root = Object.freeze({})
    roots.set(root, { home, rootPath, intakePath, store, intake: options.intake, ownerScope: options.ownerScope, parents: checked.parents, deadline })
    return { state: "ready", root }
  } catch (error) {
    const code = knownFailure(error)
    if (code !== null) return unavailable(code)
    throw error
  }
}

function roleFile(scope, selector) {
  if (!dataFields(selector)) failure("invalid_role")
  const role = selector.role
  const keys = Object.keys(selector).sort().join()
  const owner = path.join(scope.rootPath, "contribution-policy", scope.ownerScope)
  if (["ledger", "activation", "secret", "consent", "status", "index", "transaction", "qualification", "delivered", "deliveryPaths"].includes(role)) {
    if (keys !== "role") failure("invalid_role")
    const direct = {
      ledger: `${owner}.json`, activation: `${owner}.active.json`,
      secret: path.join(scope.rootPath, "machine-secret"), consent: path.join(scope.rootPath, "consent.json"),
      status: path.join(scope.rootPath, "status.json"), index: path.join(scope.intakePath, "index.json"),
      transaction: path.join(scope.intakePath, "transaction.json"), qualification: path.join(scope.intakePath, "qualification.json"),
      delivered: path.join(scope.rootPath, "delivered", `${scope.store.replace("/", "__")}.json`),
      deliveryPaths: path.join(scope.rootPath, "delivered-paths", `${scope.store.replace("/", "__")}.json`),
    }
    return { role, file: direct[role], cap: role === "transaction" ? 4 * MIB : role === "secret" ? 32 : MIB }
  }
  if (["marker", "facts"].includes(role) && keys === "host,role,session" &&
      ENUMS.host.includes(selector.host) && SESSION.test(selector.session)) {
    const name = `${selector.host}-${selector.session}.json`
    return { role, file: role === "marker" ? path.join(scope.rootPath, "markers", name) :
      path.join(scope.rootPath, "outbox", scope.store.replace("/", "__"), name), cap: role === "marker" ? 65536 : 16 * MIB }
  }
  if (role === "receipt" && keys === "id,role" && HEX.test(selector.id))
    return { role, file: path.join(scope.intakePath, "receipts", `${selector.id}.json`), cap: MIB }
  failure("invalid_role")
}

/** Bounded coherent role set; an absent role is null, never a ready empty policy. */
export async function readContributionFiles(root, selectors) {
  const scope = roots.get(root)
  if (!scope || !Array.isArray(selectors) || selectors.length > 32) return unavailable("invalid_scope")
  const held = []
  try {
    within(scope.deadline)
    const roles = selectors.map(selector => roleFile(scope, selector))
    if (new Set(roles.map(item => item.role)).size !== roles.length) failure("invalid_role")
    await currentParents(scope.parents)
    let allocation = 0
    for (const item of roles) {
      within(scope.deadline)
      const parent = await inspectParents(scope.home, path.dirname(item.file))
      if (parent.absent) { held.push({ ...item, handle: null, parent }); continue }
      const stat = await statIfPresent(item.file)
      if (stat === null) { held.push({ ...item, handle: null, parent }); continue }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n ||
          typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) failure("file_unsafe")
      if (stat.size < 0n || stat.size > BigInt(item.cap)) failure("too_large")
      const handle = await fs.open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      held.push({ ...item, handle, parent, stat })
      if (!sameBytes(stat, await handle.stat({ bigint: true }))) failure("file_changed")
      allocation += Number(stat.size) + 1
      if (allocation > 32 * MIB) failure("too_large")
    }

    const files = {}
    within(scope.deadline)
    for (const item of held) {
      if (item.handle === null) { files[item.role] = null; continue }
      const size = Number(item.stat.size)
      const bytes = Buffer.alloc(size + 1)
      let count = 0
      while (count < bytes.length) {
        within(scope.deadline)
        const { bytesRead } = await item.handle.read(bytes, count, bytes.length - count, count)
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - count) failure("file_changed")
        if (bytesRead === 0) break
        count += bytesRead
      }
      if (count !== size || !sameBytes(item.stat, await item.handle.stat({ bigint: true }))) failure("file_changed")
      files[item.role] = bytes.subarray(0, count)
    }
    for (const item of held) {
      await currentParents(item.parent.parents)
      const current = await statIfPresent(item.file)
      if (item.handle === null ? current !== null : current === null || !sameBytes(item.stat, current)) failure("file_changed")
      if (item.handle !== null && !sameBytes(item.stat, await item.handle.stat({ bigint: true }))) failure("file_changed")
    }
    await currentParents(scope.parents)
    within(scope.deadline)
    return { state: "ready", files }
  } catch (error) {
    const code = knownFailure(error)
    if (code !== null) return unavailable(code)
    throw error
  } finally {
    let closeError
    for (const item of held) if (item.handle !== null) {
      try { await item.handle.close() } catch (error) { closeError ??= error }
    }
    if (closeError) throw closeError
  }
}

/** A source-owned caller supplies current admission before each transaction effect. No directory setup or repair. */
export async function writeContributionImage(root, selector, bytes, { expected, admit } = {}) {
  const scope = roots.get(root)
  if (!scope || typeof admit !== "function" || !Buffer.isBuffer(bytes)) failure("write_unadmitted")
  const item = roleFile(scope, selector)
  if (!["ledger", "activation", "index", "transaction", "receipt"].includes(item.role) ||
      bytes.length > item.cap || expected !== null && !HEX.test(expected)) failure("write_unadmitted")
  const matches = async () => {
    const read = await readContributionFiles(root, [selector])
    if (read.state !== "ready") failure("file_changed")
    const current = read.files[item.role]
    const digest = current === null ? null : createHash("sha256").update(current).digest("hex")
    if (digest !== expected) failure("file_changed")
  }
  const parent = await inspectParents(scope.home, path.dirname(item.file))
  if (parent.absent) failure("path_missing")
  await matches()
  await admit()
  await currentParents(parent.parents)
  const temporary = path.join(path.dirname(item.file), `.tmp-contribution-${randomBytes(16).toString("hex")}`)
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await admit()
    await handle.writeFile(bytes)
    await admit()
    await handle.sync()
  } finally { await handle.close() }
  await currentParents(parent.parents)
  await matches()
  await admit()
  await fs.rename(temporary, item.file)
  const directory = await fs.open(path.dirname(item.file), constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
  const after = await readContributionFiles(root, [selector])
  if (after.state !== "ready" || after.files[item.role] === null || !after.files[item.role].equals(bytes)) failure("file_changed")
}

async function acquireExistingCoordinationLock(scope, file, deadline, admit) {
  const parents = await inspectParents(scope.home, path.dirname(file))
  if (parents.absent) failure("path_missing")
  while (Date.now() < deadline) {
    await currentParents(parents.parents)
    await admit()
    try {
      const handle = await fs.open(file, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })) }
      finally { await handle.close() }
      return await fs.lstat(file, { bigint: true })
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const held = await statIfPresent(file)
      if (held !== null && (!held.isFile() || held.isSymbolicLink() || held.nlink !== 1n || (held.mode & 0o077n) !== 0n))
        failure("lock_unsafe")
      if (held !== null && Date.now() - Number(held.mtimeMs) > 10 * 60 * 1000) {
        await admit()
        const current = await statIfPresent(file)
        if (current !== null && sameBytes(held, current)) await fs.unlink(file)
      } else await new Promise(resolve => setTimeout(resolve, 15))
    }
  }
  failure("locked")
}

/** Exact existing physical lock order: flush, target derivation, global contribution-policy. */
export async function withContributionTransactionLock(root, target, body, { admit, deadline = Date.now() + 120000 } = {}) {
  const scope = roots.get(root)
  if (!scope || !dataFields(target) || !ENUMS.host.includes(target.host) || !SESSION.test(target.session) ||
      typeof body !== "function" || typeof admit !== "function" || !Number.isFinite(deadline)) failure("write_unadmitted")
  await currentParents(scope.parents)
  await admit()
  const outer = await acquireLock(scope.rootPath)
  if (outer === null) failure("locked")
  const held = []
  try {
    for (const file of [
      path.join(scope.rootPath, "deriving", `${target.host}-${target.session}.json.lock`),
      path.join(scope.rootPath, "locks", "contribution-policy.lock"),
    ]) held.push({ file, stat: await acquireExistingCoordinationLock(scope, file, deadline, admit) })
    await admit()
    return await body()
  } finally {
    for (const item of held.reverse()) {
      const current = await statIfPresent(item.file)
      if (current !== null && sameIdentity(item.stat, current)) await fs.unlink(item.file)
    }
    await releaseLock(outer)
  }
}
