// Authoritative context state is local. Only ready, source-current, independently
// reviewed records are returned to the ordinary intake publisher.
import { createHash, createHmac } from "node:crypto"
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs"
import * as path from "node:path"
import {
  gitBlobSha, listTaskContextJobs, readConsent, readMachineSecret, readStatus, readTaskContextFile,
  serializeTaskContext, taskContextPath, updateStatus, updateTaskContextState, writeTaskContextFile,
} from "./outbox.js"
import {
  checkContextAgainstFacts, CONTEXT_MAX_BYTES, contextPayloadHash, contextSource, validateContext,
} from "./context-schema.js"
import { isPlainObject, PATTERNS } from "./schema.js"
import { stableStringify } from "./pipeline/normalize.js"
import { declared, isFolder } from "./session-route.js"
import { validatePublished } from "./published-schema.js"
import { walkTasks } from "./boot-check.js"
import { isTaskSegment, jobId } from "./binding.js"
import { readDeskRemote, resolveJobIdentity } from "./desk-repo.js"
import { storeAcceptsContext } from "./context-capability.js"

const STATE = "desk.factory.context-state/1"
const INPUT = "desk.factory.context-input/1"
const PREPARATION_MS = 2000
const CARD_LIMIT = 1000
const deferred = () => Object.assign(new Error("context_preparation_deferred"), { code: "context_preparation_deferred" })
const withinBudget = (deadline, clock) => { if (clock() >= deadline) throw deferred() }
const sha = (value) => createHash("sha256").update(stableStringify(value)).digest("hex")
const result = (name, extra = {}) => ({ result: name, ...extra })
const sameStore = (left, right) => typeof left === "string" && left.toLowerCase() === right.toLowerCase()
const seal = async (env, kind, basis, value) => createHmac("sha256", await readMachineSecret(env)).update(stableStringify({ kind, basis, value })).digest("hex")

export function contextPermission(deskRoot, store) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot) || !PATTERNS.prRepo.test(store)) return "policy_invalid"
  try {
    const meta = path.join(deskRoot, "_meta")
    const metaStat = lstatSync(meta)
    if (!metaStat.isDirectory() || metaStat.isSymbolicLink()) return "policy_invalid"
    const file = path.join(meta, "factory-context.json")
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return "not_opted_in"
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) return "policy_invalid"
    const value = JSON.parse(readFileSync(file, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }))
    if (!isPlainObject(value) || Object.keys(value).sort().join() !== "schema_version,stores" || value.schema_version !== 1 ||
        !isPlainObject(value.stores) || Object.entries(value.stores).some(([key, allowed]) => !PATTERNS.prRepo.test(key) || typeof allowed !== "boolean")) return "policy_invalid"
    const matches = Object.entries(value.stores).filter(([key]) => sameStore(key, store))
    return matches.length > 0 && matches.every(([, allowed]) => allowed) ? "allowed" : "not_opted_in"
  } catch (error) {
    return error.code === "ENOENT" ? "not_opted_in" : "policy_invalid"
  }
}

const allowed = (desk, store) => {
  const route = declared(desk)
  return contextPermission(desk, store) === "allowed" && route.kind === "store" && sameStore(route.store, store)
}

async function stateOf(env, store, job) {
  const bytes = await readTaskContextFile(env, store, job, "state.json")
  if (bytes === null) return null
  let value
  try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("context_state_invalid") }
  if (!isPlainObject(value) || value.schema !== STATE || value.job !== job ||
      !/^[0-9a-f]{64}$/u.test(value.basis) || !["candidate", "privacy", "ready", "refused"].includes(value.phase) ||
      value.input !== `input-${value.basis}.json`) throw new Error("context_state_invalid")
  return value
}

