import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { checkedContributionAuthority, readContributionAuthority } from "./contribution-authority.js"
import { readContributionFiles, writeContributionImage, withContributionTransactionLock } from "./contribution-storage.js"
import { contributionAllowed } from "./contribution-policy.js"
import { stableStringify } from "./pipeline/normalize.js"
import { isPlainObject } from "./schema.js"

const HEX = /^[0-9a-f]{64}$/u
const INDEX = "desk.factory.contribution-index/1"
const TRANSACTION = "desk.factory.contribution-transaction/1"
const RECEIPT = "desk.factory.contribution-receipt/1"
const integer = value => Number.isSafeInteger(value) && value >= 0
const exact = (value, keys) => isPlainObject(value) && Object.keys(value).sort().join() === [...keys].sort().join()
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`)
const sha = value => createHash("sha256").update(value).digest("hex")
const digest = value => value === null ? null : sha(value)
const mac = (key, value) => createHmac("sha256", key).update(stableStringify(value)).digest("hex")
const sealed = (key, value) => ({ ...value, seal: mac(key, value) })
const failure = code => { throw Object.assign(new Error(code), { contributionCode: code }) }
const unavailable = () => ({ state: "unavailable", code: "policy_unavailable" })
function open(raw, key) {
  if (raw === null) return null
  let parsed
  try { parsed = JSON.parse(raw.toString("utf8")) } catch (error) { if (error instanceof SyntaxError) return null; throw error }
  if (!isPlainObject(parsed)) return null
  const { seal, ...value } = parsed
  if (typeof seal !== "string" || !HEX.test(seal) ||
      !timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(mac(key, value), "hex"))) return null
  return value
}
function validIndex(index, authority) {
  return exact(index, ["schema", "store", "intake", "mode", "generation", "revision", "owners", "transaction"]) &&
    index.schema === INDEX && index.store === authority.store && index.intake === authority.intake &&
    ["never_activated", "active", "pending"].includes(index.mode) && integer(index.generation) && integer(index.revision) &&
    (index.transaction === null || typeof index.transaction === "string" && HEX.test(index.transaction)) &&
    isPlainObject(index.owners) && Object.keys(index.owners).length <= 256 &&
    Object.entries(index.owners).every(([id, entry]) => HEX.test(id) && exact(entry, ["generation", "ledger", "activation"]) &&
      integer(entry.generation) && HEX.test(entry.ledger) && HEX.test(entry.activation)) &&
    (index.mode !== "never_activated" || index.generation === 0 && Object.keys(index.owners).length === 0 && index.transaction === null) &&
    (index.mode !== "pending" || index.transaction !== null)
}
async function snapshot(authority) {
  const read = await readContributionFiles(authority.root, [{ role: "index" }, { role: "transaction" }, { role: "ledger" }, { role: "activation" }])
  if (read.state !== "ready") failure(read.code)
  return { raw: read.files, index: open(read.files.index, authority.key), transaction: open(read.files.transaction, authority.key) }
}
function validReceipt(value, authority) {
  return exact(value, ["schema", "id", "store", "intake", "ownerScope", "generation", "revision", "ledger", "activation", "index"]) &&
    value.schema === RECEIPT && value.store === authority.store && value.intake === authority.intake &&
    typeof value.ownerScope === "string" && HEX.test(value.ownerScope) &&
    [value.id, value.ledger, value.activation, value.index].every(item => typeof item === "string" && HEX.test(item)) &&
    integer(value.generation) && integer(value.revision)
}
function receiptMatchesIndex(current, authority) {
  const receipt = current.transaction
  if (receipt === null) return current.raw.transaction === null && current.index.revision === 0
  return validReceipt(receipt, authority) && receipt.index === digest(current.raw.index) &&
    receipt.generation === current.index.generation && receipt.revision === current.index.revision &&
    current.index.owners[receipt.ownerScope]?.ledger === receipt.ledger &&
    current.index.owners[receipt.ownerScope]?.activation === receipt.activation
}
function validTransaction(value, authority) {
  return exact(value, ["schema", "id", "store", "intake", "ownerScope", "localDigest", "intentId", "before", "after"]) &&
    value.schema === TRANSACTION && value.store === authority.store && value.intake === authority.intake &&
    value.ownerScope === authority.ownerScope && [value.id, value.localDigest, value.intentId].every(item => typeof item === "string" && HEX.test(item)) &&
    exact(value.before, ["index", "ledger", "activation", "transaction"]) &&
    Object.values(value.before).every(item => item === null || typeof item === "string" && HEX.test(item)) &&
    exact(value.after, ["index", "pending", "ledger", "activation"]) &&
    Object.values(value.after).every(item => typeof item === "string" && Buffer.byteLength(item) <= 1024 * 1024) &&
    validIndex(open(Buffer.from(value.after.index), authority.key), authority) &&
    validIndex(open(Buffer.from(value.after.pending), authority.key), authority)
}
async function currentAuthority(original) {
  const result = await readContributionAuthority(original.env, original.request, { platform: original.platform })
  const current = checkedContributionAuthority(result.authority)
  if (current === null || current.ownerScope !== original.ownerScope || !current.key.equals(original.key) ||
      mac(current.key, current.local) !== mac(original.key, original.local)) failure("plan_changed")
  return current
}

/** Classifies only: no locks, repairs, secret creation or interrupted-transaction writes. */
export async function readContributionIndex(value) {
  const authority = checkedContributionAuthority(value)
  if (authority === null) return unavailable()
  try { await currentAuthority(authority); return await readIndex(authority) }
  catch (error) {
    if (error.contributionCode) return { state: "unavailable", code: error.contributionCode }
    throw error
  }
}

async function readIndex(authority) {
  const current = await snapshot(authority)
  if (current === null || !validIndex(current.index, authority)) return unavailable()
  if (current.raw.transaction !== null && current.transaction === null) return unavailable()
  if (current.transaction?.schema === TRANSACTION)
    return validTransaction(current.transaction, authority) ? { state: "transaction_pending", code: "transaction_pending" } : unavailable()
  if (current.index.mode === "pending" || !receiptMatchesIndex(current, authority)) return unavailable()
  const entry = current.index.owners[authority.ownerScope]
  if (entry !== undefined && (digest(current.raw.ledger) !== entry.ledger || digest(current.raw.activation) !== entry.activation)) return unavailable()
  if (entry === undefined && (current.raw.ledger !== null || current.raw.activation !== null)) return unavailable()
  return { state: "ready", index: structuredClone(current.index) }
}

async function finish(authority, staged) {
  if (!validTransaction(staged, authority) || staged.localDigest !== mac(authority.key, authority.local)) failure("transaction_conflict")
  const current = await snapshot(authority)
  if (current === null) failure("transaction_conflict")
  const after = Object.fromEntries(Object.entries(staged.after).map(([role, text]) => [role, Buffer.from(text)]))
  for (const role of ["ledger", "activation"]) {
    const hash = digest(current.raw[role])
    if (hash !== staged.before[role] && hash !== digest(after[role])) failure("transaction_conflict")
  }
  const indexHash = digest(current.raw.index)
  if (![staged.before.index, digest(after.pending), digest(after.index)].includes(indexHash)) failure("transaction_conflict")
  const admit = () => currentAuthority(authority)
  const replace = async (role, data, selector = { role }) => {
    const observed = await readContributionFiles(authority.root, [selector])
    if (observed.state !== "ready") failure("transaction_conflict")
    if (observed.files[role]?.equals(data)) return
    const hash = digest(observed.files[role])
    const allowed = role === "index" ? [staged.before.index, digest(after.pending), digest(after.index)] :
      ["ledger", "activation"].includes(role) ? [staged.before[role], digest(after[role])] :
      role === "receipt" ? [null, digest(data)] : [digest(bytes(sealed(authority.key, staged))), digest(data)]
    if (!allowed.includes(hash)) failure("transaction_conflict")
    await writeContributionImage(authority.root, selector, data, { expected: digest(observed.files[role]), admit })
  }
  if (indexHash !== digest(after.index)) {
    await replace("index", after.pending)
    await replace("activation", after.activation)
    await replace("ledger", after.ledger)
    await replace("index", after.index)
  }
  const final = open(after.index, authority.key)
  const receipt = sealed(authority.key, { schema: RECEIPT, id: staged.id, store: authority.store, intake: authority.intake,
    ownerScope: authority.ownerScope, generation: final.generation, revision: final.revision,
    ledger: digest(after.ledger), activation: digest(after.activation), index: digest(after.index) })
  const receiptBytes = bytes(receipt)
  await replace("receipt", receiptBytes, { role: "receipt", id: staged.id })
  await replace("transaction", receiptBytes)
  return { result: "committed", transactionId: staged.id, generation: final.generation, revision: final.revision }
}
const handled = error => error.contributionCode ? { result: error.contributionCode } :
  ["EIO", "ENOSPC", "EROFS", "EACCES", "EPERM"].includes(error.code) ? { result: "storage_failed" } : null

export async function reconcileContributionTransaction(value) {
  const authority = checkedContributionAuthority(value)
  if (authority === null) return { result: "ownership_unknown" }
  try {
    return await withContributionTransactionLock(authority.root, authority.local.target, async () => {
      const current = await snapshot(authority)
      if (current?.transaction?.schema === RECEIPT && validIndex(current.index, authority) &&
          receiptMatchesIndex(current, authority) && (await readIndex(authority)).state === "ready")
        return { result: "already_committed", generation: current.transaction.generation, revision: current.transaction.revision }
      if (current?.transaction?.schema !== TRANSACTION) return { result: "transaction_conflict" }
      return finish(authority, current.transaction)
    }, { admit: () => currentAuthority(authority) })
  } catch (error) { const result = handled(error); if (result) return result; throw error }
}

/** Internal checked-authority transaction only; not a public DATA permission or remote-effect grant. */
export async function commitContributionImages(value, input) {
  const authority = checkedContributionAuthority(value)
  if (authority === null) return { result: "ownership_unknown" }
  if (!exact(input, ["ledger", "activation", "intentId"]) || !HEX.test(input.intentId)) return { result: "invalid_images" }
  input = structuredClone(input)
  const ledgerBytes = bytes(input.ledger), activationBytes = bytes(input.activation)
  if (ledgerBytes.length > 1024 * 1024 || activationBytes.length > 1024 * 1024) return { result: "policy_limit" }
  const ledger = open(ledgerBytes, authority.key), activation = open(activationBytes, authority.key)
  if (ledger === null || activation === null || ledger.ownerScope !== authority.ownerScope || ledger.store !== authority.store ||
      contributionAllowed({ state: "ready", ...ledger }, authority.local.target).code === "policy_unavailable" ||
      !exact(activation, ["schema", "ownerScope", "store", "generation"]) ||
      activation.schema !== ledger.schema || activation.ownerScope !== ledger.ownerScope ||
      activation.store !== ledger.store || activation.generation !== ledger.generation ||
      ledger.exclusions[input.intentId]?.target.session !== authority.local.target.session ||
      ledger.exclusions[input.intentId]?.target.host !== authority.local.target.host) return { result: "invalid_images" }
  try {
    return await withContributionTransactionLock(authority.root, authority.local.target, async () => {
      let current = await snapshot(authority)
      if (current?.transaction?.schema === TRANSACTION) {
        const finished = await finish(authority, current.transaction)
        if (finished.result !== "committed") return finished
        current = await snapshot(authority)
      }
      if (current === null || !validIndex(current.index, authority) || current.index.mode === "pending" ||
          !receiptMatchesIndex(current, authority)) return { result: "policy_unavailable" }
      const entry = current.index.owners[authority.ownerScope]
      if (entry?.ledger === digest(ledgerBytes) && entry?.activation === digest(activationBytes))
        return { result: "already_committed", generation: current.index.generation, revision: current.index.revision }
      if (entry === undefined ? current.raw.ledger !== null || current.raw.activation !== null :
        digest(current.raw.ledger) !== entry.ledger || digest(current.raw.activation) !== entry.activation)
        return { result: "transaction_conflict" }
      const oldGeneration = entry?.generation ?? 0
      const beforeLedger = open(current.raw.ledger, authority.key)
      if (beforeLedger !== null && Object.entries(beforeLedger.exclusions).some(([id, old]) =>
        id !== input.intentId ? stableStringify(ledger.exclusions[id]) !== stableStringify(old) :
          ledger.exclusions[id] === undefined || ledger.exclusions[id].target.host !== old.target.host ||
          ledger.exclusions[id].target.session !== old.target.session ||
          ledger.exclusions[id].localDigest !== old.localDigest ||
          ledger.exclusions[id].observedRemoteDigest !== old.observedRemoteDigest ||
          ledger.exclusions[id].tokenHash !== old.tokenHash ||
          ledger.exclusions[id].generation !== old.generation ||
          ledger.exclusions[id].revision !== old.revision + 1 ||
          ledger.exclusions[id].effects.length !== old.effects.length + 1 ||
          stableStringify(ledger.exclusions[id].effects.slice(0, -1)) !== stableStringify(old.effects)))
        return { result: "invalid_images" }
      const previousIntents = beforeLedger?.exclusions ?? {}
      const added = Object.keys(ledger.exclusions).filter(id => !Object.hasOwn(previousIntents, id))
      const newIntent = !Object.hasOwn(previousIntents, input.intentId)
      if (newIntent ? added.length !== 1 || added[0] !== input.intentId ||
          ledger.generation !== oldGeneration + 1 || ledger.exclusions[input.intentId].generation !== ledger.generation ||
          ledger.exclusions[input.intentId].revision !== 0 || ledger.exclusions[input.intentId].effects.length !== 0 :
        added.length !== 0 || ledger.generation !== oldGeneration) return { result: "invalid_images" }
      if (ledger.generation === 0 ||
          current.index.revision === Number.MAX_SAFE_INTEGER ||
          newIntent && (oldGeneration === Number.MAX_SAFE_INTEGER ||
            current.index.generation === Number.MAX_SAFE_INTEGER)) return { result: "policy_limit" }
      const id = mac(authority.key, { ownerScope: authority.ownerScope, intentId: input.intentId,
        before: digest(current.raw.index), ledger: digest(ledgerBytes), activation: digest(activationBytes) })
      const final = { ...current.index, mode: "active", generation: current.index.generation + Number(newIntent),
        revision: current.index.revision + 1, transaction: null,
        owners: { ...current.index.owners, [authority.ownerScope]: {
          generation: ledger.generation, ledger: digest(ledgerBytes), activation: digest(activationBytes),
        } } }
      const pending = { ...current.index, mode: "pending", transaction: id }
      const transaction = sealed(authority.key, { schema: TRANSACTION, id, store: authority.store, intake: authority.intake,
        ownerScope: authority.ownerScope, localDigest: mac(authority.key, authority.local), intentId: input.intentId,
        before: Object.fromEntries(["index", "ledger", "activation", "transaction"].map(role => [role, digest(current.raw[role])])),
        after: { index: bytes(sealed(authority.key, final)).toString(), pending: bytes(sealed(authority.key, pending)).toString(),
          ledger: ledgerBytes.toString(), activation: activationBytes.toString() } })
      const prepared = bytes(transaction)
      if (prepared.length > 4 * 1024 * 1024 || !validTransaction(open(prepared, authority.key), authority)) return { result: "policy_limit" }
      await writeContributionImage(authority.root, { role: "transaction" }, prepared, {
        expected: digest(current.raw.transaction), admit: () => currentAuthority(authority),
      })
      return finish(authority, open(prepared, authority.key))
    }, { admit: () => currentAuthority(authority) })
  } catch (error) { const result = handled(error); if (result) return result; throw error }
}
