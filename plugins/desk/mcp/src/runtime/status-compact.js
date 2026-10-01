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

const DETAIL_POINTER =
  "Call desk_status with { detail: true } for the full payload (index, snapshots, vector packs, admission internals), or desk_doctor for diagnostics and repairs."

function stateWord(payload) {
  if (payload.status === "ok") return "ready"
  if (payload.status === "setup_required") return "setup_required"
  if (payload.status === "admitting" || payload.state === "admitting") return "admitting"
  return "degraded"
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
  if (payload.host_enforcement?.registered === false) notes.push("The host's deny hook is not registered: see desk_status with { detail: true } (`host_enforcement`).")
  return notes
}

// A diagnostic that is not ready carries what the agent must act on (the onboarding remediation, the binding path, the
// paths tried); those payloads are small, so the keys are passed through whole.
const DIAGNOSTIC_KEYS = ["mode", "reason", "reason_detail", "binding_path", "paths_tried", "remediation"]

/** The compact answer for a full desk_status payload (already merged with the admission fields). */
export function compactStatus(payload) {
  const syncProblem = syncDegradation(payload.sync?.last_pull)
  const base = stateWord(payload)
  // A desk that is otherwise ready is degraded by a failed sync, exactly as the boot script reports it.
  const state = base === "ready" ? healthWord(syncProblem === null ? [] : [syncProblem]) : base
  const search = payload.readiness?.state ?? "not_checked"
  const compact = {
    state,
    summary: state === "ready" ? "Desk is ready." : (base === "ready" ? "Desk works, but the last sync failed." : (payload.admission?.summary ?? payload.summary ?? "Desk is not ready.")),
    degraded: state === "ready" ? [] : whyNotReady(payload, syncProblem, base === "ready"),
    ...(state === "ready" || !payload.code ? {} : { code: payload.code }),
    ...(state === "ready" ? {} : base === "ready" ? { fix: `Retry the sync: git -C ${shellQuote(payload.root?.path ?? "<desk>")} pull --rebase --autostash. Work continues on local state until it succeeds.` } : (payload.fix ? { fix: payload.fix } : {})),
    ...(typeof payload.onboarding_skill === "string" ? { onboarding_skill: payload.onboarding_skill } : {}),
    ...(state === "ready" ? {} : Object.fromEntries(DIAGNOSTIC_KEYS.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]))),
    ...(payload.activation?.selected_id ? { activation: { selected_id: payload.activation.selected_id, chain: payload.activation.chain ?? [] } } : {}),
    search,
    notes: notesFor(payload, search),
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