async function inputOf(env, store, state, { current = true } = {}) {
  const bytes = await readTaskContextFile(env, store, state.job, state.input)
  if (bytes === null) throw new Error("context_input_missing")
  let value
  try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("context_input_invalid") }
  if (!isPlainObject(value) || value.schema !== INPUT || value.job !== state.job || value.basis !== state.basis ||
      !Array.isArray(value.sources) || !Array.isArray(value.private_evidence) || !sameStore(value.store, store)) return null
  if (state.input_seal !== await seal(env, "input", state.basis, value)) return null
  if (!current) return value
  if (!allowed(value.desk_root, store)) return null
  for (const evidence of value.private_evidence) {
    const source = value.sources.find((facts) => facts.session.id === evidence.session)
    if (!source || logEvidence({ facts: source, logPath: evidence.log_path, clockOrigin: evidence.clock_origin }).fingerprint !== evidence.fingerprint) return null
  }
  if (value.task_card !== null) {
    try {
      const stat = lstatSync(value.task_card.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 ||
          createHash("sha256").update(readFileSync(value.task_card.path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })).digest("hex") !== value.task_card.sha256) return null
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code)) throw error
      return null
    }
  }
  return value
}

function logEvidence(entry) {
  let log = null
  if (typeof entry.logPath === "string" && path.isAbsolute(entry.logPath)) {
    try {
      const stat = lstatSync(entry.logPath)
      if (stat.isFile() && !stat.isSymbolicLink()) log = { path: entry.logPath, size: stat.size, mtime_ms: stat.mtimeMs }
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error
    }
  }
  return {
    session: entry.facts.session.id, log_path: log?.path ?? null,
    clock_origin: typeof entry.clockOrigin === "string" && PATTERNS.timestamp.test(entry.clockOrigin) ? entry.clockOrigin : null,
    fingerprint: log === null ? null : sha(log),
  }
}

function groupsOf(entries, store) {
  const groups = new Map()
  for (const entry of entries) {
    if (!validatePublished(entry.facts).ok || !allowed(entry.deskRoot, store)) continue
    for (const mapping of entry.localJobs) {
      if (!PATTERNS.jobId.test(mapping.local) || !entry.facts.jobs.some((job) => job.job === mapping.published)) continue
      const group = groups.get(mapping.published) ?? { job: mapping.published, local_job: mapping.local, desk_root: entry.deskRoot, person_prefix: entry.personPrefix, entries: [] }
      if (group.desk_root !== entry.deskRoot || group.local_job !== mapping.local) throw new Error("context_identity_ambiguous")
      group.entries.push(entry)
      groups.set(mapping.published, group)
    }
  }
  return groups
}

// This cursor schedules search only; every candidate still needs fresh identity and path checks.
async function discoveryCursor(env, store, job) {
  const bytes = await readTaskContextFile(env, store, job, "discovery.json")
  if (bytes === null) return 0
  if (bytes.length > 256) throw new Error("context_discovery_invalid")
  let value
  try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("context_discovery_invalid") }
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== "cursor,schema" ||
      value.schema !== "desk.factory.context-discovery/1" || !Number.isSafeInteger(value.cursor) ||
      value.cursor < 0 || value.cursor >= CARD_LIMIT) throw new Error("context_discovery_invalid")
  return value.cursor
}

