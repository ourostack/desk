// The one writer of local triage annotations and acknowledged public identities: `publishOwnedTriage`.
//
// It writes exactly two desk files, `<prefix>/_meta/improvement-triage/identities.json` and the card's annotation, through the
// owned Desk's normal Git flow, and reports an identity or revision as acknowledged only after it reads both exact blobs back from
// a freshly fetched remote `main`. A local commit, a push exit status or a scheduled push is never an acknowledgement.
//
// How (spec 7.2; plan "Identity acknowledgement and authority basis"):
//   - It refuses a review whose authority code the expected basis does not grant, and a basis whose authority does not follow
//     from its own rulings, before any Git call.
//   - Under the existing sync lock, with `origin/main` as upstream, no merge in progress, no dirty or staged relevant path and no
//     relevant local-only commit, it fetches `origin main` and checks the expected basis (card blob, every ruling blob, the
//     default ruling paths, the effective claim at `now`, and every evidence revision resolved live) against the fetched remote
//     tree. Any difference holds.
//   - It reads the remote registry and annotation. A loser of a simultaneous first assignment adopts the acknowledged remote ID;
//     it never commits or reports its own. A review that already satisfies the same basis is adopted with no new revision.
//     The next revision is always one past the remote high-water mark, and identities are kept after removal or withdrawal.
//   - It builds the commit in a clean temporary worktree of the fetched remote main, on its own `desk-triage/<token>` branch, in
//     owner-protected factory state. It stages only the two files, checks the complete staged list and bytes, and commits with a
//     normal `git commit` under the card guard's narrow Desk-tool commit context, so the desk's hooks, including any chained policy, run on
//     the candidate tree (not the live checkout). No hook bypass. A refusal, a time-out (the whole process group is killed; the
//     process tree on Windows), a changed hook policy or any extra committed path holds without a push.
//   - It pushes the exact commit to `refs/heads/main` without force. A rejected push is retried once from a new fetch, with
//     loser adoption and the basis check repeated. Then it fetches again and reads both blobs back.
//   - It never resets, rebases, stashes or writes the live checkout, index or branch; the normal Desk sync later pulls the commit.
//     The temporary worktree and branch are removed only when the worktree is still exactly clean; otherwise they are retained and
//     reported (a file a hook left is never deleted), and block new resources with a stable alarm until they are recovered.

import { spawn as spawnDefault, spawnSync } from "node:child_process"
import { constants, promises as fs, realpathSync } from "node:fs"
import * as path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { acquireSyncLock } from "../runtime/sync-worker.js"
import { PATTERNS } from "./schema.js"
import { factoryStateRoot, gitBlobSha } from "./outbox.js"
import { ensureOwnerOnlyDirectory, protectLeafFile } from "./os-protect.js"
import { protectWindowsPaths } from "./windows-acl.js"
import { TOOL_COMMIT_ENV } from "../desk/card-commit-guard.js"
import { defaultRulingPaths, readCanonicalCard, resolveSelfDescribing, safeDeskPath } from "./triage-basis.js"
import {
  compareIdentities, protectedBasisRecord, readProtectedBasis, triagePaths, validateSafeTriageReview, validateTriageAnnotation,
  validateTriageIdentities,
} from "./triage-state.js"

const ANNOTATION_SCHEMA = "desk.factory.triage-local/1"
const IDENTITIES_SCHEMA = "desk.factory.triage-identities/1"
const OPERATION_SCHEMA = "desk.factory.triage-operation/1"
const GIT_TIMEOUT_MS = 10_000
const BLOB = /^[0-9a-f]{40}$/u
const OWNED_REF = /^desk-triage\/[0-9a-f]{32}$/u
const NAMING = { label: "desk_factory", subject: "factory state" }
const COMMIT_MESSAGE = "Record factory triage annotation"
// Existing caller-owned Git settings. Beyond these, only the exact restrictive command profile below is admitted.
// Other GIT_* (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, ...) can redirect Git or inject arbitrary configuration.
const ALLOWED_GIT_ENV = new Set([
  "GIT_TERMINAL_PROMPT", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_ASKPASS", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
  // An editor or pager is never invoked by these non-interactive calls (the commit message is given), and neither moves Git.
  "GIT_EDITOR", "GIT_PAGER",
])
const RESTRICTIVE_CONFIG = new Map([
  ["safe.bareRepository", "explicit"], ["credential.interactive", "never"], ["core.fsmonitor", "false"],
])
const PROFILE_SLOTS = new Set([
  "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2",
])
const OPERATIONS = {
  review: { state: "reviewed", reason: "review_accepted" },
  invalidate: { state: "stale", reason: "basis_changed" },
  withdraw: { state: "withdrawn", reason: "card_removed" },
}
// The reasons an invalidation may record: the mechanical check's own (`checkTriageBasis`), so Git keeps why a review went stale.
const INVALIDATE_REASONS = ["basis_changed", "claim_changed", "authority_changed", "evidence_changed", "version_changed"]
const AUTHORITY_CODES = ["existing_scope", "approved_plan", "investigation_only", "human_gate"]
// The stable code a caller raises as an alarm: an earlier temporary resource this writer cannot remove blocks every later write.
const RESOURCE_ALARM = "triage_resource_unrecoverable"

