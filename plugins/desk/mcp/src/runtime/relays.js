// Relays: small GitHub automations the always-on runtime runs for a repository whose own settings cannot (or not yet) do the job.
// A `dispatch` relay watches a workflow and fires another workflow or a repository_dispatch event once per new watched head whose
// run succeeds, after a quiet period for a newer head. A
// `merge-when-green` relay merges a labelled pull request once every check it names is green on its head and, if asked, the base
// branch's latest completed run of a workflow is green. Like `drains.js poll`, no model turn is spent: each poll reads GitHub
// with conditional requests (an unchanged answer is a free 304) and acts. See docs/relays.md.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { drainsHome, quotaHold, readDrainConfig, readDrainStates } from "./drains.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const DEFAULT_EVERY_SECONDS = 30
const MIN_EVERY_SECONDS = 10
/** A runner that fires every 30 s jitters, so a relay is due a little before its interval has fully passed. */
const DUE_SLACK_MS = 5_000
const HANDLED_KEPT = 200
/** A dispatch fires once the newest successful run on a new head has been the newest for this long. */
const DEFAULT_SETTLE_SECONDS = 60
const MAX_SETTLE_SECONDS = 3600
const HISTORY = 50
const MERGED_KEPT = 20
/** A refused merge is tried again after this long, or at once when the head changes. */
const REFUSED_MS = 5 * 60_000
/** A status comment that only reports progress is edited at most this often; the merge always updates it. */
const COMMENT_MS = 2 * 60_000
const CHECKS_PAGE = 100
const COMMENT_PAGES = 5
const TYPES = ["dispatch", "merge-when-green"]
const METHODS = ["squash", "merge", "rebase"]
const RUN_FIELDS = ["id", "head_sha", "head_branch", "html_url", "run_number"]
const PLACEHOLDER = /\{\{\s*run\.(\w+)\s*\}\}/gu

export function relayPaths(options) {
  const home = drainsHome(options)
  return { config: path.join(home, "relays.json"), state: path.join(home, "relays-state.json"), lock: path.join(home, "relays.lock") }
}

function problem(code, thing, probably, look, fix) {
  return new Error(deskFailure({ code, thing, probably, look, keepWorking: "no relay fired or merged and no marker moved", fix }))
}

// ── Config ──

const isText = (value) => typeof value === "string" && value.trim() !== ""
const textList = (value) => Array.isArray(value) && value.length > 0 && value.every(isText)
const isRepo = (value) => typeof value === "string" && /^[\w.-]+\/[\w.-]+$/u.test(value)
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function checkValues(values, where, bad) {
  if (!isObject(values)) throw bad(`${where} is not an object`)
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") throw bad(`${where}.${key} is not text`)
    for (const [, field] of value.matchAll(PLACEHOLDER)) if (!RUN_FIELDS.includes(field)) throw bad(`${where}.${key} names {{run.${field}}}; use one of ${RUN_FIELDS.map((name) => `{{run.${name}}}`).join(", ")}`)
  }
}

/** The relays in a config file's text, validated. A bad entry is an error, never a silent drop: a dropped relay would stop a deploy or a merge. */
export function parseRelayConfig(raw, file) {
  const bad = (what) => problem("desk_relays_config_invalid", "relays config", `${file} ${what}, probably a hand edit`, "open the file and compare it with docs/relays.md", "correct the entry and run the command again")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw bad("is not valid JSON")
  }
  const list = isObject(parsed) ? parsed.relays : undefined
  if (!Array.isArray(list)) throw bad('has no "relays" array')
  const names = new Set()
  return list.map((entry, index) => {
    const at = `relays[${index}]`
    if (!isObject(entry)) throw bad(`${at} is not an object`)
    const { name, type, account, everySeconds } = entry
    if (typeof name !== "string" || !/^\w[\w .-]*$/u.test(name.trim())) throw bad(`${at}.name is not a name (letters, digits, spaces, "." and "-")`)
    if (names.has(name.trim())) throw bad(`${at} reuses the name ${name.trim()}`)
    names.add(name.trim())
    if (!TYPES.includes(type)) throw bad(`${at}.type is not ${TYPES.map((value) => JSON.stringify(value)).join(" or ")}`)
    if (account !== undefined && !isText(account)) throw bad(`${at}.account is not a GitHub login`)
    if (everySeconds !== undefined && (!Number.isInteger(everySeconds) || everySeconds < MIN_EVERY_SECONDS)) throw bad(`${at}.everySeconds is not a whole number of seconds, ${MIN_EVERY_SECONDS} or more`)
    const common = { name: name.trim(), type, ...(account === undefined ? {} : { account: account.trim() }), everySeconds: everySeconds ?? DEFAULT_EVERY_SECONDS }
    if (type === "dispatch") return { ...common, ...parseDispatch(entry, at, bad) }
    return { ...common, ...parseMerge(entry, at, bad) }
  })
}