function taskCardIndex(deskRoot, personPrefix, { wanted, cursor, deadline, clock, readRemote, resolveIdentity }) {
  const cards = new Map()
  let next = cursor
  const within = () => withinBudget(deadline, clock)
  try {
    within()
    const remote = readRemote({ deskRoot, deadline, clock, timeoutMs: 500 })
    within()
    if (remote === null) return { cards, incomplete: false, cursor: 0 }
    const root = realpathSync(deskRoot)
    const base = path.join(root, personPrefix)
    const inspected = new Set()
    const inspect = (task) => {
      within()
      const key = `${task.track}/${task.slug}`
      if (!isTaskSegment(task.track) || !isTaskSegment(task.slug) || inspected.has(key)) return
      inspected.add(key)
      const birth = resolveIdentity({ deskRoot, personPrefix, track: task.track, slug: task.slug, deadline, clock, timeoutMs: 500 })
      within()
      const job = jobId({ deskRemote: remote, personPrefix, ...birth })
      if (!wanted.has(job)) return
      const candidates = [
        path.join(base, task.track, task.slug, "task.md"),
        path.join(base, task.track, "_archive", task.slug, "task.md"),
        path.join(base, "_archive", task.track, task.slug, "task.md"),
        path.join(base, "_archive", task.track, "_archive", task.slug, "task.md"),
      ]
      for (const file of candidates) {
        within()
        try {
          const stat = lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) continue
          const relative = path.relative(root, realpathSync(file))
          if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
          const bytes = readFileSync(file, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })
          within()
          cards.set(job, { path: file, sha256: createHash("sha256").update(bytes).digest("hex") })
          break
        } catch (error) {
          if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code)) throw error
        }
      }
    }
    let visited = 0
    let incomplete = false
    const nominal = []
    const unresolved = []
    const walkDeadline = (clock() + deadline) / 2
    try {
      for (const task of walkTasks({ deskRoot, personPrefix, deadline: walkDeadline, clock })) {
        if (visited++ >= CARD_LIMIT) { incomplete = true; break }
        if (wanted.has(jobId({ deskRemote: remote, personPrefix, track: task.track, slug: task.slug }))) nominal.push(task)
        else unresolved.push(task)
      }
    } catch (error) {
      if (!["context_preparation_deferred", "boot_check_budget", "git_deadline"].includes(error.code)) throw error
      incomplete = true
    }
    const candidates = nominal.concat(unresolved)
    const start = candidates.length === 0 ? 0 : cursor % candidates.length
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const index = (start + offset) % candidates.length
      next = index
      try { inspect(candidates[index]) } catch (error) {
        if (clock() < deadline) next = (index + 1) % candidates.length
        throw error
      }
      next = (index + 1) % candidates.length
      if (cards.size === wanted.size) break
    }
    return { cards, incomplete, cursor: incomplete ? next : 0 }
  } catch (error) {
    if (["context_preparation_deferred", "boot_check_budget", "git_deadline"].includes(error.code)) return { cards, incomplete: true, cursor: next }
    throw error
  }
}

export async function prepareTaskContexts(env, {
  store, entries, pluginVersion, deadline = Infinity, clock = Date.now, readRemote = readDeskRemote, resolveIdentity = resolveJobIdentity,
}) {
  const limit = Math.min(deadline, clock() + PREPARATION_MS)
  const within = () => withinBudget(limit, clock)
  const counts = { prepared: 0, unchanged: 0, held: 0, deferred: [] }
  if ((await readConsent(env)).stores[store]?.contribute !== true) return counts
  const cardIndexes = new Map()
  const groups = [...groupsOf(entries, store).values()]
  for (const group of groups) {
    within()
    group.entries.sort((left, right) => left.facts.session.id.localeCompare(right.facts.session.id))
    const sources = group.entries.map((entry) => entry.facts)
    if (sources.length > 512 || new Set(sources.map((entry) => entry.session.id)).size !== sources.length) { counts.held += 1; continue }
    const privateEvidence = group.entries.map(logEvidence)
    const deskKey = `${group.desk_root}\0${group.person_prefix}`
    if (!cardIndexes.has(deskKey)) {
      const peers = groups.filter((item) => item.desk_root === group.desk_root && item.person_prefix === group.person_prefix)
      const progressJob = peers.map((item) => item.job).sort()[0]
      const cursor = await discoveryCursor(env, store, progressJob)
      const index = taskCardIndex(group.desk_root, group.person_prefix, {
        wanted: new Set(peers.map((item) => item.local_job)), cursor, deadline: (clock() + limit) / 2, clock, readRemote, resolveIdentity,
      })
      cardIndexes.set(deskKey, index)
      if (index.cursor !== cursor) await writeTaskContextFile(env, store, progressJob, "discovery.json", {
        schema: "desk.factory.context-discovery/1", cursor: index.cursor,
      })
    }
    const index = cardIndexes.get(deskKey)
    if (index.incomplete && !index.cards.has(group.local_job)) {
      counts.held += 1
      counts.deferred.push(group.job)
      continue
    }
    const taskCard = index.cards.get(group.local_job) ?? null
    const basis = sha({ sources: sources.map((facts) => contextSource(facts, group.job)), private_evidence: privateEvidence, task_card: taskCard, plugin_version: pluginVersion })
    const input = {
      schema: INPUT, basis, job: group.job, local_job: group.local_job, desk_root: group.desk_root,
      person_prefix: group.person_prefix, store,
      evaluator: { plugin_version: pluginVersion, rubric: "1" }, sources, private_evidence: privateEvidence, task_card: taskCard,
    }
    if (Buffer.byteLength(serializeTaskContext(input)) > 16 * 1024 * 1024) { counts.held += 1; continue }
    const before = await stateOf(env, store, group.job)
    within()
    if (before?.basis === basis) { counts.unchanged += 1; continue }
    await writeTaskContextFile(env, store, group.job, `input-${basis}.json`, input)
    const inputSeal = await seal(env, "input", basis, input)
    await updateTaskContextState(env, store, group.job, (current) => ({
      schema: STATE, job: group.job, basis, input: `input-${basis}.json`, phase: "candidate",
      input_seal: inputSeal, review_seal: null,
      candidate: null, candidate_hash: null, record: null, attempts: { candidate: 0, privacy: 0 }, last_attempts: current?.last_attempts ?? {},
      published_sha: current?.published_sha ?? null, pr: current?.pr ?? null,
      sent_sha: current?.sent_sha ?? null, sent_basis: current?.sent_basis ?? null, sent_delete: current?.sent_delete ?? false,
      publication_seal: current?.publication_seal ?? null, refusals: 0, hold_until: null,
    }))
    counts.prepared += 1
  }
  return counts
}