const hex = (bytes) => randomBytes(bytes).toString("hex")
// Whether a file-system step succeeded, without throwing: used where a missing or non-empty entry is an expected outcome.
const settles = (promise) => promise.then(() => true, () => false)
const sha256 = (value) => createHash("sha256").update(value).digest("hex")

// ---------------------------------------------------------------------------
// Owned processes.

// Kills `pid` and everything it started: its POSIX process group, or its Windows process tree. Never throws.
function killProcessTree(pid, platform) {
  try {
    if (platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 })
    else process.kill(-pid, "SIGKILL")
  } catch {
    // Already gone.
  }
}

// One bounded Git call in its own process group. A time-out kills the whole group, so a hook that hangs, or a process it left
// behind, does not outlive the call. Resolves `{status, stdout, stderr, timedOut}`; a spawn failure is status null.
function runGit(ctx, cwd, args, env = ctx.childEnv, outputLimit = Infinity) {
  return new Promise((resolve) => {
    const posix = ctx.platform !== "win32"
    let child
    try {
      child = ctx.spawn(ctx.executable ?? "git", cwd === null ? args : ["-C", cwd, ...args], {
        env, stdio: ["ignore", "pipe", "pipe"], detached: posix, windowsHide: true,
        ...(cwd === null ? { cwd: path.parse(ctx.deskRoot).root } : {}),
      })
    } catch {
      resolve({ status: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false })
      return
    }
    const out = []
    let stderr = ""
    let timedOut = false
    let outputBytes = 0
    let overflowed = false
    const withinLimit = (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes <= outputLimit) return true
      overflowed = true
      killProcessTree(child.pid, ctx.platform)
      return false
    }
    child.stdout.on("data", (chunk) => {
      if (withinLimit(chunk)) out.push(chunk)
    })
    child.stderr.on("data", (chunk) => {
      if (withinLimit(chunk)) stderr = `${stderr}${chunk}`.slice(-65536)
    })
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid, ctx.platform)
    }, ctx.timeoutMs)
    let settled = false
    const settle = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Anything a hook left running in the call's own group is ours to end too.
      if (posix && child.pid !== undefined) killProcessTree(child.pid, ctx.platform)
      resolve({ status: timedOut || overflowed ? null : status, stdout: Buffer.concat(out), stderr, timedOut })
    }
    child.on("error", () => settle(null))
    child.on("close", (code) => settle(code))
  })
}

const text = (result) => result.stdout.toString("utf8").trim()

// ---------------------------------------------------------------------------
// Owner-protected factory state.

/** Writes `bytes` to `<factory state>/triage/<...segments>` as an owner-only file, creating owner-only folders. Returns its path. */
export async function writeProtectedTriageFile(env, segments, bytes, { deskRoot = null, platform = process.platform, runner = undefined } = {}) {
  const root = await factoryStateRoot(env, { deskRoot, platform, runner })
  const batch = []
  let cursor = root
  for (const segment of ["triage", ...segments.slice(0, -1)]) {
    cursor = path.join(cursor, segment)
    batch.push({ path: cursor, kind: "directory", created: await ensureOwnerOnlyDirectory(cursor, platform, NAMING) })
  }
  const file = path.join(cursor, segments.at(-1))
  const temp = `${file}.${hex(4)}.tmp`
  await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 })
  await fs.rename(temp, file)
  await protectLeafFile(file, platform, NAMING)
  if (platform === "win32") await protectWindowsPaths([...batch, { path: file, kind: "file", created: true }], { env, runner, label: NAMING.label })
  return file
}

// ---------------------------------------------------------------------------
// Checks.

function unsafeEnvironment(env) {
  if (typeof env.DESK_CARD_GUARD_RUNNING === "string") return true
  let profile = false
  for (const name of Object.keys(env)) {
    if (!name.toUpperCase().startsWith("GIT_") || ALLOWED_GIT_ENV.has(name)) continue
    if (name === "GIT_OPTIONAL_LOCKS") {
      if (env[name] !== "0") return true
    } else if (PROFILE_SLOTS.has(name)) profile = true
    else return true
  }
  if (!profile) return false
  if (env.GIT_CONFIG_COUNT !== "3" || ![...PROFILE_SLOTS].every((name) => Object.hasOwn(env, name))) return true
  const keys = new Set()
  for (let slot = 0; slot < 3; slot += 1) {
    const key = env[`GIT_CONFIG_KEY_${slot}`]
    if (!RESTRICTIVE_CONFIG.has(key) || RESTRICTIVE_CONFIG.get(key) !== env[`GIT_CONFIG_VALUE_${slot}`] || keys.has(key)) return true
    keys.add(key)
  }
  return false
}

