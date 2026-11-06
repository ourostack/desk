import { constants, promises as fs } from "node:fs"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import * as path from "node:path"
import { openContributionRootReadOnly, readContributionFiles } from "./contribution-storage.js"
import { validMarker } from "./marker.js"
import { validateLocalFacts, ENUMS, PATTERNS, isPlainObject } from "./schema.js"
import { stableStringify } from "./pipeline/normalize.js"

const authorities = new WeakMap()
const HEX = /^[0-9a-f]{64}$/u
const NONCE = /^[0-9a-f]{16}$/u
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const mac = (key, value) => createHmac("sha256", key).update(stableStringify(value)).digest("hex")
const refusal = result => ({ result })
const exact = (value, names) => isPlainObject(value) && Object.keys(value).sort().join() === [...names].sort().join()
const parse = bytes => {
  if (bytes === null) return null
  try { return JSON.parse(bytes.toString("utf8")) } catch (error) { if (error instanceof SyntaxError) return null; throw error }
}
function requestValid(value) {
  return exact(value, ["store", "host", "session", "deskRoot", "personPrefix"]) && typeof value.store === "string" &&
    PATTERNS.prRepo.test(value.store) && ENUMS.host.includes(value.host) && SESSION.test(value.session) &&
    typeof value.deskRoot === "string" && path.isAbsolute(value.deskRoot) &&
    typeof value.personPrefix === "string" && /^(?:|desks\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/u.test(value.personPrefix)
}

/** Fingerprint actual loaded-source bytes; this is not a store or platform qualification grant. */
export async function contributionPublisherFingerprint() {
  const hash = createHash("sha256")
  for (const name of ["contribution-authority.js", "contribution-storage.js", "contribution-index.js", "flush-lock.js",
    "contribution-policy.js", "contribution-schema.js", "outbox.js", "flush.js", "../../scripts/factory.js"]) {
    const handle = await fs.open(new URL(name, import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > 1024 * 1024) throw new Error("contribution_source_unqualified")
      const bytes = Buffer.alloc(before.size + 1)
      let count = 0
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count)
        if (bytesRead === 0) break
        count += bytesRead
      }
      const after = await handle.stat()
      const current = await fs.lstat(new URL(name, import.meta.url))
      if (count !== before.size || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !current.isFile() ||
          current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino ||
          current.mode !== before.mode || current.uid !== before.uid || current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new Error("contribution_source_unqualified")
      hash.update(name).update("\0").update(bytes.subarray(0, count))
    } finally { await handle.close() }
  }
  return hash.digest("hex")
}

/** Only authority produced by actual protected source reads is admitted by index writers. */
export function checkedContributionAuthority(value) {
  const checked = authorities.get(value)
  return checked === undefined ? null : { ...checked, env: { ...checked.env }, request: structuredClone(checked.request),
    key: Buffer.from(checked.key), local: structuredClone(checked.local) }
}