export async function listContextWork(env, { store }) {
  if ((await readConsent(env)).stores[store]?.contribute !== true) return []
  const work = []
  for (const job of (await listTaskContextJobs(env, store)).slice(0, 1000)) {
    const state = await stateOf(env, store, job)
    if (state === null || !["candidate", "privacy"].includes(state.phase)) continue
    const input = await inputOf(env, store, state)
    if (input === null) continue
    work.push({
      job, basis: state.basis, phase: state.phase, state, source: input,
      input: await taskContextPath(env, store, job, state.input),
    })
  }
  return work
}

function parseOutput(bytes) {
  if (!(typeof bytes === "string" || Buffer.isBuffer(bytes)) || Buffer.byteLength(bytes) > CONTEXT_MAX_BYTES) return null
  try { return JSON.parse(bytes.toString("utf8")) } catch { return null }
}

async function freshState(env, store, job, basis) {
  const state = await stateOf(env, store, job)
  if (state === null || state.basis !== basis || (await readConsent(env)).stores[store]?.contribute !== true) return null
  const input = await inputOf(env, store, state)
  return input === null ? null : { state, input }
}

export async function acceptContextCandidate(env, { store, job, basis, bytes }) {
  const current = await freshState(env, store, job, basis)
  if (current === null) return result("source_changed")
  if (current.state.phase !== "candidate") return result("phase_changed")
  const value = parseOutput(bytes)
  if (!value) return result("invalid_candidate")
  if (value.privacy !== null) return result("review_not_independent")
  if (value.job !== job || stableStringify(value.evaluator) !== stableStringify(current.input.evaluator)) return result("identity_mismatch")
  const checked = checkContextAgainstFacts(value, current.input.sources, { candidate: true })
  if (!checked.ok) return result("invalid_candidate", { errors: checked.errors })
  const payloadHash = contextPayloadHash(value)
  const next = await updateTaskContextState(env, store, job, (state) => state.basis !== basis || state.phase !== "candidate" ? state : {
    ...state, phase: "privacy", candidate: value, candidate_hash: payloadHash,
  })
  return next.basis === basis && next.phase === "privacy" ? result("candidate_accepted", { payload_sha256: payloadHash }) : result("source_changed")
}

