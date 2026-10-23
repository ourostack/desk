// The compact `desk_status` answer. The full payload runs to tens of KB (index, snapshots, vector packs, admission
// internals) and agents only ever asked "ready or not?" of it, then read `readiness.state: degraded` and
// `startup_fallback.degraded: true` beside an admitted Desk as an outage (boot acceptance round 6).
//
// One health word, the one the session-start boot script's `status` uses: `ready`, `degraded`, `setup_required`, plus
// `admitting` (boot never admits). It says whether Desk works. The search index is a separate word, `search`, that never
// moves `state`: a degraded index only means search reads the files directly. Boot does not check the index at all
// (slow, network-bound), so "boot ready, desk_status ready, search degraded" is one consistent picture, not a contradiction.

import { shellQuote } from "../util/shell-quote.js"
import { healthWord, syncDegradation } from "./health.js"
import { GATE_WAIT_MS } from "./gate-wait.js"

const DETAIL_POINTER =
  "Call desk_status with { detail: true } for the full payload (index, snapshots, vector packs, admission internals), or desk_doctor for diagnostics and repairs."

function stateWord(payload) {
  if (payload.status === "ok") return "ready"
  if (payload.status === "setup_required") return "setup_required"
  if (payload.status === "admitting" || payload.state === "admitting") return "admitting"
  return "degraded"
}

// The wait a tool call allows a running admission before it refuses with `admitting`.
const STARTING_WAIT = `${GATE_WAIT_MS / 1000} s`
const STARTING_FIX = `desk_status and desk_skill answer at once. Every other Desk tool waits up to ${STARTING_WAIT} for startup: task reads and updates and exact-word search (desk_search) need only the desk's files, so they run as soon as startup finishes, and meaning-based search (desk_recall, desk_similar) can take longer to catch up. If startup is still running after ${STARTING_WAIT}, the call is refused with code admitting; retry it then.`
// The admission steps (setPhase / onPhase names) in words an agent can pass on.
const LOADING = "loading Desk"
const STEP_WORDS = {
  resolving_inputs: "finding this session's desk",
  loading_runtime: LOADING,
  inspecting_runtime_pack: LOADING,
  restoring_runtime_dependencies: LOADING,
  waiting_for_publication_lock: LOADING,
  building: LOADING,
  mirroring_source: LOADING,
  importing_runtime: LOADING,
  inspecting_state_branch: "checking the desk's Git branch",
  admitting_authority: "checking write access",
  verifying_authority: "checking write access",
  connecting_controller: "connecting to the search controller",
  checking_semantic_readiness: "waiting for meaning-based search",
}

function startingSummary(admission) {
  const words = Object.hasOwn(STEP_WORDS, admission.phase ?? "") ? STEP_WORDS[admission.phase] : null
  const since = Date.parse(admission.phase_since ?? "")
  const elapsed = Number.isFinite(since) ? `, ${Math.max(0, Math.round((Date.now() - since) / 1000))} s so far` : ""
  return `Desk is still starting${words === null ? "" : ` (${words}${elapsed})`}. Call desk_status again in about ${STARTING_WAIT}.`
}

function line(value) {
  if (typeof value === "string") return value
  if (value !== null && typeof value === "object") return typeof value.message === "string" ? value.message : JSON.stringify(value)
  return String(value)
}

function whyNotReady(payload, syncProblem, ready) {
  const reasons = []
  const add = (value) => {
    if (value === undefined || value === null || value === "") return
    const text = line(value)
    if (!reasons.includes(text)) reasons.push(text)
  }
  add(syncProblem)
  if (ready) return reasons
  add(payload.admission?.summary)
  add(payload.summary)
  for (const blocker of Array.isArray(payload.admission?.blockers) ? payload.admission.blockers : []) add(blocker)
  add(payload.status_error)
  if (payload.root?.valid === false) add(`desk root ${payload.root.path ?? "(none)"}: ${payload.root.diagnostic ?? "not usable"}`)
  if (reasons.length === 0) add(payload.code ?? "Desk is not ready")
  return reasons
}

function syncLine(sync) {
  if (typeof sync === "string") return sync
  if (sync === null || typeof sync !== "object") return null
  if (syncDegradation(sync.last_pull) !== null) return `last pull failed${sync.last_pull.cause ? ` (${sync.last_pull.cause})` : ""}: not known to be in sync`
  if (sync.blocked === true) return `blocked${sync.reason ? ` (${sync.reason})` : ""}`
  if (sync.behind > 0) return `${sync.behind} commit(s) behind origin`
  if (sync.ahead > 0) return `${sync.ahead} commit(s) ahead of origin, not pushed yet`
  return "in sync"
}

function notesFor(payload, search) {
  const notes = []
  if (search === "degraded" || search === "unavailable") {
    const message = payload.readiness?.detail?.convergence?.diagnostic?.message
    notes.push(`Search index ${search}${message ? ` (${line(message)})` : ""}: search reads the files directly and every other tool still works. Mention it only if the work needs search.`)
  }
  const sync = typeof payload.sync === "object" && payload.sync !== null ? payload.sync : null
  if (sync?.blocked === true) notes.push(`Pushing the desk is blocked${sync.reason ? ` (${sync.reason})` : ""}.`)
  // The latest thing Desk repaired by itself in this session (at its start, the checkout switched back to the state branch, for example), in the repair log's own words: the agent was not there to see it.
  if (typeof payload.repair === "string") notes.push(payload.repair)
  return notes
}