function parseDispatch({ watch, fire, settleSeconds }, at, bad) {
  if (settleSeconds !== undefined && (!Number.isInteger(settleSeconds) || settleSeconds < 0 || settleSeconds > MAX_SETTLE_SECONDS)) throw bad(`${at}.settleSeconds is not a whole number of seconds, from 0 to ${MAX_SETTLE_SECONDS}`)
  if (!isObject(watch) || !isRepo(watch.repo) || !isText(watch.workflow)) throw bad(`${at}.watch needs "repo" (owner/name) and "workflow" (a file name such as ci.yml)`)
  if (watch.branch !== undefined && !isText(watch.branch)) throw bad(`${at}.watch.branch is not a branch name`)
  if (watch.conclusion !== undefined && watch.conclusion !== "success") throw bad(`${at}.watch.conclusion is not "success", the only conclusion that fires`)
  if (!isObject(fire) || !isRepo(fire.repo)) throw bad(`${at}.fire needs "repo" (owner/name)`)
  if (isText(fire.workflow) === isText(fire.event)) throw bad(`${at}.fire needs exactly one of "workflow" (a workflow_dispatch target) or "event" (a repository_dispatch type)`)
  if (fire.ref !== undefined && !isText(fire.ref)) throw bad(`${at}.fire.ref is not a branch name`)
  if (fire.inputs !== undefined) checkValues(fire.inputs, `${at}.fire.inputs`, bad)
  if (fire.inputs !== undefined && isText(fire.event)) throw bad(`${at}.fire.inputs only goes with "workflow"; a repository_dispatch event carries the run's details in client_payload`)
  return {
    watch: { repo: watch.repo, workflow: watch.workflow.trim(), ...(watch.branch === undefined ? {} : { branch: watch.branch.trim() }), conclusion: "success" },
    fire: { repo: fire.repo, ...(isText(fire.workflow) ? { workflow: fire.workflow.trim() } : { event: fire.event.trim() }), ...(fire.ref === undefined ? {} : { ref: fire.ref.trim() }), ...(fire.inputs === undefined ? {} : { inputs: fire.inputs }) },
    settleSeconds: settleSeconds ?? DEFAULT_SETTLE_SECONDS,
  }
}

function parseMerge({ repo, label, method, deleteBranch, requiredChecks, requireMainWorkflowGreen, skippedPasses }, at, bad) {
  if (!isRepo(repo)) throw bad(`${at}.repo is not "owner/name"`)
  if (label !== undefined && !isText(label)) throw bad(`${at}.label is not a label name`)
  if (method !== undefined && !METHODS.includes(method)) throw bad(`${at}.method is not "squash", "merge" or "rebase"`)
  if (deleteBranch !== undefined && typeof deleteBranch !== "boolean") throw bad(`${at}.deleteBranch is not true or false`)
  if (!textList(requiredChecks)) throw bad(`${at}.requiredChecks is not a non-empty list of check names (a "*" matches any text)`)
  if (requireMainWorkflowGreen !== undefined && !isText(requireMainWorkflowGreen)) throw bad(`${at}.requireMainWorkflowGreen is not a workflow file name such as ci.yml`)
  if (skippedPasses !== undefined && typeof skippedPasses !== "boolean") throw bad(`${at}.skippedPasses is not true or false`)
  return {
    repo,
    label: (label ?? "merge-when-green").trim(),
    method: method ?? "squash",
    deleteBranch: deleteBranch ?? true,
    requiredChecks: requiredChecks.map((check) => check.trim()),
    ...(requireMainWorkflowGreen === undefined ? {} : { requireMainWorkflowGreen: requireMainWorkflowGreen.trim() }),
    ...(skippedPasses === undefined ? {} : { skippedPasses }),
  }
}

export function readRelayConfig(file) {
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw problem("desk_relays_config_unreadable", "relays config", `${file} cannot be read (${error.code}), probably because its owner or permissions changed`, "check the file's permissions", "fix them and run the command again")
    return []
  }
  return parseRelayConfig(raw, file)
}

// ── State ──