export async function acceptContextPrivacy(env, { store, job, basis, bytes }) {
  const current = await freshState(env, store, job, basis)
  if (current === null) return result("source_changed")
  if (current.state.phase !== "privacy") return result("phase_changed")
  const review = parseOutput(bytes)
  if (!isPlainObject(review) || Object.keys(review).sort().join() !== "payload_sha256,reason,reviewer,schema,verdict" ||
      review.schema !== "desk.factory.context-review/1" || !["approved", "withheld"].includes(review.verdict) ||
      !["safe", "sensitive", "unsupported", "uncertain"].includes(review.reason) ||
      stableStringify(review.reviewer) !== stableStringify(current.input.evaluator)) return result("invalid_review")
  if (review.payload_sha256 !== current.state.candidate_hash || contextPayloadHash(current.state.candidate) !== current.state.candidate_hash) return result("review_mismatch")
  if (review.verdict !== "approved" || review.reason !== "safe") {
    await updateTaskContextState(env, store, job, (state) => state.basis !== basis ? state : { ...state, phase: "refused", candidate: null })
    return result("context_withheld")
  }
  const record = {
    ...current.state.candidate,
    privacy: { verdict: "approved", payload_sha256: review.payload_sha256, reviewer: { ...review.reviewer } },
  }
  if (!checkContextAgainstFacts(record, current.input.sources).ok) return result("invalid_review")
  const reviewSeal = await seal(env, "review", basis, record)
  const next = await updateTaskContextState(env, store, job, (state) => state.basis !== basis || state.phase !== "privacy" ? state : { ...state, phase: "ready", record, candidate: null, review_seal: reviewSeal })
  return next.basis === basis && next.phase === "ready" ? result("context_accepted") : result("source_changed")
}

export async function readyTaskContexts(env, { store, entries, deadline = Infinity, clock = Date.now, skipJobs = new Set() }) {
  if ((await readConsent(env)).stores[store]?.contribute !== true) return []
  const groups = groupsOf(entries, store)
  const ready = []
  for (const job of (await listTaskContextJobs(env, store)).slice(0, 1000)) {
    withinBudget(deadline, clock)
    if (skipJobs.has(job)) continue
    const state = await stateOf(env, store, job)
    if (state === null || !groups.has(job)) continue
    const input = await inputOf(env, store, state)
    if (input === null) continue
    let record = state.record
    const invalidation = state.phase !== "ready"
    if (invalidation) {
      if (state.published_sha === null) continue
      record = {
        schema: "desk.factory.context/1", job, evaluator: input.evaluator, state: "unavailable", heading: null, events: [],
        sources: input.sources.map((facts) => contextSource(facts, job)),
        coverage: { state: "unavailable", reasons: [state.phase === "refused" ? "not_recorded" : "review_pending"], omitted_events: 0 },
        privacy: null,
      }
      record.privacy = { verdict: "not_required", payload_sha256: contextPayloadHash(record), reviewer: null }
    } else if (state.review_seal !== await seal(env, "review", state.basis, record)) continue
    if (!validateContext(record).ok ||
        !checkContextAgainstFacts(record, groups.get(job).entries.map((entry) => entry.facts)).ok) continue
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
    ready.push({
      name: `context/${job}.json`, path: `context/${job}.json`, bytes, sha: gitBlobSha(bytes), context: true, job, basis: state.basis, invalidation,
      source_files: groups.get(job).entries.map((entry) => ({
        name: entry.name ?? `${entry.facts.session.host}-${entry.facts.session.id}.json`,
        published: `${entry.facts.session.host}-${entry.facts.session.id}.json`,
        sha: gitBlobSha(`${JSON.stringify(entry.facts)}\n`),
      })),
    })
  }
  return ready
}

