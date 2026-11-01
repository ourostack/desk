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
  checkContextAgainstFacts, CONTEXT_MAX_BYTES, RECOMMENDATION_SCHEMA, contextPayloadHash, contextShare, contextSource, validateContext,
} from "./context-schema.js"
import { addError, isPlainObject, PATTERNS } from "./schema.js"
import { stableStringify } from "./pipeline/normalize.js"
import { declared, isFolder } from "./session-route.js"
import { SESSION_ID_V4, validatePublished } from "./published-schema.js"
import { walkTasks } from "./boot-check.js"
import { isTaskSegment, jobId } from "./binding.js"
import { readDeskRemote, resolveJobIdentity } from "./desk-repo.js"
import { storeAcceptsContext } from "./context-capability.js"
import { readCopilotConversation } from "./copilot-turn-index.js"
import { localRecordsPath } from "./copilot-usage.js"
import { normalizeTimestamp } from "./time.js"

const STATE = "desk.factory.context-state/1"
const INDEXED_STATE = "desk.factory.context-state/2"
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

/** Reading and retaining indexed text is an additional, job-specific declaration, never inferred from prose. */
export function indexedContextPermission(deskRoot, store, localJob, nativeSession) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot) || !PATTERNS.prRepo.test(store) || !PATTERNS.jobId.test(localJob) ||
      typeof nativeSession !== "string" || !SESSION_ID_V4.test(nativeSession)) return "policy_invalid"
  try {
    const meta = path.join(deskRoot, "_meta")
    const metaStat = lstatSync(meta)
    if (!metaStat.isDirectory() || metaStat.isSymbolicLink()) return "policy_invalid"
    const file = path.join(meta, "factory-indexed-context.json")
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return "not_opted_in"
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) return "policy_invalid"
    const value = JSON.parse(readFileSync(file, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }))
    if (!isPlainObject(value) || Object.keys(value).sort().join() !== "schema_version,stores" || value.schema_version !== 1 ||
        !isPlainObject(value.stores) || Object.entries(value.stores).some(([key, jobs]) => !PATTERNS.prRepo.test(key) ||
          !isPlainObject(jobs) || Object.keys(jobs).length > 256 || Object.entries(jobs).some(([job, sessions]) =>
            !PATTERNS.jobId.test(job) || !Array.isArray(sessions) || sessions.length > 256 || new Set(sessions).size !== sessions.length ||
            sessions.some(session => typeof session !== "string" || !SESSION_ID_V4.test(session))))) return "policy_invalid"
    const matches = Object.entries(value.stores).filter(([key]) => sameStore(key, store))
    return matches.length > 0 && matches.every(([, jobs]) => jobs[localJob]?.includes(nativeSession)) ? "allowed" : "not_opted_in"
  } catch (error) {
    return error.code === "ENOENT" ? "not_opted_in" : "policy_invalid"
  }
}

async function stateOf(env, store, job) {
  const bytes = await readTaskContextFile(env, store, job, "state.json")
  if (bytes === null) return null
  let value
  try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("context_state_invalid") }
  if (!isPlainObject(value) || ![STATE, INDEXED_STATE].includes(value.schema) || value.job !== job ||
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
  if (value.task_card_status !== undefined &&
      (!["associated", "not_associated", "unavailable", "scoped_out"].includes(value.task_card_status) ||
       (value.task_card_status === "associated") !== (value.task_card !== null))) return null
  if (state.input_seal !== await seal(env, "input", state.basis, value)) return null
  return !current || await inputCurrent(value, store, env) ? value : null
}

async function inputCurrent(value, store, env) {
  if (!allowed(value.desk_root, store)) return false
  for (const evidence of value.private_evidence) {
    const source = value.sources.find((facts) => facts.session.id === evidence.session)
    if (!source) return false
    if (evidence.native_context !== undefined) {
      const native = evidence.native_context
      const current = describeEvidence(logEvidence({ facts: source, store, deskRoot: value.desk_root, logPath: native.raw_log_path, clockOrigin: native.started_at,
        nativeContext: native, localJobs: [{ local: value.local_job, published: value.job }] }, env))
      if (current.conversation?.status === "unreadable" || sha(current) !== sha(evidence)) return false
      if (current.conversation?.file !== null && current.conversation?.file !== undefined) {
        const bytes = await readTaskContextFile(env, store, value.job, current.conversation.file)
        if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== current.conversation.projection_sha256) return false
      }
    } else if (logEvidence({ facts: source, logPath: evidence.log_path, clockOrigin: evidence.clock_origin }, env).fingerprint !== evidence.fingerprint) return false
  }
  if (value.task_card !== null) {
    try {
      const stat = lstatSync(value.task_card.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 ||
          createHash("sha256").update(readFileSync(value.task_card.path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })).digest("hex") !== value.task_card.sha256) return false
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code)) throw error
      return false
    }
  }
  return true
}