// A diagnostic that is not ready carries what the agent must act on (the onboarding remediation, the binding path, the
// paths tried); those payloads are small, so the keys are passed through whole.
const DIAGNOSTIC_KEYS = ["mode", "reason", "reason_detail", "binding_path", "paths_tried", "remediation"]

const DETAIL_PENDING_SUMMARY = "Desk is ready, but its details (root, search, sync) are still loading, so the empty fields below are not a missing desk. Call desk_status again shortly."
// The usual first answer of a session: the desk the session admitted is already named, and only the runtime's own detail is still to come.
const DETAIL_PENDING_ROOTED_SUMMARY = "Desk is ready, but its details (search, sync) are still loading, so the empty fields below are not a fault. Call desk_status again shortly."

// The first line of a runtime status error, at most 200 characters, so a stack or a long message never fills the answer.
function errorLine(error) {
  const first = error.trim().split(/\r?\n/u)[0].trim()
  if (first === "") return "unknown error"
  return first.length > 200 ? `${first.slice(0, 199)}…` : first
}

const statusErrorSummary = (error) => `Desk is ready, but its runtime status failed (${error}), so the empty fields below (root, search, sync) are not a missing desk. Call desk_status again; if it fails the same way, call desk_doctor.`
const NO_DETAIL_SUMMARY = "Desk is ready, but this answer carries no runtime detail (the runtime is not loaded, or Desk is in refuse mode), so the empty root, search and sync fields below are not a missing desk. Call desk_doctor to see why."

/** The compact answer for a full desk_status payload (already merged with the admission fields). */
export function compactStatus(payload) {
  const syncProblem = syncDegradation(payload.sync?.last_pull)
  const base = stateWord(payload)
  // A desk that is otherwise ready is degraded by a failed sync, exactly as the boot script reports it.
  const state = base === "ready" ? healthWord(syncProblem === null ? [] : [syncProblem]) : base
  const search = payload.readiness?.state ?? "not_checked"
  // Only the session's first admission is a start; a desk that re-admits after a change keeps its own summary and fix.
  const starting = base === "admitting" && payload.admission?.starting === true
  // Desk is ready, but the runtime's status detail missed this call's short budget: the root, search and sync fields below are empty because they are not loaded yet, not because there is no desk.
  const detailPending = state === "ready" && payload.detail_pending === true
  // The other ways a ready desk answers without its root, each with its own cause, so the empty fields are never read as "no desk".
  const statusError = state === "ready" && typeof payload.status_error === "string" ? errorLine(payload.status_error) : null
  const noDetail = state === "ready" && !detailPending && statusError === null && !payload.root?.path
  const readySummary = detailPending ? (payload.root?.path ? DETAIL_PENDING_ROOTED_SUMMARY : DETAIL_PENDING_SUMMARY) : statusError !== null ? statusErrorSummary(statusError) : noDetail ? NO_DETAIL_SUMMARY : "Desk is ready."
  const compact = {
    state,
    summary: state === "ready" ? readySummary : starting ? startingSummary(payload.admission) : (base === "ready" ? "Desk works, but the last sync failed." : (payload.admission?.summary ?? payload.summary ?? "Desk is not ready.")),
    degraded: state === "ready" ? [] : whyNotReady(payload, syncProblem, base === "ready"),
    ...(state === "ready" || !payload.code ? {} : { code: payload.code }),
    ...(state === "ready" ? {} : starting ? { fix: STARTING_FIX } : base === "ready" ? { fix: `Retry the sync: git -C ${shellQuote(payload.root?.path ?? "<desk>")} pull --rebase --autostash. Work continues on local state until it succeeds.` } : (payload.fix ? { fix: payload.fix } : {})),
    ...(typeof payload.onboarding_skill === "string" ? { onboarding_skill: payload.onboarding_skill } : {}),
    ...(state === "ready" ? {} : Object.fromEntries(DIAGNOSTIC_KEYS.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]))),
    ...(payload.activation?.selected_id ? { activation: { selected_id: payload.activation.selected_id, chain: payload.activation.chain ?? [] } } : {}),
    search,
    notes: notesFor(payload, search),
    ...(detailPending ? { detail_pending: true } : {}),
    ...(statusError === null ? {} : { status_error: statusError }),
    root: { path: payload.root?.path ?? null, source: payload.root?.source ?? null },
    // The person a migration or a person-scoped write needs (`--tools-person`); null for a single-person desk.
    write_scope: { mode: payload.write_scope?.mode ?? null, person: payload.write_scope?.person ?? null },
    sync: syncLine(payload.sync),
    plugin_version: payload.runtime?.plugin?.version ?? null,
    ...(payload.status_detail === undefined ? {} : { status_detail: payload.status_detail }),
    detail: DETAIL_POINTER,
  }
  return compact
}