const DAY_MS = 24 * 3600 * 1000
const publication = (state) => ({
  published_sha: state.published_sha ?? null, sent_sha: state.sent_sha ?? null,
  sent_basis: state.sent_basis ?? null, sent_delete: state.sent_delete === true, pr: state.pr ?? null,
})
async function trustedPublication(env, state) {
  const fields = publication(state)
  if (fields.published_sha === null && fields.sent_sha === null && fields.pr === null) return true
  return state.publication_seal === await seal(env, "publication", state.job, fields)
}
async function changePublication(env, store, job, mutate) {
  const before = await stateOf(env, store, job)
  if (before === null || !await trustedPublication(env, before)) throw new Error("context_publication_receipt_invalid")
  const fields = mutate(publication(before))
  const proof = await seal(env, "publication", job, fields)
  return updateTaskContextState(env, store, job, (state) => stableStringify(publication(state)) !== stableStringify(publication(before)) ? state : {
    ...state, ...fields, publication_seal: proof,
  })
}
async function publicationStatus(env, store, patch) {
  return updateStatus(env, (status) => ({
    ...status,
    context_publication: { ...status.context_publication, [store]: { ...status.context_publication?.[store], ...patch } },
  }))
}

/** Local planning only; cached negative readiness never sends an unchanged queue online every start. */
export async function planContextPublication(env, { store, entries, pluginVersion, now, deadline = Infinity, clock = Date.now, ...readers }) {
  const limit = Math.min(deadline, clock() + PREPARATION_MS)
  const prepared = await prepareTaskContexts(env, { store, entries, pluginVersion, deadline: limit, clock, ...readers })
  const ready = await readyTaskContexts(env, { store, entries, deadline: limit, clock, skipJobs: new Set(prepared.deferred) })
  const states = []
  for (const job of (await listTaskContextJobs(env, store)).slice(0, 1000)) {
    withinBudget(limit, clock)
    const state = await stateOf(env, store, job)
    if (state === null) continue
    if (!await trustedPublication(env, state)) throw new Error("context_publication_receipt_invalid")
    const input = await inputOf(env, store, state, { current: false })
    if (input === null) continue
    const route = declared(input.desk_root)
    const permission = contextPermission(input.desk_root, store)
    const withdrawn = isFolder(input.desk_root) && route.kind === "store" &&
      (!sameStore(route.store, store) || permission === "not_opted_in")
    states.push({ state, withdrawn })
  }
  const cached = (await readStatus(env)).context_publication?.[store]
  const held = Number.isFinite(cached?.hold_until) && cached.hold_until > now
  const stale = !Number.isFinite(Date.parse(cached?.checked_at)) || now - Date.parse(cached.checked_at) > DAY_MS
  const prPending = states.some(({ state }) => Number.isSafeInteger(state.pr))
  const retracting = states.some(({ state, withdrawn }) => withdrawn && state.published_sha !== null)
  const unsent = ready.some((item) => states.some(({ state }) => state.job === item.job &&
    state.published_sha !== item.sha && !(Number.isFinite(state.hold_until) && state.hold_until > now)))
  const unfinished = states.some(({ state }) => ["candidate", "privacy"].includes(state.phase))
  return { work: prPending || retracting || (!held && (unsent || (stale && (unfinished || prepared.prepared > 0)))), ready, states, deferred: prepared.deferred.length > 0, prs: new Set(states.map(({ state }) => state.pr).filter(Number.isSafeInteger)) }
}

export async function contextOnBranch(read, tree) {
  const directory = (await read(tree)).get("context")
  const blobs = new Map()
  if (directory?.type !== "tree") return blobs
  for (const [name, entry] of await read(directory.sha)) {
    if (/^[0-9a-f]{32}\.json$/u.test(name) && entry.type === "blob") blobs.set(`context/${name}`, entry.sha)
  }
  return blobs
}