// Resolve the caller's normal PATH once, only for the new admission. As with the existing launcher, trusted host actors
// replacing executable bytes remain outside this boundary; this is per-operation path binding, not binary attestation.
async function profileGit(ctx) {
  const windows = ctx.platform === "win32"
  const envKeys = Object.keys(ctx.env)
  if (windows) envKeys.sort()
  const pathKey = envKeys.find((name) => windows ? name.toUpperCase() === "PATH" : name === "PATH")
  const search = ctx.env[pathKey]
  if (typeof search !== "string" || search === "") return null
  for (const dir of search.split(windows ? ";" : path.delimiter)) {
    const candidate = path.resolve(dir, windows ? "git.exe" : "git")
    try {
      await fs.access(candidate, constants.X_OK)
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate)
    } catch {
      // The next PATH entry may contain Git.
    }
  }
  return null
}

async function supportedProfileGit(ctx) {
  ctx.executable = await profileGit(ctx)
  if (ctx.executable === null) return false
  // Old Git treats fsmonitor=false as a hook path. Only this non-repository --version diagnostic omits the validated slots;
  // every real operation, hook and cleanup keeps the original command scope. Auth, HOME, PATH and prompt guards stay intact.
  const queryEnv = Object.fromEntries(Object.entries(ctx.childEnv).filter(([name]) => !PROFILE_SLOTS.has(name)))
  const result = await runGit(ctx, null, ["--version"], queryEnv, 1024)
  if (result.status !== 0 || result.stderr !== "") return false
  // Explicit supported vendor grammars: Apple Git-N[.N...] and Git for Windows' .windows.N; no arbitrary suffix or prerelease.
  const banner = result.stdout.toString("utf8")
  const version = /^git version (0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?: \(Apple Git-[1-9][0-9]*(?:\.[0-9]+)*\)|\.windows\.[1-9][0-9]*)?\r?\n?$/u.exec(banner)
  if (version === null || version[0] !== banner) return false
  const [major, minor, patch] = version.slice(1, 4).map(Number)
  return [major, minor, patch].every(Number.isSafeInteger) && major === 2 && minor >= 36
}

// The authority a basis grants must follow from its own rulings: existing scope needs a ruling, an approved plan a plan or spec
// among them. A basis that claims more is refused, whoever built it.
function authorityShape(basis) {
  const { authority } = basis
  if (authority === null || typeof authority !== "object" || !Array.isArray(authority.codes) || !Array.isArray(authority.plan_ids)) return false
  const rulings = basis.rulings.map((ruling) => ruling.id)
  return authority.codes.every((code) => AUTHORITY_CODES.includes(code)) &&
    (!authority.codes.includes("existing_scope") || rulings.length > 0) &&
    (!authority.codes.includes("approved_plan") || (authority.plan_ids.length > 0 && authority.plan_ids.every((id) => rulings.includes(id))))
}

function basisShape(basis, key, cardPath) {
  return basis !== null && typeof basis === "object" && basis.key === key && basis.canonical_path === cardPath &&
    (basis.canonical_revision === null || BLOB.test(basis.canonical_revision)) &&
    Array.isArray(basis.rulings) && basis.rulings.every((ruling) => safeDeskPath(ruling?.id) !== null && BLOB.test(ruling.revision)) &&
    ["live", "expired", "none"].includes(basis.claim?.state) && Array.isArray(basis.public_evidence_revisions) &&
    Array.isArray(basis.evidence) && basis.evidence.every((item) => typeof item?.pointer === "string" && Number.isSafeInteger(item.revision) && item.revision >= 1) &&
    authorityShape(basis)
}