export function readRelayStates(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeRelayStates(file, states) {
  assertNotRealStateUnderTest(path.dirname(file))
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`)
  renameSync(temporary, file)
}

function note(state, now, event) {
  state.history = [...state.history, { at: new Date(now).toISOString(), ...event }].slice(-HISTORY)
}

// ── GitHub reads ──

/**
 * One conditional read. `reduce` turns the body into the small value kept in the state next to the ETag, so a 304 (which costs
 * nothing against the quota) still hands back what the last answer meant. A value marked `volatile` is never cached.
 */
async function cached(ctx, state, route, reduce) {
  const hit = state.cache[route]
  ctx.touched.add(route)
  const answer = await ctx.api.get(route, { etag: hit?.etag })
  if (answer.notModified) return hit.value
  const value = await reduce(answer.body)
  if (value?.volatile) delete state.cache[route]
  else state.cache[route] = { etag: answer.etag, value }
  return value
}

const forget = (state, touched) => {
  for (const route of Object.keys(state.cache)) if (!touched.has(route)) delete state.cache[route]
}

const globPattern = (pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u")

const httpProblem = (action, repo, response) => Object.assign(new Error(`Check that the relay's account can ${action} in ${repo}, then try again: GitHub answered HTTP ${response.status}${response.body?.message ? ` (${response.body.message})` : ""}`), { code: "relays_check_the_account_can", status: response.status })

// ── dispatch ──

const runSummary = (run) => ({ id: run.id, head_sha: run.head_sha, head_branch: run.head_branch, html_url: run.html_url, run_number: run.run_number })

const render = (text, run) => text.replace(PLACEHOLDER, (_, field) => String(run[field]))

async function fireDispatch(ctx, state, relay, run) {
  const { fire } = relay
  if (fire.workflow) {
    const ref = fire.ref ?? (await cached(ctx, state, `/repos/${fire.repo}`, (body) => body.default_branch))
    const inputs = fire.inputs ? Object.fromEntries(Object.entries(fire.inputs).map(([key, value]) => [key, render(value, run)])) : undefined
    const response = await ctx.api.send("POST", `/repos/${fire.repo}/actions/workflows/${encodeURIComponent(fire.workflow)}/dispatches`, { ref, ...(inputs ? { inputs } : {}) })
    if (!response.ok) throw httpProblem(`dispatch ${fire.workflow}`, fire.repo, response)
    return `${fire.repo} ${fire.workflow}`
  }
  const response = await ctx.api.send("POST", `/repos/${fire.repo}/dispatches`, { event_type: fire.event, client_payload: { relay: relay.name, run_id: run.id, run_url: run.html_url, head_sha: run.head_sha, head_branch: run.head_branch } })
  if (!response.ok) throw httpProblem(`send the ${fire.event} event`, fire.repo, response)
  return `${fire.repo} ${fire.event}`
}

/**
 * Records the fresh runs. The newest one on a head the relay has not fired for becomes the pending fire; a newer head restarts the
 * quiet period, and another run on the same head only updates which run is named. A head the relay fired for, or passed over for a
 * newer one, is remembered, so a second event's run that finishes on it later never fires it again, and never after a newer head.
 */
function recordHead(state, ctx, fresh) {
  const finished = new Set([state.lastFire?.headSha, ...(state.firedHeads ?? []), ...(state.passedOver ?? [])])
  const eligible = fresh.filter((run) => !finished.has(run.head_sha))
  const candidate = eligible.reduce((best, run) => (best === undefined || run.id > best.id ? run : best), undefined)
  if (!candidate) return
  const pending = state.pending
  const runs = (pending?.runs ?? 0) + fresh.length
  const now = new Date(ctx.now).toISOString()
  if (!pending) state.pending = { at: now, run: candidate, runs }
  else if (candidate.id < pending.run.id) state.pending = { ...pending, runs }
  else state.pending = { at: candidate.head_sha === pending.run.head_sha ? pending.at : now, run: candidate, runs }
  const passed = [pending?.run.head_sha, ...eligible.map((run) => run.head_sha)].filter((sha) => sha && sha !== state.pending.run.head_sha)
  if (passed.length > 0) state.passedOver = [...new Set([...(state.passedOver ?? []), ...passed])].slice(-HANDLED_KEPT)
}

/**
 * Fires once per watched head: a successful run on a head the relay has already fired for, or passed over for a newer one, is
 * remembered and never fires again, so a restart does not either. A run on a new head waits `settleSeconds` for a newer head, then fires once for the newest one. The first
 * poll only records the runs that already succeeded.
 */
async function runDispatch(relay, state, ctx) {
  const { watch } = relay
  const route = `/repos/${watch.repo}/actions/workflows/${encodeURIComponent(watch.workflow)}/runs?status=success&per_page=30&exclude_pull_requests=true${watch.branch ? `&branch=${encodeURIComponent(watch.branch)}` : ""}`
  const runs = await cached(ctx, state, route, (body) => body.workflow_runs.filter((run) => run.status === "completed" && run.conclusion === "success").map(runSummary))
  state.waitingOn = `the next successful ${watch.workflow} run${watch.branch ? ` on ${watch.branch}` : ""}`
  if (!state.seeded) {
    state.handled = runs.map((run) => run.id)
    state.seeded = true
    note(state, ctx.now, { event: "seeded", runs: runs.length })
    return
  }
  const handled = new Set(state.handled)
  const fresh = runs.filter((run) => !handled.has(run.id))
  if (fresh.length > 0) {
    state.handled = [...state.handled, ...fresh.map((run) => run.id)].slice(-HANDLED_KEPT)
    recordHead(state, ctx, fresh)
  }
  const { pending } = state
  if (!pending) return
  const { head_sha: sha, id } = pending.run
  if (ctx.now < Date.parse(pending.at) + relay.settleSeconds * 1000) {
    state.waitingOn = `${relay.settleSeconds}s with no newer successful ${watch.workflow} run on a new head, then a fire for head ${short(sha)} (run ${id})`
    return
  }
  if (state.retryAt && ctx.now < Date.parse(state.retryAt)) {
    state.waitingOn = `a fire GitHub refused, to be tried again after ${state.retryAt}`
    return
  }
  let target
  try {
    target = await fireDispatch(ctx, state, relay, pending.run)
  } catch (error) {
    state.retryAt = new Date(ctx.now + REFUSED_MS).toISOString()
    throw error
  }
  delete state.retryAt
  delete state.pending
  state.firedHeads = [...(state.firedHeads ?? []), sha].slice(-HANDLED_KEPT)
  state.lastFire = { at: new Date(ctx.now).toISOString(), runId: id, runUrl: pending.run.html_url, headSha: sha, runs: pending.runs, target }
  note(state, ctx.now, { event: "fired", runId: id, headSha: sha, runs: pending.runs, target })
  ctx.save()
}

// ── merge-when-green ──

const pullSummary = (body) => ({
  state: body.state,
  draft: Boolean(body.draft),
  headSha: body.head?.sha,
  headRef: body.head?.ref,
  headRepo: body.head?.repo?.full_name ?? null,
  baseRef: body.base?.ref,
  baseRepo: body.base?.repo?.full_name,
  mergeable: body.mergeable ?? null,
  mergeableState: body.mergeable_state,
  labels: body.labels.map((label) => label.name),
})

const checkSummary = (run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion ?? null, startedAt: run.started_at ?? null })

/** GitHub keeps every attempt of a check on a head, and the newest attempt of each name is the one that counts, as branch rules judge it. */
function latestCheckRuns(runs) {
  const newest = new Map()
  for (const run of runs) {
    const kept = newest.get(run.name)
    if (!kept || compareAttempts(run, kept) >= 0) newest.set(run.name, run)
  }
  return [...newest.values()]
}

/** Orders attempts by start time, then by id; an attempt with neither (a plain list) comes later in the list. */
const compareAttempts = (a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || (a.id ?? 0) - (b.id ?? 0)

/** The head's check runs. More than a page cannot be told apart by the first page's ETag, so that answer is read in full every poll. */
async function readChecks(ctx, state, repo, sha) {
  const route = `/repos/${repo}/commits/${sha}/check-runs?per_page=${CHECKS_PAGE}`
  // A cached read from before check runs kept their ids and start times cannot tell the newest attempt, so it is read again.
  if (state.cache[route]?.value.runs.some((run) => run.id === undefined)) delete state.cache[route]
  return cached(ctx, state, route, async (body) => {
    const runs = [...body.check_runs]
    for (let page = 2; page <= Math.ceil(body.total_count / CHECKS_PAGE); page++) runs.push(...(await ctx.api.get(`/repos/${repo}/commits/${sha}/check-runs?per_page=${CHECKS_PAGE}&page=${page}`)).body.check_runs)
    return { runs: runs.map(checkSummary), volatile: body.total_count > CHECKS_PAGE }
  })
}

/** The head's commit statuses, newest per context, as the combined status lists them. A `pending` or `error` state is not green, and an empty list is not a verdict. */
async function readStatuses(ctx, state, repo, sha) {
  const route = `/repos/${repo}/commits/${sha}/status?per_page=${CHECKS_PAGE}`
  return cached(ctx, state, route, async (body) => {
    const statuses = [...(body.statuses ?? [])]
    for (let page = 2; page <= Math.ceil((body.total_count ?? 0) / CHECKS_PAGE); page++) statuses.push(...((await ctx.api.get(`${route}&page=${page}`)).body.statuses ?? []))
    return { statuses: statuses.map((status) => ({ context: status.context, state: status.state })), volatile: (body.total_count ?? 0) > CHECKS_PAGE }
  })
}

/** A commit status judged like a check run: `success` is green, `pending` is still running, and `failure` and `error` are red. */
const statusAsRun = (status) => ({ name: status.context, status: status.state === "pending" ? "in_progress" : "completed", conclusion: status.state === "pending" ? null : status.state === "success" ? "success" : "failure" })

// Only completed runs are asked for, so a queued or in-progress run of the workflow is never the one judged.
const readMain = (ctx, state, repo, workflow, branch) =>
  cached(ctx, state, `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1&exclude_pull_requests=true`, (body) => {
    const run = body.workflow_runs?.[0]
    return run ? { id: run.id, conclusion: run.conclusion, url: run.html_url } : null
  })

const shown = (runs) => `${runs.slice(0, 3).map((run) => `${run.name} ${run.status === "completed" ? run.conclusion : run.status}`).join(", ")}${runs.length > 3 ? `, and ${runs.length - 3} more` : ""}`

/** The conclusions a `skippedPasses` relay also accepts. Every other conclusion, and a check still running, keeps the pull request waiting. */
const SKIPPED_PASSES = new Set(["skipped", "neutral"])

/**
 * GitHub posts a matrix job that is skipped before it expands under its literal template name, such as `npm test (${{ matrix.os }}, ...)`.
 * A skipped check like that matches every required pattern that starts with the text before its first `${{`.
 */
const skippedTemplateMatches = (run, required) => {
  const at = run.name.indexOf("${{")
  return run.conclusion === "skipped" && at > 0 && required.startsWith(run.name.slice(0, at))
}

/** An unexpanded matrix template that GitHub skipped stands in for a matrix that never ran; it says nothing once the matrix ran under expanded names. */
const isTemplateSkip = (run) => run.conclusion === "skipped" && run.name.includes("${{")

/**
 * What still keeps the head from merging, as one line per entry that is not fully green. Only the newest attempt of each check counts, and it counts only
 * when it completed with `success`, or with `skipped` or `neutral` when `skippedPasses` is set. Each required pattern must also match something.
 * Every other check run and commit status on the head must be green too: a check that is not required (a path-filtered one, say) still blocks while it fails or runs, whatever `skippedPasses` says.
 * Only a required check needs `skippedPasses` for a skip: a skipped or neutral check that nothing requires never holds the head.
 */
export function waitingOnChecks(requiredChecks, runs, skippedPasses = false, statuses = []) {
  const green = (run) => run.status === "completed" && (run.conclusion === "success" || (skippedPasses && SKIPPED_PASSES.has(run.conclusion)))
  const newest = [...latestCheckRuns(runs), ...statuses.map(statusAsRun)]
  const counted = new Set()
  const required = requiredChecks.flatMap((required) => {
    const found = newest.filter((run) => globPattern(required).test(run.name) || skippedTemplateMatches(run, required))
    const expanded = found.filter((run) => !isTemplateSkip(run))
    const matching = expanded.length > 0 ? expanded : found
    for (const run of found) counted.add(run)
    if (matching.length === 0) return [`${required}: not started`]
    const notGreen = matching.filter((run) => !green(run))
    return notGreen.length === 0 ? [] : [`${required}: ${notGreen.length === matching.length && matching.length === 1 ? shown(notGreen) : `${notGreen.length} of ${matching.length} not green (${shown(notGreen)})`}`]
  })
  // A check nobody required that a path filter skipped says nothing against the head, so only a failure, a cancellation or a run still going holds it.
  const others = newest.filter((run) => !counted.has(run) && !green(run) && !(run.status === "completed" && SKIPPED_PASSES.has(run.conclusion)))
  return others.length === 0 ? required : [...required, `${others.length} other check${others.length === 1 ? "" : "s"} on the head not green (${shown(others)})`]
}

const MERGEABLE = new Set(["clean", "unstable", "has_hooks"])

function waitingOnPull(pr) {
  if (pr.draft) return ["it is a draft"]
  if (pr.mergeable === false || pr.mergeableState === "dirty") return ["it has merge conflicts"]
  if (pr.mergeable === null || pr.mergeableState === "unknown") return ["GitHub has not yet worked out whether it merges cleanly"]
  if (pr.mergeableState === "behind") return [`it is behind ${pr.baseRef}`]
  if (!MERGEABLE.has(pr.mergeableState)) return [`GitHub reports it as ${pr.mergeableState}, so the branch rules do not let it merge`]
  return []
}

async function findComment(api, repo, number, marker, login) {
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const { body, next } = await api.get(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)
    const own = body.find((comment) => comment.body?.includes(marker) && (!login || comment.user?.login?.toLowerCase() === login.toLowerCase()))
    if (own) return own.id
    if (!next) break
  }
  return null
}

/** Keeps one marked comment per pull request and relay, edited in place; progress-only edits wait `COMMENT_MS`, a merge never does. */
async function writeStatus(ctx, relay, number, record, text, { final }) {
  if (record.commentText === text) return
  if (!final && record.commentId && ctx.now - Date.parse(record.commentAt) < COMMENT_MS) return
  const marker = `<!-- desk-relay-status:${relay.name} -->`
  const body = `${marker}\n${text}`
  let id = record.commentId ?? (await findComment(ctx.api, relay.repo, number, marker, ctx.api.login))
  if (id) {
    const response = await ctx.api.send("PATCH", `/repos/${relay.repo}/issues/comments/${id}`, { body })
    if (response.status === 404) id = null
    else if (!response.ok) throw httpProblem("edit its status comment", relay.repo, response)
  }
  if (!id) {
    const response = await ctx.api.send("POST", `/repos/${relay.repo}/issues/${number}/comments`, { body })
    if (!response.ok) throw httpProblem("comment on the pull request", relay.repo, response)
    id = response.body.id
  }
  Object.assign(record, { commentId: id, commentText: text, commentAt: new Date(ctx.now).toISOString() })
}

const short = (sha) => String(sha).slice(0, 7)
const waitingText = (relay, pr, waiting) => `**${relay.label}** has not merged this yet (head \`${short(pr.headSha)}\`). Waiting on:\n${waiting.map((line) => `- ${line}`).join("\n")}\n\nThis comment is edited as that changes.`
const mergedText = (relay, pr, sha, deleted, judged) => `**${relay.label}** merged this (${relay.method}, head \`${short(pr.headSha)}\`, now \`${short(sha)}\`). Every check and status on the head was green${judged ? ` and ${judged.branch}'s latest completed ${relay.requireMainWorkflowGreen} run ${judged.id} (${judged.url}) was green` : ""}${deleted ? "; the branch is deleted" : ""}.`

async function deleteBranch(ctx, relay, pr) {
  if (!relay.deleteBranch || !pr.headRepo || pr.headRepo.toLowerCase() !== pr.baseRepo.toLowerCase() || pr.headRef === pr.baseRef) return false
  const response = await ctx.api.send("DELETE", `/repos/${relay.repo}/git/refs/heads/${pr.headRef.split("/").map(encodeURIComponent).join("/")}`)
  // 404 and 422 mean the branch is already gone (the repository may delete it on merge).
  return response.ok || [404, 422].includes(response.status)
}

async function handlePull(relay, state, ctx, number) {
  const prs = state.prs
  const pr = await cached(ctx, state, `/repos/${relay.repo}/pulls/${number}`, pullSummary)
  if (pr.state !== "open") return delete prs[number]
  const record = (prs[number] ??= {})
  record.headSha = pr.headSha
  let waiting = waitingOnPull(pr)
  let mainBranch
  let judged
  if (!pr.labels.includes(relay.label)) waiting = [`the ${relay.label} label is gone`]
  if (waiting.length === 0) {
    const { runs } = await readChecks(ctx, state, relay.repo, pr.headSha)
    const { statuses } = await readStatuses(ctx, state, relay.repo, pr.headSha)
    waiting = waitingOnChecks(relay.requiredChecks, runs, relay.skippedPasses, statuses)
    if (relay.requireMainWorkflowGreen) {
      mainBranch = await cached(ctx, state, `/repos/${relay.repo}`, (body) => body.default_branch)
      const main = await readMain(ctx, state, relay.repo, relay.requireMainWorkflowGreen, mainBranch)
      if (!main) waiting.push(`${mainBranch} has no completed ${relay.requireMainWorkflowGreen} run yet`)
      else {
        judged = { branch: mainBranch, id: main.id, url: main.url }
        if (main.conclusion !== "success") waiting.push(`${mainBranch}'s latest completed ${relay.requireMainWorkflowGreen} run ${main.id} (${main.url}) is ${main.conclusion}`)
      }
    }
  }
  if (waiting.length === 0 && record.refused?.sha === pr.headSha && ctx.now - Date.parse(record.refused.at) < REFUSED_MS) waiting = [`GitHub refused the merge (${record.refused.reason}); trying again after ${new Date(Date.parse(record.refused.at) + REFUSED_MS).toISOString()}`]
  if (waiting.length > 0) {
    if (JSON.stringify(record.waitingOn) !== JSON.stringify(waiting)) note(state, ctx.now, { event: "waiting", number, on: waiting })
    Object.assign(record, { status: "waiting", waitingOn: waiting, at: new Date(ctx.now).toISOString() })
    await writeStatus(ctx, relay, number, record, waitingText(relay, pr, waiting), { final: false })
    return
  }
  // The head sha makes GitHub refuse the merge if a push landed after the checks were read.
  const response = await ctx.api.send("PUT", `/repos/${relay.repo}/pulls/${number}/merge`, { merge_method: relay.method, sha: pr.headSha })
  if (!response.ok) {
    const reason = response.body.message ?? `HTTP ${response.status}`
    record.refused = { sha: pr.headSha, at: new Date(ctx.now).toISOString(), reason }
    note(state, ctx.now, { event: "refused", number, reason })
    throw httpProblem(`merge #${number}`, relay.repo, response)
  }
  const at = new Date(ctx.now).toISOString()
  const deleted = await deleteBranch(ctx, relay, pr).catch(() => false)
  state.lastMerge = { at, number, sha: response.body.sha }
  prs[number] = { status: "merged", headSha: pr.headSha, sha: response.body.sha, at, commentId: record.commentId, commentAt: record.commentAt }
  note(state, ctx.now, { event: "merged", number, sha: response.body.sha, branchDeleted: deleted })
  ctx.save()
  await writeStatus(ctx, relay, number, prs[number], mergedText(relay, pr, response.body.sha, deleted, judged), { final: true })
}

/** Merges each labelled open pull request whose checks and statuses are all green, the required ones included (and the default branch's workflow, when named),, and keeps its status comment current. */
async function runMerge(relay, state, ctx) {
  const labelled = await cached(ctx, state, `/repos/${relay.repo}/issues?state=open&labels=${encodeURIComponent(relay.label)}&per_page=100`, (body) => body.filter((issue) => issue.pull_request).map((issue) => issue.number))
  for (const [number, record] of Object.entries(state.prs)) if (record.status !== "merged" && !labelled.includes(Number(number))) delete state.prs[number]
  const merged = Object.entries(state.prs).filter(([, record]) => record.status === "merged").sort((a, b) => b[1].at.localeCompare(a[1].at))
  for (const [number] of merged.slice(MERGED_KEPT)) delete state.prs[number]
  const errors = []
  for (const number of labelled) {
    try {
      await handlePull(relay, state, ctx, number)
    } catch (error) {
      errors.push(`#${number}: ${error.message}`)
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "))
}

const RUNNERS = { dispatch: runDispatch, "merge-when-green": runMerge }

// ── Poll ──

function accountOf(relay, drains) {
  const repos = relay.type === "dispatch" ? [relay.watch.repo, relay.fire.repo] : [relay.repo]
  return relay.account ?? repos.map((repo) => drains.find((drain) => drain.repo === repo)?.account).find(Boolean)
}

function freshest(readings) {
  return readings.filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
}

function safely(read, fallback) {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * Poll every due relay once. A relay's account is its own `account`, else the one its repository has in the drains config.
 * The state is written before this returns, and again right after each fire or merge, so a restart never repeats either.
 */
export async function pollRelays({ paths, drainFiles, connect, now }) {
  const relays = readRelayConfig(paths.config)
  const stored = readRelayStates(paths.state)
  const states = Object.fromEntries(relays.map((relay) => [relay.name, stored[relay.name]?.type === relay.type ? stored[relay.name] : { type: relay.type, cache: {}, history: [], ...(relay.type === "merge-when-green" ? { prs: {} } : {}) }]))
  const drains = safely(() => readDrainConfig(drainFiles.config), [])
  const drainStates = safely(() => readDrainStates(drainFiles.state), {})
  const save = () => writeRelayStates(paths.state, states)
  const connections = new Map()
  const connectOnce = (account) => {
    if (!connections.has(account ?? "")) connections.set(account ?? "", connect(account, account ? { login: account } : {}))
    return connections.get(account ?? "")
  }
  await Promise.all(relays.map(async (relay) => {
    const state = states[relay.name]
    if (state.lastPollAt && now - Date.parse(state.lastPollAt) < relay.everySeconds * 1000 - DUE_SLACK_MS) return
    const account = accountOf(relay, drains)
    const readings = [
      ...drains.filter((drain) => drain.account === account).map((drain) => drainStates[drain.repo]?.quota),
      ...relays.filter((other) => accountOf(other, drains) === account).map((other) => states[other.name].quota),
    ]
    const hold = quotaHold(freshest(readings), state.lastPollAt, now)
    if (hold) {
      state.hold = hold
      return
    }
    delete state.hold
    let api = null
    try {
      api = await connectOnce(account)
      const ctx = { api, now, save, touched: new Set() }
      await RUNNERS[relay.type](relay, state, ctx)
      forget(state, ctx.touched)
      state.lastOkAt = new Date(now).toISOString()
      delete state.lastError
    } catch (error) {
      state.lastError = error.message
    }
    if (api?.quota()) state.quota = api.quota()
    state.lastPollAt = new Date(now).toISOString()
  }))
  save()
  const apis = await Promise.all([...connections.values()].map((connection) => connection.catch(() => null)))
  const calls = apis.reduce((sum, api) => sum + (api ? api.calls().total : 0), 0)
  const errors = relays.filter((relay) => states[relay.name].lastError).map((relay) => ({ relay: relay.name, error: states[relay.name].lastError }))
  return { at: new Date(now).toISOString(), wakes: [], errors, calls, status: relayStatusLines(relays, states, now) }
}

// ── Visibility ──

function span(ms) {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  const minutes = Math.round(ms / 60_000)
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

const ago = (iso, now) => `${span(now - Date.parse(iso))} ago`

/** One line per relay: when it last polled, its last fire or merge, and what it is waiting on. */
export function relayStatusLines(relays, states, now) {
  return relays.map((relay) => {
    const state = states[relay.name] ?? {}
    const head = `relay ${relay.name} (${relay.type})`
    const tail = `${state.hold ? `, held: ${state.hold}` : ""}${state.lastError ? `, last error: ${state.lastError}` : ""}`
    if (!state.lastPollAt) return `${head}: not polled yet${tail}`
    const polled = `polled ${ago(state.lastPollAt, now)}`
    if (relay.type === "dispatch") {
      const last = state.lastFire ? `last fired ${ago(state.lastFire.at, now)} for run ${state.lastFire.runId}${state.lastFire.headSha ? ` on head ${short(state.lastFire.headSha)}` : ""} -> ${state.lastFire.target}` : "never fired"
      const pending = state.pending ? `, head ${short(state.pending.run.head_sha)} (run ${state.pending.run.id}) pending` : ""
      return `${head} ${relay.watch.repo} ${relay.watch.workflow} -> ${relay.fire.repo}: ${polled}, ${last}${pending}, settle ${relay.settleSeconds}s, waiting on ${state.waitingOn}${tail}`
    }
    const open = Object.entries(state.prs).filter(([, record]) => record.status !== "merged")
    const last = state.lastMerge ? `last merged #${state.lastMerge.number} ${ago(state.lastMerge.at, now)}` : "never merged"
    const waiting = open.length === 0 ? "no labelled pull request" : open.map(([number, record]) => `#${number} waiting on ${(record.waitingOn ?? ["its first look"]).join("; ")}`).join(" | ")
    return `${head} ${relay.repo}: ${polled}, ${last}, ${waiting}${tail}`
  })
}

/** What a relay did and is waiting on: its recorded events newest first, and the state it keeps. */
export function whyRelay(relays, states, name) {
  const relay = relays.find((candidate) => candidate.name === name)
  if (!relay) return { relay: name, note: `no relay is configured as ${name}; relays.json lists them` }
  const state = states[name] ?? { history: [] }
  return {
    relay: name,
    type: relay.type,
    config: relay,
    history: [...state.history].reverse().slice(0, 10),
    waiting: state.waitingOn ?? state.prs ?? null,
    ...(relay.type === "dispatch" ? { lastFiredHead: state.lastFire?.headSha ?? null, pending: state.pending ?? null } : {}),
    lastError: state.lastError,
  }
}

/** What each merge relay has decided about one pull request, for `why owner/name#number`. */
export function relaysOfPull(relays, states, repo, number) {
  return relays.filter((relay) => relay.type === "merge-when-green" && relay.repo === repo).map((relay) => {
    const state = states[relay.name] ?? { prs: {}, history: [] }
    return { relay: relay.name, pull: state.prs[String(number)], history: state.history.filter((event) => event.number === number).reverse().slice(0, 10) }
  }).filter((entry) => entry.pull || entry.history.length > 0)
}