/** Only the actual default branch acknowledges a send; only an exact owned blob can be replaced or retracted. */
export async function prepareContextPublication(env, { store, plan, client, ref, direct, now, readMain }) {
  if (!plan.work) return []
  const ready = direct && await storeAcceptsContext(client, store, ref)
  await publicationStatus(env, store, { ready, checked_at: new Date(now).toISOString(), hold_until: ready ? null : now + DAY_MS, code: ready ? null : direct ? "context_store_not_ready" : "context_authority_unavailable" })
  const main = await readMain()
  if (main.unknown) {
    await publicationStatus(env, store, { hold_until: now + DAY_MS, code: "context_main_unknown" })
    return []
  }
  const items = []
  for (const entry of plan.states) {
    let state = await stateOf(env, store, entry.state.job)
    if (state === null || (await readConsent(env)).stores[store]?.contribute !== true) continue
    if (!await trustedPublication(env, state)) throw new Error("context_publication_receipt_invalid")
    const input = await inputOf(env, store, state, { current: false })
    if (input === null) continue
    const route = declared(input.desk_root)
    const withdrawn = isFolder(input.desk_root) && route.kind === "store" &&
      (!sameStore(route.store, store) || contextPermission(input.desk_root, store) === "not_opted_in")
    const current = main.blobs.get(`context/${state.job}.json`)
    if (typeof state.sent_sha === "string" && current === state.sent_sha) {
      state = await changePublication(env, store, state.job, (fields) => ({ ...fields, published_sha: current, pr: null }))
    }
    if (withdrawn) {
      if (!direct || state.published_sha === null) continue
      if (current === state.published_sha) items.push({
        name: `context/${state.job}.json`, path: `context/${state.job}.json`, job: state.job, basis: state.basis,
        bytes: Buffer.alloc(0), sha: null, context: true, retract: true,
      })
      else if (current === undefined) await changePublication(env, store, state.job, (fields) => ({ ...fields, published_sha: null, sent_sha: null, sent_basis: null, sent_delete: false, pr: null }))
      continue
    }
    const item = plan.ready.find((candidate) => candidate.job === state.job)
    if (!ready || !item || (state.phase !== "ready" && !item.invalidation) || (Number.isFinite(state.hold_until) && state.hold_until > now)) continue
    if (state.basis !== item.basis || await inputOf(env, store, state) === null) continue
    if (!item.invalidation && (state.review_seal !== await seal(env, "review", state.basis, state.record) ||
        item.sha !== gitBlobSha(`${JSON.stringify(state.record)}\n`))) continue
    if (current === item.sha) {
      await changePublication(env, store, state.job, (fields) => ({ ...fields, published_sha: item.sha, pr: null }))
    } else if (current === undefined || current === state.published_sha) items.push(item)
    else await publicationStatus(env, store, { code: "context_collision", hold_until: now + DAY_MS })
  }
  return items.slice(0, 8)
}

export async function saveContextSent(env, store, items, pr) {
  for (const item of items) await changePublication(env, store, item.job, (fields) => ({
    ...fields, pr, sent_sha: item.retract ? null : item.sha, sent_basis: item.basis, sent_delete: item.retract === true,
  }))
}

export async function saveContextRefused(env, store, plan, code, now) {
  for (const { state: planned } of plan.states) {
    if (!Number.isSafeInteger(planned.pr)) continue
    await changePublication(env, store, planned.job, (fields) => ({ ...fields, pr: null }))
    await updateTaskContextState(env, store, planned.job, (state) => {
      if (state.sent_basis !== state.basis) return state
      const refusals = (Number.isSafeInteger(state.refusals) ? state.refusals : 0) + 1
      return { ...state, refusals, hold_until: now + DAY_MS, ...(refusals >= 3 ? { phase: "refused", record: null } : {}) }
    })
  }
  await publicationStatus(env, store, { code, hold_until: now + DAY_MS })
}

export async function recordContextError(env, store, code = "context_error") {
  await publicationStatus(env, store, { code })
}

export async function contextPublisherUnavailable(env, store, now) {
  await publicationStatus(env, store, { ready: false, checked_at: new Date(now).toISOString(), hold_until: now + DAY_MS, code: "context_authority_unavailable" })
}