// The hook policy Git would apply in `cwd`: core.hooksPath and every entry of the hooks folder Git resolves, by name, kind, mode
// and content. `disabled` for a hooksPath that turns hooks off; null when it cannot be read.
async function hookPolicy(ctx, cwd) {
  const config = await runGit(ctx, cwd, ["config", "--get-all", "core.hooksPath"])
  if (config.status !== 0 && config.status !== 1) return null
  const configured = config.status === 0 ? text(config) : null
  if (configured !== null && ["", "/dev/null", "nul"].includes(configured.toLowerCase())) return "disabled"
  const located = await runGit(ctx, cwd, ["rev-parse", "--git-path", "hooks"])
  if (located.status !== 0) return null
  const dir = path.resolve(cwd, text(located))
  let names
  try {
    names = (await fs.readdir(dir)).sort()
  } catch (error) {
    if (error.code !== "ENOENT") return null
    names = []
  }
  const entries = []
  try {
    for (const name of names) {
      const file = path.join(dir, name)
      const stat = await fs.lstat(file)
      const content = stat.isFile() ? sha256(await fs.readFile(file)) : stat.isSymbolicLink() ? `link:${await fs.readlink(file)}` : "other"
      entries.push([name, stat.mode, content])
    }
  } catch {
    return null
  }
  return sha256(JSON.stringify({ configured, dir, entries }))
}

// `{path, oldMode, newMode, newBlob, status}` for each entry of `git diff --raw -z --no-abbrev --no-renames` output.
function parseRaw(buffer) {
  const parts = buffer.toString("utf8").split("\0")
  const entries = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [oldMode, newMode, , newBlob, status] = parts[index].replace(/^:/u, "").split(" ")
    entries.push({ path: parts[index + 1], oldMode, newMode, newBlob, status })
  }
  return entries
}

// The diff is exactly the expected regular files, each added or modified, with the expected blob.
function exactDiff(entries, files) {
  return entries.length === files.length && files.every((file) => entries.some((entry) =>
    entry.path === file.path && ["A", "M"].includes(entry.status) && entry.newMode === "100644" && (entry.oldMode === "000000" || entry.oldMode === "100644") &&
    entry.newBlob === gitBlobSha(file.bytes)))
}

// The review content that makes two annotations the same review, whichever host wrote it (random tokens set aside).
function sameContent(annotation, target) {
  const strip = (review) => (review === null ? null : { ...review, protected_result: null })
  return annotation.attempt.state === target.attempt.state && annotation.basis.canonical_revision === target.basis.canonical_revision &&
    JSON.stringify(annotation.basis.public_evidence_revisions) === JSON.stringify(target.basis.public_evidence_revisions) &&
    JSON.stringify(strip(annotation.review)) === JSON.stringify(strip(target.review))
}

// ---------------------------------------------------------------------------
// Temporary worktree resources.

async function opsDir(ctx) {
  const dir = path.join(ctx.stateRoot, "triage", "ops")
  await ensureOwnerOnlyDirectory(path.join(ctx.stateRoot, "triage"), ctx.platform, NAMING)
  await ensureOwnerOnlyDirectory(dir, ctx.platform, NAMING)
  return dir
}

async function saveRecord(ctx, record) {
  await writeProtectedTriageFile(ctx.env, ["ops", `${record.token}.json`], `${JSON.stringify(record)}\n`, ctx.protectOptions)
}

// Whether the worktree holds nothing but the record's own files (staged or written): no other change, and no untracked or
// ignored file a hook may have left. Only then may the worktree be removed, with `--force` for those own changes.
async function onlyOwnChanges(ctx, record) {
  const status = await runGit(ctx, record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"])
  if (status.status !== 0) return false
  const entries = status.stdout.toString("utf8").split("\0").filter(Boolean)
  return entries.every((entry) => /^([AM][ M]|\?\?) /u.test(entry) && record.files.includes(entry.slice(3)))
}

// Removes the worktree and its branch only when it holds nothing but its own files: a file a hook left there is never deleted.
// Returns whether everything was removed; otherwise the record stays, marked retained, and reported.
async function release(ctx, record, resource) {
  const exists = await settles(fs.lstat(record.path))
  if (exists) {
    const removed = (await onlyOwnChanges(ctx, record)) && (await runGit(ctx, ctx.deskRoot, ["worktree", "remove", "--force", record.path])).status === 0
    if (!removed) {
      resource.disposition = "retained"
      await saveRecord(ctx, { ...record, disposition: "retained" })
      return false
    }
  } else {
    await runGit(ctx, ctx.deskRoot, ["worktree", "prune"])
  }
  if ((await runGit(ctx, ctx.deskRoot, ["rev-parse", "-q", "--verify", `refs/heads/${record.ref}`])).status === 0) {
    await runGit(ctx, ctx.deskRoot, ["branch", "-D", record.ref])
  }
  // The resource folder is removed only when empty: a file something else left there stays.
  await settles(fs.rmdir(path.dirname(record.path)))
  await settles(fs.unlink(path.join(await opsDir(ctx), `${record.token}.json`)))
  resource.disposition = "removed"
  return true
}

// A record left by an earlier call (a crash, or a removal that failed) is recovered first, without a person, when its worktree
// holds only its own files. Only exactly owned records are touched. A foreign record, an owned worktree holding files a hook left
// (kept, never deleted) or one whose removal fails blocks new resources, and the call reports `RESOURCE_ALARM`.
async function recover(ctx, resources) {
  const dir = await opsDir(ctx)
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".json")) continue
    let record
    try {
      record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"))
    } catch {
      record = null
    }
    const owned = record?.schema === OPERATION_SCHEMA && name === `${record.token}.json` && OWNED_REF.test(record.ref) && Array.isArray(record.files) &&
      record.ref === `desk-triage/${record.token}` && record.path === path.join(dir, record.token, "wt")
    const resource = { kind: "worktree", path: owned ? record.path : path.join(dir, name), ref: owned ? record.ref : null, owner: record?.owner ?? null, disposition: "retained" }
    resources.push(resource)
    if (!owned || !(await release(ctx, record, resource))) return false
  }
  return true
}