function nativeEligible(entry) {
  const native = entry.nativeContext
  const jobs = entry.facts.jobs
  const maps = entry.localJobs
  const spans = jobs.length === 1 ? contextShare(entry.facts, jobs[0].job) : []
  return native?.full_share === true && entry.facts.session.host === "copilot-cli" &&
    typeof native.session === "string" && SESSION_ID_V4.test(native.session) &&
    native.duration_ms === entry.facts.session.duration_ms && normalizeTimestamp(native.started_at) !== null &&
    maps?.length === 1 && maps[0].local === native.job && jobs.length === 1 && maps[0].published === jobs[0].job &&
    jobs[0].segments?.length === 1 &&
    spans.length === 1 && spans[0].start_ms === 0 && spans[0].end_ms === native.duration_ms
}

function logEvidence(entry, env) {
  const native = nativeEligible(entry) ? entry.nativeContext : null
  const candidate = entry.logPath ?? (native === null ? null : path.join(path.dirname(localRecordsPath(env)), "session-state", native.session, "events.jsonl"))
  let log = null
  let missing = false
  let rawProblem = "raw_source_invalid"
  if (typeof candidate === "string" && path.isAbsolute(candidate)) {
    try {
      const stat = lstatSync(candidate)
      if (stat.isFile() && !stat.isSymbolicLink()) log = { path: candidate, size: stat.size, mtime_ms: stat.mtimeMs }
      else rawProblem = "raw_source_unsafe"
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error
      missing = error.code === "ENOENT"
      rawProblem = "raw_source_permission"
    }
  }
  const permission = log === null && native !== null ? indexedContextPermission(entry.deskRoot, entry.store, native.job, native.session) : "not_opted_in"
  const indexed = log === null && native !== null && permission !== "not_opted_in"
  const evidence = {
    session: entry.facts.session.id, log_path: log?.path ?? null,
    clock_origin: !indexed && typeof entry.clockOrigin === "string" && PATTERNS.timestamp.test(entry.clockOrigin) ? entry.clockOrigin : null,
    fingerprint: log === null ? null : sha(log),
  }
  if (indexed) {
    const until = new Date(Date.parse(normalizeTimestamp(native.started_at)) + native.duration_ms).toISOString()
    evidence.native_context = { ...native, raw_log_path: candidate }
    evidence.conversation = { kind: "native_copilot_turn_index", native_session: native.session,
      ...(permission === "policy_invalid" ? { status: "unreadable", reason: "indexed_policy_invalid", digest: null, turns: [], excluded_rows: 0 }
        : missing ? readCopilotConversation({ env, sessionId: native.session, recordedUntil: until, expectedDesk: entry.deskRoot })
        : { status: "unreadable", reason: rawProblem, digest: null, turns: [], excluded_rows: 0 }) }
  }
  return evidence
}

function conversationProjection(evidence) {
  const parts = text => {
    if (text === null) return null
    const points = [...text]
    const chunks = []
    // Keep the existing 500-character readability bound even with six-character JSON escapes.
    for (let at = 0; at < points.length; at += 64) chunks.push(points.slice(at, at + 64).join(""))
    return chunks
  }
  return { schema: "desk.factory.conversation-index/1", session: evidence.session,
    kind: "native_copilot_turn_index", source_digest: evidence.conversation.digest,
    excluded_rows: evidence.conversation.excluded_rows, unavailable: ["tool_payloads", "action_clock", "verification"],
    turns: evidence.conversation.turns.map(row => ({ turn_index: row.turn_index,
      user_message_parts: parts(row.user_message), assistant_response_parts: parts(row.assistant_response) })) }
}