export async function readContributionAuthority(env, request, { platform = process.platform } = {}) {
  if (!requestValid(request)) return refusal("invalid_request")
  request = structuredClone(request)
  const initial = await openContributionRootReadOnly(env, {
    platform, store: request.store, intake: "0".repeat(16), ownerScope: "0".repeat(64), deskRoot: request.deskRoot,
  })
  if (initial.state !== "ready") return refusal(initial.code === "platform_unqualified" ? initial.code : "ownership_unknown")
  const first = await readContributionFiles(initial.root, [{ role: "secret" }, { role: "consent" }])
  if (first.state !== "ready" || first.files.secret === null || first.files.secret.length !== 32) return refusal("ownership_unknown")
  const consent = parse(first.files.consent)
  const store = request.store.toLowerCase()
  const decision = consent?.stores?.[store]
  if (!isPlainObject(consent) || consent.schema_version !== 1 || !isPlainObject(decision) ||
      !NONCE.test(decision.intake_id)) return refusal("ownership_unknown")
  if (decision.contribute !== true) return refusal("not_opted_in")
  const key = first.files.secret
  const owner = { deskRoot: request.deskRoot, personPrefix: request.personPrefix, machine: mac(key, { kind: "machine" }) }
  const ownerScope = mac(key, { owner, store })
  const opened = await openContributionRootReadOnly(env, {
    platform, store, intake: decision.intake_id, ownerScope, deskRoot: request.deskRoot,
  })
  if (opened.state !== "ready") return refusal("ownership_unknown")
  const read = await readContributionFiles(opened.root, [
    { role: "secret" }, { role: "consent" }, { role: "status" }, { role: "qualification" },
    { role: "marker", host: request.host, session: request.session },
    { role: "facts", host: request.host, session: request.session },
  ])
  if (read.state !== "ready" || read.files.secret === null ||
      !read.files.secret.equals(key) || read.files.consent === null ||
      !read.files.consent.equals(first.files.consent)) return refusal("ownership_unknown")
  const marker = parse(read.files.marker)
  const facts = parse(read.files.facts)
  const status = parse(read.files.status)
  const name = `${request.host}-${request.session}.json`
  const receipt = status?.derivations?.[name]
  if (!validMarker(marker) || !validateLocalFacts(facts).ok || !isPlainObject(receipt) ||
      marker.host !== request.host || marker.session_id !== request.session || marker.desk_root !== request.deskRoot ||
      !Object.hasOwn(marker, "person_prefix") || marker.person_prefix !== request.personPrefix || receipt.desk_root !== request.deskRoot ||
      receipt.store?.toLowerCase() !== store || receipt.checked_route?.toLowerCase() !== store ||
      facts.session.id !== request.session || facts.session.host !== request.host) return refusal("ownership_unknown")
  const { updated_at: _time, ...content } = marker
  if (receipt.marker !== sha(JSON.stringify(content))) return refusal("ownership_unknown")
  const witness = parse(read.files.qualification)
  if (!isPlainObject(witness)) return refusal("compatibility_unqualified")
  const { seal, ...qualification } = witness
  const machineWitness = exact(qualification, ["schema", "store", "intake", "protocol", "publisher", "storeWitness"])
  const ownerWitness = exact(qualification, ["schema", "store", "intake", "deskRoot", "personPrefix", "protocol", "publisher", "storeWitness"]) &&
    qualification.deskRoot === request.deskRoot && qualification.personPrefix === request.personPrefix
  let publisher
  try { publisher = await contributionPublisherFingerprint() }
  catch (error) {
    if (error.message === "contribution_source_unqualified" || ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code))
      return refusal("compatibility_unqualified")
    throw error
  }
  if ((!machineWitness && !ownerWitness) ||
      qualification.schema !== "desk.factory.contribution-qualification/1" || qualification.protocol !== 1 ||
      qualification.store !== store || qualification.intake !== decision.intake_id ||
      !HEX.test(qualification.publisher) || !HEX.test(qualification.storeWitness) || typeof seal !== "string" || !HEX.test(seal) ||
      !timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(mac(key, qualification), "hex")) ||
      qualification.publisher !== publisher) return refusal("compatibility_unqualified")
  const target = { store, host: request.host, session: request.session }
  const local = { owner, target, evidence: { ownerScope, kind: "source",
    digest: sha(stableStringify({ marker, receipt, facts })) },
    consent: { store, contribute: true },
    compatibility: { protocol: 1, publisher: qualification.publisher, storeWitness: qualification.storeWitness } }
  const authority = Object.freeze({ local: structuredClone(local) })
  authorities.set(authority, { env: { HOME: env.HOME, XDG_STATE_HOME: env.XDG_STATE_HOME }, request, root: opened.root, key: Buffer.from(key), ownerScope, store,
    intake: decision.intake_id, local, platform })
  return { result: "qualified", authority }
}

/** A closed private request is input only, never authority. Unsupported protection refuses before reading. */
export async function readContributionRequest(file, { platform = process.platform } = {}) {
  if (platform !== "linux") return refusal("platform_unqualified")
  if (typeof file !== "string" || !path.isAbsolute(file)) return refusal("invalid_request")
  let handle
  try {
    let cursor = path.parse(file).root
    const parents = []
    for (const segment of path.relative(cursor, path.dirname(file)).split(path.sep)) {
      cursor = path.join(cursor, segment)
      const stat = await fs.lstat(cursor, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink()) return refusal("invalid_request")
      parents.push({ file: cursor, stat })
    }
    const parent = parents.at(-1)?.stat
    if (!parent || (parent.mode & 0o077n) !== 0n || typeof process.getuid === "function" && parent.uid !== BigInt(process.getuid()))
      return refusal("invalid_request")
    const before = await fs.lstat(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16384n ||
        (before.mode & 0o077n) !== 0n || typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
      return refusal("invalid_request")
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const identical = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
      a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
    if (!identical(before, await handle.stat({ bigint: true }))) return refusal("invalid_request")
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count)
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - count) return refusal("invalid_request")
      if (bytesRead === 0) break
      count += bytesRead
    }
    if (count !== Number(before.size) || !identical(before, await handle.stat({ bigint: true })) ||
        !identical(before, await fs.lstat(file, { bigint: true }))) return refusal("invalid_request")
    for (const entry of parents) {
      const now = await fs.lstat(entry.file, { bigint: true })
      if (!now.isDirectory() || entry.stat.dev !== now.dev || entry.stat.ino !== now.ino ||
          entry.stat.uid !== now.uid || entry.stat.mode !== now.mode) return refusal("invalid_request")
    }
    const request = parse(buffer.subarray(0, count))
    return requestValid(request) ? { result: "request_read", request } : refusal("invalid_request")
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) return refusal("invalid_request")
    throw error
  } finally { if (handle) await handle.close() }
}