// Builds and commits the candidate in a clean temporary worktree of `base`. Returns `{commit, record, resource}` or `{hold}`.
async function candidate(ctx, base, files, resources) {
  const token = hex(16)
  const dir = await opsDir(ctx)
  const record = {
    schema: OPERATION_SCHEMA, token, path: path.join(dir, token, "wt"), ref: `desk-triage/${token}`, owner: process.pid,
    files: files.map((file) => file.path), disposition: "active",
  }
  const resource = { kind: "worktree", path: record.path, ref: record.ref, owner: record.owner, disposition: "active" }
  resources.push(resource)
  await saveRecord(ctx, record)
  await ensureOwnerOnlyDirectory(path.dirname(record.path), ctx.platform, NAMING)
  const hold = async (state) => {
    await release(ctx, record, resource)
    return { hold: state }
  }
  if ((await runGit(ctx, ctx.deskRoot, ["worktree", "add", "-q", "-b", record.ref, record.path, base])).status !== 0) return hold("write_failed")
  for (const file of files) {
    let cursor = record.path
    for (const segment of path.posix.dirname(file.path).split("/")) {
      cursor = path.join(cursor, segment)
      const stat = await fs.lstat(cursor).catch(() => null)
      if (stat !== null && !stat.isDirectory()) return hold("unsafe_path")
      if (stat === null) await fs.mkdir(cursor)
    }
    const target = path.join(record.path, ...file.path.split("/"))
    const existing = await fs.lstat(target).catch(() => null)
    if (existing !== null && !existing.isFile()) return hold("unsafe_path")
    await fs.writeFile(target, file.bytes)
  }
  if ((await runGit(ctx, record.path, ["add", "--", ...files.map((file) => file.path)])).status !== 0) return hold("write_failed")
  const staged = await runGit(ctx, record.path, ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames"])
  if (staged.status !== 0 || !exactDiff(parseRaw(staged.stdout), files)) return hold("policy_refused")
  const before = await hookPolicy(ctx, record.path)
  if (before === null) return hold("policy_unknown")
  if (before === "disabled") return hold("policy_refused")
  await ctx.step("before_commit")
  const commit = await runGit(ctx, record.path, ["commit", "-q", "-m", COMMIT_MESSAGE], { ...ctx.childEnv, [TOOL_COMMIT_ENV]: "1" })
  if (commit.timedOut) return hold("policy_unknown")
  if (commit.status !== 0) return hold("policy_refused")
  if ((await hookPolicy(ctx, record.path)) !== before) return hold("policy_unknown")
  const head = text(await runGit(ctx, record.path, ["rev-parse", "HEAD"]))
  const parent = text(await runGit(ctx, record.path, ["rev-parse", "HEAD^"]))
  const tree = await runGit(ctx, record.path, ["diff-tree", "-r", "--raw", "-z", "--no-abbrev", "--no-renames", base, "HEAD"])
  const clean = await runGit(ctx, record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"])
  if (parent !== base || tree.status !== 0 || !exactDiff(parseRaw(tree.stdout), files) || clean.status !== 0 || clean.stdout.length > 0) return hold("policy_unknown")
  return { commit: head, record, resource }
}

// ---------------------------------------------------------------------------
// One round: fetch, check, adopt or write, push, read back.

async function blobAt(ctx, commit, relative) {
  const found = await runGit(ctx, ctx.deskRoot, ["rev-parse", "-q", "--verify", `${commit}:${relative}`])
  return found.status === 0 ? text(found) : null
}

async function bytesAt(ctx, commit, relative) {
  const found = await runGit(ctx, ctx.deskRoot, ["cat-file", "blob", `${commit}:${relative}`])
  return found.status === 0 ? found.stdout : null
}

async function fetchMain(ctx) {
  if ((await runGit(ctx, ctx.deskRoot, ["fetch", "-q", "origin", "main"])).status !== 0) return null
  const main = await runGit(ctx, ctx.deskRoot, ["rev-parse", "refs/remotes/origin/main"])
  return main.status === 0 ? text(main) : null
}

async function basisHolds(ctx, main, input, now) {
  const { expectedBasis: basis } = input
  if ((await blobAt(ctx, main, input.paths.card)) !== basis.canonical_revision) return false
  // A withdrawal rests only on the card's absence; rulings matter to a recommendation, not to removal.
  if (basis.canonical_revision === null) return true
  for (const ruling of basis.rulings) if ((await blobAt(ctx, main, ruling.id)) !== ruling.revision) return false
  for (const id of defaultRulingPaths(input.personPrefix)) {
    if (!basis.rulings.some((ruling) => ruling.id === id) && (await blobAt(ctx, main, id)) !== null) return false
  }
  if (basis.claim.state === "live" && !(Date.parse(basis.claim.expires_at) > now.getTime())) return false
  // Every evidence revision, resolved live now, not taken from the basis: a public issue edited since the review changes it. The
  // resolver gets the card as published, so the local card must be the expected blob, as `readTriageBasis` read it.
  const read = await readCanonicalCard({ deskRoot: ctx.deskRoot, personPrefix: input.personPrefix, key: input.key, env: ctx.env, gitExecutable: ctx.executable })
  if (read === null || read.revision !== basis.canonical_revision) return false
  for (const item of basis.evidence) {
    const found = await Promise.resolve().then(() => input.resolve(item.pointer, read.card)).catch(() => null)
    if (found?.revision !== item.revision) return false
  }
  return true
}

// An adopted review was written by another host, so this host has no protected basis under its token. The equivalent expected
// basis is kept under that token, so the mechanical refresh here can recheck the review instead of reporting it unavailable.
async function keepProtectedBasis(ctx, token, basis, resources) {
  if ((await readProtectedBasis(ctx.env, token)) !== null) return
  const file = await writeProtectedTriageFile(ctx.env, ["basis", `${token}.json`], `${JSON.stringify(protectedBasisRecord(token, basis))}\n`, ctx.protectOptions)
  resources.push({ kind: "protected_basis", path: file, ref: null, owner: process.pid, disposition: "retained" })
}

async function round(ctx, input, resources) {
  const { paths, key, store, operation, now } = input
  const hold = (state, extra = {}) => ({ result: { state, ...extra, resources } })
  const main = await fetchMain(ctx)
  if (main === null) return hold("unsynchronized")
  const relevant = [...new Set([paths.card, paths.registry, paths.annotation, ...input.expectedBasis.rulings.map((ruling) => ruling.id), ...defaultRulingPaths(input.personPrefix)])]
  const dirty = await runGit(ctx, ctx.deskRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...relevant])
  const localOnly = await runGit(ctx, ctx.deskRoot, ["rev-list", "-n", "1", "refs/remotes/origin/main..HEAD", "--", ...relevant])
  if (dirty.status !== 0 || dirty.stdout.length > 0 || localOnly.status !== 0 || localOnly.stdout.length > 0) return hold("unsynchronized")
  if (!(await basisHolds(ctx, main, input, now))) return hold("stale_basis")
  await ctx.step("remote_read")

  const registryBytes = await bytesAt(ctx, main, paths.registry)
  const annotationBytes = await bytesAt(ctx, main, paths.annotation)
  const registry = registryBytes === null ? { schema: IDENTITIES_SCHEMA, entries: [] } : validateTriageIdentities(registryBytes).value
  const annotation = annotationBytes === null ? null : validateTriageAnnotation(annotationBytes).value
  if (registry === undefined || annotation === undefined || (annotation !== null && annotation.key !== key)) return hold("identity_conflict")
  const entry = registry.entries.find((candidate) => candidate.key === key && candidate.store === store)
  if (entry !== undefined && (annotation === null || entry.revision > annotation.revision)) return hold("identity_conflict")
  if (operation !== "review" && (annotation === null || annotation.attempt.state === "withdrawn" && operation === "invalidate")) return hold("policy_refused")

  const { state } = OPERATIONS[operation]
  const reason = input.reason ?? OPERATIONS[operation].reason
  const target = {
    schema: ANNOTATION_SCHEMA,
    key,
    revision: 0,
    basis: {
      generation: hex(16),
      canonical_revision: input.expectedBasis.canonical_revision,
      public_evidence_revisions: operation === "withdraw" ? [] : input.expectedBasis.public_evidence_revisions,
      protected_basis: hex(16),
    },
    review: operation === "review" ? input.review : operation === "invalidate" ? annotation.review : null,
    attempt: { state, at: now.toISOString(), reason },
  }
  const ack = async (commit) => ({
    remote: "origin", ref: "refs/heads/main", commit,
    registry_blob: await blobAt(ctx, commit, paths.registry), annotation_blob: await blobAt(ctx, commit, paths.annotation),
  })
  if (entry !== undefined && entry.revision === annotation.revision && sameContent(annotation, target)) {
    await keepProtectedBasis(ctx, annotation.basis.protected_basis, input.expectedBasis, resources)
    return { result: { state: "adopted", id: entry.id, revision: entry.revision, ack: await ack(main), resources } }
  }
  const high = Math.max(annotation?.revision ?? 0, ...registry.entries.filter((candidate) => candidate.key === key).map((candidate) => candidate.revision))
  if (high >= Number.MAX_SAFE_INTEGER) return hold("write_failed")
  target.revision = high + 1
  const id = entry?.id ?? hex(16)
  const annotationOut = Buffer.from(`${JSON.stringify(target)}\n`)
  const entries = [...registry.entries.filter((candidate) => candidate !== entry), { key, store, id, revision: target.revision, public_basis: entry?.public_basis ?? null }].sort(compareIdentities)
  const registryOut = Buffer.from(`${JSON.stringify({ schema: IDENTITIES_SCHEMA, entries })}\n`)
  if (!validateTriageAnnotation(annotationOut).ok || !validateTriageIdentities(registryOut).ok) return hold("policy_refused")

  const basisFile = await writeProtectedTriageFile(ctx.env, ["basis", `${target.basis.protected_basis}.json`], `${JSON.stringify(protectedBasisRecord(target.basis.protected_basis, input.expectedBasis))}\n`, ctx.protectOptions)
  resources.push({ kind: "protected_basis", path: basisFile, ref: null, owner: process.pid, disposition: "retained" })
  const files = [{ path: paths.registry, bytes: registryOut }, { path: paths.annotation, bytes: annotationOut }]
  const built = await candidate(ctx, main, files, resources)
  if (built.hold !== undefined) return hold(built.hold)
  ctx.phase = "pushing"
  const push = await runGit(ctx, ctx.deskRoot, ["push", "-q", "origin", `${built.commit}:refs/heads/main`])
  if (push.status !== 0) {
    await release(ctx, built.record, built.resource)
    // A rejected push (another writer moved main, or held its lock) is retried once from a fresh fetch; a push whose outcome is
    // unknown (timed out) is never assumed to have failed.
    return push.timedOut ? hold("unacknowledged") : { retry: true }
  }
  ctx.phase = "pushed"
  await ctx.step("pushed")
  const after = await fetchMain(ctx)
  const acknowledged = after !== null && (await blobAt(ctx, after, paths.registry)) === gitBlobSha(registryOut) &&
    (await blobAt(ctx, after, paths.annotation)) === gitBlobSha(annotationOut) && (await basisHolds(ctx, after, input, now))
  await release(ctx, built.record, built.resource)
  if (!acknowledged) return hold("unacknowledged")
  return { result: { state: "acknowledged", id, revision: target.revision, ack: await ack(after), resources } }
}

/**
 * `publishOwnedTriage({env,deskRoot,personPrefix,key,store,expectedBasis,review,operation,now,git,evidence,reason}) -> {state,id?,revision?,ack?,resources,alarm?}`.
 *
 * `operation` is `review` (with a `validateSafeTriageReview`-valid `review`, never a candidate), `invalidate` (keep the last valid
 * review as stale context) or `withdraw` (the card is gone on a complete read; `expectedBasis.canonical_revision` is null).
 * `expectedBasis` is `readTriageBasis().basis` from the prepared local read. A review's `authority_code` must be one of
 * `expectedBasis.authority.codes`, and that authority must follow from the basis's own rulings; otherwise `policy_refused`, so an
 * agent-ready review is never written on a basis whose authority is unresolved or was revoked. `store` is `owner/repo`,
 * case-normalized. `evidence.resolve(pointer, card) -> {revision}|null` is the live evidence resolver (as in `readTriageBasis`,
 * given the card whose bytes are the expected blob; without it only self-describing pointers resolve): every evidence revision of
 * the basis is resolved again before the push and after the readback, and any difference, or a local card that is not the
 * expected one, is `stale_basis`. `reason` is the invalidation's reason from `refreshTriage` (one of
 * `basis_changed`, `claim_changed`, `authority_changed`, `evidence_changed`, `version_changed`; default `basis_changed`) and is
 * refused for the other operations. `git` holds test and platform seams: `{spawn, timeoutMs, onStep(name), platform, aclRunner}`.
 *
 * States: `acknowledged` (written and read back), `adopted` (the remote already holds this identity and review),
 * `stale_basis`, `identity_conflict` (damaged registry or annotation, or registry and annotation disagree),
 * `unacknowledged` (pushed or maybe pushed but not read back), `not_git`, `unsynchronized` (no `origin/main` upstream, a merge
 * in progress, dirty or local-only relevant paths, or no fetch), `unsafe_path`, `busy` (the sync lock, or an unrecovered earlier
 * resource), `policy_refused` (a refused commit hook, an unsafe environment, disabled hooks, an invalid input, authority the
 * basis does not grant, or nothing to invalidate or withdraw), `policy_unknown` (a hook time-out, a changed hook policy or an
 * extra committed path) and `write_failed` (including a revision high-water mark that cannot advance). `id`, `revision` and `ack`
 * appear only when acknowledged or adopted. `resources` lists every temporary path and ref with its owner and disposition. A
 * worktree holding files a hook left is kept, never deleted; it and any other resource that cannot be recovered (a foreign record,
 * or a removal that fails) make every later call `busy` with `alarm: "triage_resource_unrecoverable"`, the stable code a loop
 * raises, until it is cleared.
 */
export async function publishOwnedTriage({ env, deskRoot, personPrefix, key, store, expectedBasis, review, operation, now, git = {}, evidence = {}, reason }) {
  const resources = []
  const hold = (state) => ({ state, resources })
  if (!Object.hasOwn(OPERATIONS, operation)) return hold("policy_refused")
  const paths = typeof deskRoot === "string" && path.isAbsolute(deskRoot) ? triagePaths(deskRoot, personPrefix, key) : null
  if (paths === null || typeof store !== "string" || !PATTERNS.prRepo.test(store)) return hold("unsafe_path")
  const at = new Date(now)
  const reviewOk = operation === "review" ? validateSafeTriageReview(review).ok : review === null || review === undefined
  const expectMissing = operation === "withdraw"
  const reasonOk = reason === undefined || (operation === "invalidate" && INVALIDATE_REASONS.includes(reason))
  if (!reviewOk || !reasonOk || Number.isNaN(at.getTime()) || !basisShape(expectedBasis, key, paths.card) || expectMissing !== (expectedBasis.canonical_revision === null) || unsafeEnvironment(env)) {
    return hold("policy_refused")
  }
  if (operation === "review" && !expectedBasis.authority.codes.includes(review.authority_code)) return hold("policy_refused")
  const ctx = {
    env: { ...env },
    deskRoot,
    spawn: git.spawn ?? spawnDefault,
    timeoutMs: git.timeoutMs ?? GIT_TIMEOUT_MS,
    platform: git.platform ?? process.platform,
    step: async (name) => git.onStep?.(name),
    childEnv: { ...env, GIT_TERMINAL_PROMPT: "0" },
    phase: "preparing",
  }
  ctx.protectOptions = { deskRoot, platform: ctx.platform, runner: git.aclRunner }
  if (Object.hasOwn(env, "GIT_CONFIG_COUNT") && !(await supportedProfileGit(ctx))) return hold("policy_refused")
  const top = await runGit(ctx, deskRoot, ["rev-parse", "--show-toplevel"])
  // Native resolution, as the card guard does, so a Windows short (8.3) spelling of the same folder still matches.
  if (top.status !== 0 || realpathSync.native(text(top)) !== realpathSync.native(deskRoot)) return hold("not_git")
  const upstream = await runGit(ctx, deskRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  if (upstream.status !== 0 || text(upstream) !== "origin/main") return hold("unsynchronized")
  for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]) {
    if ((await runGit(ctx, deskRoot, ["rev-parse", "-q", "--verify", state])).status === 0) return hold("unsynchronized")
  }
  const lock = await acquireSyncLock({ root: deskRoot, env })
  if (lock === null || lock.refused) return hold("busy")
  try {
    ctx.stateRoot = await factoryStateRoot(env, { deskRoot, platform: ctx.platform, runner: git.aclRunner })
    if (!(await recover(ctx, resources))) return { state: "busy", alarm: RESOURCE_ALARM, resources }
    const input = {
      paths, key, store: store.toLowerCase(), personPrefix, operation, review: operation === "review" ? review : null, expectedBasis, now: at,
      reason, resolve: evidence.resolve ?? resolveSelfDescribing,
    }
    const first = await round(ctx, input, resources)
    if (first.result !== undefined) return first.result
    const second = await round(ctx, input, resources)
    return second.result ?? hold("unacknowledged")
  } catch {
    // A crash mid-way: whatever may have reached the remote is not acknowledged here. Resources stay for the next call to recover.
    return hold(ctx.phase === "preparing" ? "write_failed" : "unacknowledged")
  } finally {
    lock.release()
  }
}