function describeEvidence(evidence) {
  if (evidence.conversation === undefined) return evidence
  const { turns, ...metadata } = evidence.conversation
  if (metadata.status !== "available") return { ...evidence, conversation: { ...metadata, file: null, projection_sha256: null, turns_count: 0 } }
  const bytes = serializeTaskContext(conversationProjection(evidence))
  if (Buffer.byteLength(bytes) > 256 * 1024) return { ...evidence,
    conversation: { ...metadata, status: "too_large", reason: "projection_too_large", file: null, projection_sha256: null, turns_count: 0 } }
  const digest = createHash("sha256").update(bytes).digest("hex")
  return { ...evidence, conversation: { ...metadata, file: `conversation-${digest}.json`, projection_sha256: digest, turns_count: turns.length } }
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

async function preparationCursor(env, store, job) {
  const bytes = await readTaskContextFile(env, store, job, "preparation.json")
  if (bytes === null) return null
  if (bytes.length > 256) throw new Error("context_preparation_cursor_invalid")
  let value
  try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("context_preparation_cursor_invalid") }
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== "next,schema" ||
      value.schema !== "desk.factory.context-preparation/1" || typeof value.next !== "string" || !PATTERNS.jobId.test(value.next))
    throw new Error("context_preparation_cursor_invalid")
  return value.next
}

function* taskCardIndex(deskRoot, personPrefix, { wanted, cursor, deadline, clock, readRemote, resolveIdentity }) {
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
    // Spread known paths across the cursor cycle instead of hiding them before a long fallback tail.
    const candidates = []
    let nominalIndex = 0
    let unresolvedIndex = 0
    while (nominalIndex < nominal.length || unresolvedIndex < unresolved.length) {
      const takeNominal = nominalIndex < nominal.length && (unresolvedIndex === unresolved.length ||
        nominalIndex * unresolved.length <= unresolvedIndex * nominal.length)
      candidates.push(takeNominal ? nominal[nominalIndex++] : unresolved[unresolvedIndex++])
    }
    const start = candidates.length === 0 ? 0 : cursor % candidates.length
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const index = (start + offset) % candidates.length
      next = index
      try { inspect(candidates[index]) } catch (error) {
        if (clock() < deadline) next = (index + 1) % candidates.length
        throw error
      }
      next = (index + 1) % candidates.length
      yield { cards, cursor: next }
      if (cards.size === wanted.size) break
    }
    return { cards, incomplete, cursor: incomplete ? next : 0 }
  } catch (error) {
    if (["context_preparation_deferred", "boot_check_budget", "git_deadline"].includes(error.code)) return { cards, incomplete: true, cursor: next }
    throw error
  }
}

export async function prepareTaskContexts(env, options) {
  return prepareContextGroups(env, options)
}

async function prepareContextGroups(env, {
  store, entries, pluginVersion, deadline = Infinity, clock = Date.now, readRemote = readDeskRemote, resolveIdentity = resolveJobIdentity,
}, verifiedGroups) {
  const limit = Math.min(deadline, clock() + PREPARATION_MS)
  const within = () => withinBudget(limit, clock)
  const counts = { prepared: 0, unchanged: 0, held: 0, deferred: [] }
  if ((await readConsent(env)).stores[store]?.contribute !== true) return counts
  const groups = verifiedGroups ?? [...groupsOf(entries, store).values()]
  const namespaces = new Map()
  for (const group of groups) {
    const key = `${group.desk_root}\0${group.person_prefix}`
    if (!namespaces.has(key)) namespaces.set(key, [])
    namespaces.get(key).push(group)
  }
  const save = async (group, taskCard, taskCardStatus) => {
    within()
    if (!allowed(group.desk_root, store)) return
    group.entries.sort((left, right) => left.facts.session.id.localeCompare(right.facts.session.id))
    const allSources = group.entries.map((entry) => entry.facts)
    if (new Set(allSources.map((entry) => entry.session.id)).size !== allSources.length) { counts.held += 1; return }
    const allEvidence = group.entries.map(entry => { within(); return logEvidence({ ...entry, store }, env) })
    if (allEvidence.some(evidence => evidence.conversation?.status === "unreadable")) throw deferred()
    const indexed = allEvidence.map((evidence, index) => evidence.conversation === undefined ? -1 : index).filter(index => index >= 0)
    const selected = indexed.length > 0 ? indexed : allEvidence.map((_, index) => index)
    const sources = selected.map(index => allSources[index])
    const observedEvidence = selected.map(index => allEvidence[index])
    const privateEvidence = observedEvidence.map(describeEvidence)
    if (indexed.length > 0) { taskCard = null; taskCardStatus = "scoped_out" }
    within()
    const basisFor = (card, status) => sha({
      sources: sources.map((facts) => contextSource(facts, group.job)), private_evidence: privateEvidence,
      task_card: card, ...(status === undefined ? {} : { task_card_status: status }), plugin_version: pluginVersion,
    })
    const basis = basisFor(taskCard, taskCardStatus)
    const input = {
      schema: INPUT, basis, job: group.job, local_job: group.local_job, desk_root: group.desk_root,
      person_prefix: group.person_prefix, store,
      evaluator: { plugin_version: pluginVersion, rubric: "1" }, sources, private_evidence: privateEvidence, task_card: taskCard, task_card_status: taskCardStatus,
      ...(indexed.length > 0 ? { source_selection: "indexed_conversation" } : {}),
    }
    if (Buffer.byteLength(serializeTaskContext(input)) > 16 * 1024 * 1024) { counts.held += 1; return }
    for (const [index, evidence] of privateEvidence.entries()) {
      if (!evidence.conversation?.file) continue
      within()
      const bytes = await readTaskContextFile(env, store, group.job, evidence.conversation.file)
      if (bytes === null) await writeTaskContextFile(env, store, group.job, evidence.conversation.file, conversationProjection(observedEvidence[index]))
      else if (createHash("sha256").update(bytes).digest("hex") !== evidence.conversation.projection_sha256)
        throw Object.assign(new Error("context_projection_changed"), { code: "context_projection_changed" })
    }
    const before = await stateOf(env, store, group.job)
    within()
    if (before?.basis === basis) { counts.unchanged += 1; return }
    if (taskCardStatus === "unavailable" && before !== null) {
      const previous = await inputOf(env, store, before)
      within()
      if (previous?.task_card && before.basis === basisFor(previous.task_card, previous.task_card_status)) {
        counts.unchanged += 1
        return
      }
    }
    await writeTaskContextFile(env, store, group.job, `input-${basis}.json`, input)
    const inputSeal = await seal(env, "input", basis, input)
    await updateTaskContextState(env, store, group.job, (current) => ({
      schema: indexed.length > 0 ? INDEXED_STATE : STATE, job: group.job, basis, input: `input-${basis}.json`, phase: "candidate",
      input_seal: inputSeal, review_seal: null,
      candidate: null, candidate_hash: null, record: null, attempts: { candidate: 0, privacy: 0 }, last_attempts: current?.last_attempts ?? {},
      published_sha: current?.published_sha ?? null, pr: current?.pr ?? null,
      sent_sha: current?.sent_sha ?? null, sent_basis: current?.sent_basis ?? null, sent_delete: current?.sent_delete ?? false,
      publication_seal: current?.publication_seal ?? null, refusals: 0, hold_until: null,
    }))
    counts.prepared += 1
  }
  for (const peers of namespaces.values()) {
    within()
    const first = peers[0]
    if (!allowed(first.desk_root, store)) continue
    const eligible = peers.filter((group) => {
      const sources = group.entries.map((entry) => entry.facts)
      if (sources.length > 512 || new Set(sources.map((entry) => entry.session.id)).size !== sources.length) {
        counts.held += 1
        return false
      }
      return true
    })
    if (eligible.length === 0) continue
    eligible.sort((left, right) => left.job.localeCompare(right.job))
    const progressJob = peers.map((group) => group.job).sort()[0]
    const savedNext = await preparationCursor(env, store, progressJob)
    const found = savedNext === null ? 0 : eligible.findIndex((group) => group.job >= savedNext)
    const start = found < 0 ? 0 : found
    let next = eligible[start].job
    let offset = 0
    const saved = new Set()
    const pendingCards = new Map()
    const saveAvailable = async (cards, incomplete, finished) => {
      while (offset < eligible.length) {
        const index = (start + offset) % eligible.length
        const group = eligible[index]
        const card = cards.get(group.local_job)
        if (card === undefined && !finished) return
        if (card === undefined && incomplete) counts.deferred.push(group.job)
        const status = card !== undefined ? "associated" : incomplete ? "unavailable" : "not_associated"
        await save(group, card ?? null, status)
        saved.add(group.job)
        pendingCards.delete(group.job)
        offset += 1
        next = eligible[(index + 1) % eligible.length].job
      }
    }
    let cursor = await discoveryCursor(env, store, progressJob)
    const noteCards = (cards) => {
      for (const group of eligible) {
        if (cards.has(group.local_job) && !saved.has(group.job) && !pendingCards.has(group.job))
          pendingCards.set(group.job, cursor)
      }
    }
    const remember = async (next) => {
      if (next === cursor) return
      await writeTaskContextFile(env, store, progressJob, "discovery.json", {
        schema: "desk.factory.context-discovery/1", cursor: next,
      })
      cursor = next
    }
    try {
      const iterator = taskCardIndex(first.desk_root, first.person_prefix, {
        wanted: new Set(eligible.map((group) => group.local_job)), cursor,
        deadline: Math.min(clock() + PREPARATION_MS / 2, limit), clock, readRemote, resolveIdentity,
      })
      let step = iterator.next()
      while (!step.done) {
        noteCards(step.value.cards)
        await saveAvailable(step.value.cards, false, false)
        await remember(step.value.cursor)
        step = iterator.next()
      }
      const index = step.value
      noteCards(index.cards)
      await remember(index.cursor)
      await saveAvailable(index.cards, index.incomplete, true)
    } finally {
      if (pendingCards.size > 0) await remember(pendingCards.values().next().value)
      if (next !== savedNext) await writeTaskContextFile(env, store, progressJob, "preparation.json", {
        schema: "desk.factory.context-preparation/1", next,
      })
    }
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

function indexedContextSafe(value, input) {
  const indexed = new Set(input.private_evidence.filter(entry => entry.conversation !== undefined).map(entry => entry.session))
  if (indexed.size === 0 || value.state !== "published") return true
  if (value.coverage.state !== "partial" || !["not_recorded", "unplaced"].every(reason => value.coverage.reasons.includes(reason))) return false
  return value.events.every(event => event.evidence.every(ref => !indexed.has(ref.session) ||
    event.kind !== "waiting" && ["start", "share_start", "share_end"].includes(ref.anchor)))
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
  if (!indexedContextSafe(value, current.input)) return result("invalid_candidate", { errors: [{ code: "indexed_clock", path: "events" }] })
  if (current.input.task_card_status === "unavailable" && value.state === "published" &&
      (value.coverage.state !== "partial" || !value.coverage.reasons.includes("not_recorded"))) {
    const errors = []
    addError(errors, "incomplete", "coverage")
    return result("invalid_candidate", { errors })
  }
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
  if (!indexedContextSafe(current.state.candidate, current.input)) return result("invalid_review")
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
    const item = await readyContext(env, store, state, groups.get(job))
    if (item !== null) ready.push(item)
  }
  return ready
}

async function readyContext(env, store, state, group, verifiedInput) {
  const job = state.job
  const invalidation = state.phase !== "ready"
  if (invalidation && state.published_sha === null) return null
  const input = verifiedInput === undefined
    ? await inputOf(env, store, state)
    : await inputCurrent(verifiedInput, store, env) ? verifiedInput : null
  if (input === null) return null
  let record = state.record
  if (invalidation) {
    record = {
      schema: RECOMMENDATION_SCHEMA, job, evaluator: input.evaluator, state: "unavailable", heading: null, events: [], recommendations: [],
      sources: input.sources.map((facts) => contextSource(facts, job)),
      coverage: { state: "unavailable", reasons: [state.phase === "refused" ? "not_recorded" : "review_pending"], omitted_events: 0 },
      privacy: null,
    }
    record.privacy = { verdict: "not_required", payload_sha256: contextPayloadHash(record), reviewer: null }
  } else if (state.review_seal !== await seal(env, "review", state.basis, record)) return null
  if (!validateContext(record).ok || !checkContextAgainstFacts(record, group.entries.map((entry) => entry.facts)).ok ||
      !indexedContextSafe(record, input)) return null
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  return {
    name: `context/${job}.json`, path: `context/${job}.json`, bytes, sha: gitBlobSha(bytes), context: true, job, basis: state.basis, invalidation,
    source_files: group.entries.map((entry) => ({
      name: entry.name ?? `${entry.facts.session.host}-${entry.facts.session.id}.json`,
      published: `${entry.facts.session.host}-${entry.facts.session.id}.json`,
      sha: gitBlobSha(`${JSON.stringify(entry.facts)}\n`),
    })),
  }
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

async function planningTurn(env, store) {
  let first
  await updateStatus(env, (status) => {
    const turns = status.context_planning
    if (turns !== undefined && !isPlainObject(turns)) throw new Error("context_planning_state_invalid")
    first = turns?.[store] ?? "prepare"
    if (turns?.[store] === null || !["prepare", "publish"].includes(first)) throw new Error("context_planning_state_invalid")
    return { ...status, context_planning: { ...turns, [store]: first === "prepare" ? "publish" : "prepare" } }
  })
  return first
}

/** Local planning only; cached negative readiness never sends an unchanged queue online every start. */
export async function planContextPublication(env, { store, entries, pluginVersion, now, deadline = Infinity, clock = Date.now, ...readers }) {
  const limit = Math.min(deadline, clock() + PREPARATION_MS)
  if ((await readConsent(env)).stores[store]?.contribute !== true) return { work: false, ready: [], states: [], deferred: false, prs: new Set() }
  const groups = groupsOf(entries, store)
  const jobs = (await listTaskContextJobs(env, store)).slice(0, CARD_LIMIT)
  if (groups.size === 0 && jobs.length === 0) return { work: false, ready: [], states: [], deferred: false, prs: new Set() }
  const ready = []
  const states = []
  let unfinished = false
  let deferredWork = false
  let next = 0
  let start = 0
  const cursorJob = jobs[0]
  if (cursorJob !== undefined) {
    const bytes = await readTaskContextFile(env, store, cursorJob, "publication.json")
    if (bytes !== null) {
      if (bytes.length > 256) throw new Error("context_publication_cursor_invalid")
      let value
      try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("context_publication_cursor_invalid") }
      if (!isPlainObject(value) || Object.keys(value).sort().join() !== "cursor,schema" ||
          value.schema !== "desk.factory.context-publication-cursor/1" || !Number.isSafeInteger(value.cursor) ||
          value.cursor < 0 || value.cursor >= CARD_LIMIT) throw new Error("context_publication_cursor_invalid")
      start = value.cursor % jobs.length
    }
  }
  // Alternate first use of the whole shared turn; a valid unit may need more than half.
  const first = await planningTurn(env, store)
  let prepared = { prepared: 0, deferred: [] }
  const prepare = async () => {
    if (clock() < limit) {
      try {
        prepared = await prepareContextGroups(env, {
          store, pluginVersion, deadline: limit, clock, ...readers,
        }, [...groups.values()])
      } catch (error) {
        if (!["context_preparation_deferred", "boot_check_budget", "git_deadline"].includes(error.code)) throw error
        deferredWork = true
      }
    } else {
      deferredWork = true
    }
  }
  if (first === "prepare") await prepare()
  const publicationLimit = limit
  for (let offset = 0; offset < jobs.length; offset += 1) {
    const index = (start + offset) % jobs.length
    next = index
    if (clock() >= publicationLimit) { deferredWork = true; break }
    const job = jobs[index]
    let state = await stateOf(env, store, job)
    next = (index + 1) % jobs.length
    if (state === null) continue
    if (!await trustedPublication(env, state)) throw new Error("context_publication_receipt_invalid")
    if (state.phase !== "ready" && state.published_sha === null && state.pr === null && state.sent_sha === null) {
      unfinished ||= ["candidate", "privacy"].includes(state.phase)
      states.push({ state, withdrawn: false })
      continue
    }
    const input = await inputOf(env, store, state, { current: false })
    if (input === null) continue
    if (clock() >= publicationLimit) { next = states.length === 0 ? next : index; deferredWork = true; break }
    const route = declared(input.desk_root)
    const permission = contextPermission(input.desk_root, store)
    const withdrawn = isFolder(input.desk_root) && route.kind === "store" &&
      (!sameStore(route.store, store) || permission === "not_opted_in")
    let item = !withdrawn && groups.has(job) ? await readyContext(env, store, state, groups.get(job), input) : null
    if (item === null && !withdrawn && state.published_sha !== null && groups.has(job) && clock() < publicationLimit) {
      try {
        await prepareTaskContexts(env, {
          store, entries: groups.get(job).entries, pluginVersion, deadline: publicationLimit, clock, ...readers,
        })
        state = await stateOf(env, store, job)
        if (state !== null) item = await readyContext(env, store, state, groups.get(job))
      } catch (error) {
        if (!["context_preparation_deferred", "boot_check_budget", "git_deadline"].includes(error.code)) throw error
        deferredWork = true
      }
    }
    if (state === null) continue
    if (clock() >= publicationLimit) { deferredWork = true; break }
    states.push({ state, withdrawn })
    if (item !== null) ready.push(item)
    if (ready.length >= 8 && offset + 1 < jobs.length) { deferredWork = true; break }
  }
  if (cursorJob !== undefined && (deferredWork || start !== 0)) {
    await writeTaskContextFile(env, store, cursorJob, "publication.json", {
      schema: "desk.factory.context-publication-cursor/1", cursor: next,
    })
  }
  if (first === "publish") await prepare()
  const cached = (await readStatus(env)).context_publication?.[store]
  const held = Number.isFinite(cached?.hold_until) && cached.hold_until > now
  const stale = !Number.isFinite(Date.parse(cached?.checked_at)) || now - Date.parse(cached.checked_at) > DAY_MS
  const prPending = states.some(({ state }) => Number.isSafeInteger(state.pr))
  const retracting = states.some(({ state, withdrawn }) => withdrawn && state.published_sha !== null)
  const unsent = ready.some((item) => states.some(({ state }) => state.job === item.job &&
    state.published_sha !== item.sha && !(Number.isFinite(state.hold_until) && state.hold_until > now)))
  unfinished ||= states.some(({ state }) => ["candidate", "privacy"].includes(state.phase))
  return { work: prPending || retracting || (!held && (unsent || (stale && (unfinished || prepared.prepared > 0)))), ready, states, deferred: deferredWork || prepared.deferred.length > 0, prs: new Set(states.map(({ state }) => state.pr).filter(Number.isSafeInteger)) }
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
export async function prepareContextPublication(env, { store, plan, client, ref, direct, now, readMain, pendingPr = null, entries }) {
  if (!plan.work && !Number.isSafeInteger(pendingPr)) return []
  const ready = direct && await storeAcceptsContext(client, store, ref)
  await publicationStatus(env, store, { ready, checked_at: new Date(now).toISOString(), hold_until: ready ? null : now + DAY_MS, code: ready ? null : direct ? "context_store_not_ready" : "context_authority_unavailable" })
  const main = await readMain()
  if (main.unknown) {
    await publicationStatus(env, store, { hold_until: now + DAY_MS, code: "context_main_unknown" })
    return []
  }
  const items = []
  const pending = []
  if (Number.isSafeInteger(pendingPr)) {
    for (const job of (await listTaskContextJobs(env, store)).slice(0, CARD_LIMIT)) {
      const state = await stateOf(env, store, job)
      if (state?.pr === pendingPr) pending.push({ state })
    }
  }
  const groups = pending.length > 0 && entries !== undefined ? groupsOf(entries, store) : null
  for (const entry of pending.length > 0 ? pending : plan.states) {
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
    const item = groups === null ? plan.ready.find((candidate) => candidate.job === state.job)
      : groups.has(state.job) ? await readyContext(env, store, state, groups.get(state.job)) : null
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
  const refusedPrs = plan.refusedPrs ?? new Set(plan.states.map(({ state }) => state.pr).filter(Number.isSafeInteger))
  for (const job of (await listTaskContextJobs(env, store)).slice(0, CARD_LIMIT)) {
    const before = await stateOf(env, store, job)
    if (before === null || !refusedPrs.has(before.pr)) continue
    if (!await trustedPublication(env, before)) throw new Error("context_publication_receipt_invalid")
    const fields = { ...publication(before), pr: null }
    const proof = await seal(env, "publication", job, fields)
    const after = await updateTaskContextState(env, store, job, (state) => {
      if (stableStringify(publication(state)) !== stableStringify(publication(before))) return state
      const cleared = { ...state, ...fields, publication_seal: proof }
      if (state.sent_basis !== state.basis) return cleared
      const refusals = (Number.isSafeInteger(state.refusals) ? state.refusals : 0) + 1
      return { ...cleared, refusals, hold_until: now + DAY_MS, ...(refusals >= 3 ? { phase: "refused", record: null } : {}) }
    })
    if (refusedPrs.has(after.pr)) throw new Error("context_publication_changed")
  }
  await publicationStatus(env, store, { code, hold_until: now + DAY_MS })
}

export async function recordContextError(env, store, code = "context_error") {
  await publicationStatus(env, store, { code })
}

export async function contextPublisherUnavailable(env, store, now) {
  await publicationStatus(env, store, { ready: false, checked_at: new Date(now).toISOString(), hold_until: now + DAY_MS, code: "context_authority_unavailable" })
}
