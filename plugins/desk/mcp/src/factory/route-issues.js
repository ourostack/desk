// The loop's `route` step, issues half. Three kinds of GitHub issue each open one improvement card:
//   - `andon`: an open andon issue in a consenting store that the store's build opened for a tracked plugin and nobody dismissed
//     (the same filter the session-start andon refresh uses), key `andon:<owner/repo>#<n>`;
//   - `store_build`: an open issue labelled `build-failing` in a consenting store (a store without that label has none: an empty
//     read, not a failure), key `store_build:<owner/repo>#<n>`;
//   - `desk_problem`: an open issue labelled `desk-problem` in `ourostack/desk` filed by a consenting account, read once per run,
//     key `desk_problem:ourostack/desk#<n>`.
// A card's title is built by the card library, its evidence is the one pointer `issue:<owner/repo>#<n>`, its plugin is `desk`.
// No issue title, body, author or label text is kept anywhere: the pointer is the pointer.
//
// Bounds. At most `MAX_ISSUES_PER_KIND` issues per kind and store open cards, lowest number first. Above it the true count is
// still reported (`counts.open_now`), `counts.capped` names the kind, and that source is NOT observed this run, because a
// partial list would make the cards left out read as clear.
//
// Observation. After a successful read of every store for a kind, `observeConditions` gets the complete list of ids of that
// source that hold now. A kind that could not be read in some store (a failed fetch, an unreadable account) is not observed
// at all; a failed look is never a clear look.
//
// Result. `runRouteIssuesStep(env, { deskRoot, personPrefix, runner, now, ...seams }) -> { ok, result, opened, counts }`.
// `opened` lists keys opened or reopened this run. `result`: `routed` (every kind read), `partly_read` (some kinds read, `ok`
// false), the shared code when every kind failed the same way (`gh_missing`, `auth_failed`, `http_<status>`, ...) or
// `unreadable`, `no_stores` (no consenting store with an account: nothing read, `ok` true), `consent_unreadable`,
// `unexpected_error`, `headless_session` (nothing run or written). `counts`: `opened`, `reopened`, `duplicate`,
// `card_write_failed`, any library refusal code, `observe_failed`, `status_unwritable` (numbers, present when above 0);
// `kinds_read` (list), `failed` (`{ <kind>: <code> }`), `capped` (list of kinds) and `open_now`
// (`{ andon_open, store_build_failing, desk_problems_open }`, each a number from a successful read, absent otherwise).
//
// Health record. Every run that reads anything writes `status.json` `loop.route_issues = { at, andon_open,
// store_build_failing, desk_problems_open }`; a kind that was not read is absent, never a stale number.
//
// This step does not call `recordStep`; the loop worker records `route` once for both route collectors.

import * as path from "node:path"

import { cardKey, openImprovement } from "../desk/improvement-cards.js"
import { cardCommitMessage, writeCardCommitted as writeCardCommittedDefault } from "../tools/_card-commit.js"
import { BUILD_AUTHOR, trackedAndonIssues } from "./andon-watch.js"
import { LABEL as DESK_PROBLEM_LABEL, STORE as DESK_REPO } from "./desk-problem-file.js"
import { ghRunner } from "./flush.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { observeConditions } from "./loop-conditions.js"
import { readConsent, readStatus, updateStatus } from "./outbox.js"
import { ANDON_LABEL, parseStoreConfig } from "./pipeline/andon.js"
import { issuesClient } from "./store-issues.js"

export const MAX_ISSUES_PER_KIND = 50
export const BUILD_FAILING_LABEL = "build-failing"

const KINDS = Object.freeze([
  { kind: "andon", source: "andon", health: "andon_open" },
  { kind: "store_build", source: "store_build", health: "store_build_failing" },
  { kind: "desk_problem", source: "desk_problem", health: "desk_problems_open" },
])

const codeOf = (error) => (typeof error.code === "string" && /^[a-z0-9_]{1,40}$/u.test(error.code) ? error.code : "unexpected_error")

export async function runRouteIssuesStep(env, {
  deskRoot, personPrefix = "", runner = ghRunner(), now = new Date(),
  writeCardCommitted = writeCardCommittedDefault, openImprovementImpl = openImprovement, observeImpl = observeConditions,
  updateStatusImpl = updateStatus, readConsentImpl = readConsent, readStatusImpl = readStatus,
} = {}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  const nowMs = new Date(now).getTime()
  if (Number.isNaN(nowMs)) throw new TypeError("now: must be a valid time")
  const opened = []
  const counts = {}
  const count = (code) => { counts[code] = (counts[code] ?? 0) + 1 }
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session", opened, counts }

  let stores
  try {
    const consent = await readConsentImpl(env)
    stores = Object.entries(consent.stores)
      .filter(([, entry]) => entry?.contribute === true && typeof entry.account === "string")
      .map(([store, entry]) => ({ store, account: entry.account }))
      .sort((a, b) => a.store.localeCompare(b.store))
  } catch {
    await writeHealth({})
    return { ok: false, result: "consent_unreadable", opened, counts }
  }
  if (stores.length === 0) {
    await writeHealth({})
    return { ok: true, result: "no_stores", opened, counts }
  }

  const state = Object.fromEntries(KINDS.map(({ kind }) => [kind, { ids: [], total: 0, capped: false, failed: null }]))
  const tokens = new Map()
  const tokenOf = async (account) => {
    if (!tokens.has(account)) {
      let entry
      try {
        const auth = await runner(["auth", "token", "--user", account])
        const token = auth.code === 0 ? String(auth.stdout).trim() : ""
        entry = auth.spawnError === "ENOENT" ? { code: "gh_missing" } : token === "" ? { code: "auth_failed" } : { token }
      } catch {
        entry = { code: "unexpected_error" }
      }
      tokens.set(account, entry)
    }
    return tokens.get(account)
  }
  const take = (kind, repo, issues) => {
    const entry = state[kind]
    const numbers = issues.map((issue) => issue.number).sort((a, b) => a - b)
    entry.total += numbers.length
    if (numbers.length > MAX_ISSUES_PER_KIND) entry.capped = true
    entry.ids.push(...numbers.slice(0, MAX_ISSUES_PER_KIND).map((number) => `${repo}#${number}`))
  }
  const accounts = [...new Set(stores.map(({ account }) => account))]
  const consenting = new Set(accounts.map((account) => account.toLowerCase()))
  const fail = (kind, code) => { state[kind].failed ??= code }
  const guarded = async (kind, body) => {
    try {
      await body()
    } catch (error) {
      fail(kind, codeOf(error))
    }
  }

  for (const { store, account } of stores) {
    const entry = await tokenOf(account)
    if (entry.token === undefined) {
      fail("andon", entry.code)
      fail("store_build", entry.code)
      continue
    }
    const client = issuesClient({ runner, repo: store, token: entry.token })
    await guarded("andon", async () => {
      const config = parseStoreConfig(await client.readFile("factory.json"))
      if (!config.ok) throw Object.assign(new Error("config"), { code: "invalid_config" })
      take("andon", store, trackedAndonIssues(await client.listIssues({ label: ANDON_LABEL, state: "open" }), new Set(config.plugins)))
    })
    await guarded("store_build", async () => {
      take("store_build", store, (await client.listIssues({ label: BUILD_FAILING_LABEL, state: "open" })).filter((issue) => !issue.pull_request && (issue.author === BUILD_AUTHOR || consenting.has(String(issue.author).toLowerCase()))))
    })
  }

  // The Desk problems are read once, with the first consenting account that has a token.
  let reader = null
  let excludedDeskProblems = []
  for (const account of accounts) {
    const entry = await tokenOf(account)
    if (entry.token !== undefined) {
      reader = entry.token
      break
    }
    fail("desk_problem", entry.code)
  }
  if (reader !== null) {
    state.desk_problem.failed = null
    await guarded("desk_problem", async () => {
      const client = issuesClient({ runner, repo: DESK_REPO, token: reader })
      const open = (await client.listIssues({ label: DESK_PROBLEM_LABEL, state: "open" })).filter((issue) => !issue.pull_request)
      take("desk_problem", DESK_REPO, open.filter((issue) => consenting.has(String(issue.author).toLowerCase())))
      // Still open but excluded only by the author filter: not a card and not counted, yet never read as clear.
      excludedDeskProblems = open.filter((issue) => !consenting.has(String(issue.author).toLowerCase())).map((issue) => `${DESK_REPO}#${issue.number}`)
    })
  }

  const kindsRead = []
  const failed = {}
  const capped = []
  const openNow = {}
  for (const { kind, source, health } of KINDS) {
    const entry = state[kind]
    // Every issue that was read opens its card, even when another store failed; only the observation needs a complete look.
    for (const id of entry.ids) await openCard(source, id)
    if (entry.failed !== null) {
      failed[kind] = entry.failed
      continue
    }
    kindsRead.push(kind)
    openNow[health] = entry.total
    if (entry.capped) {
      capped.push(kind)
      continue
    }
    let observed
    try {
      const recorded = await recordedPresent(source)
      const readStores = new Set(stores.map(({ store }) => store))
      const kept = kind === "desk_problem" ? excludedDeskProblems.filter((id) => recorded.includes(id)) : recorded.filter((id) => !readStores.has(id.split("#")[0]))
      const present = [...entry.ids, ...kept]
      observed = await observeImpl(env, { source, present, now: new Date(nowMs) })
    } catch {
      observed = { ok: false }
    }
    if (observed?.ok !== true) count("observe_failed")
  }
  counts.kinds_read = kindsRead
  counts.failed = failed
  counts.capped = capped
  counts.open_now = openNow

  await writeHealth(openNow)

  const failures = Object.values(failed)
  let result = "routed"
  if (failures.length > 0) result = kindsRead.length > 0 ? "partly_read" : new Set(failures).size === 1 ? failures[0] : "unreadable"
  return { ok: failures.length === 0, result, opened, counts }

  // Ids already recorded as present for a source. A store this run did not read (one that stopped consenting), or a Desk problem
  // still open but excluded by the author filter, keeps its recorded ids present instead of reading as clear.
  async function recordedPresent(source) {
    const conditions = (await readStatusImpl(env)).loop?.conditions
    if (typeof conditions !== "object" || conditions === null) return []
    return Object.entries(conditions)
      .filter(([key, entry]) => key.startsWith(`${source}:`) && entry?.present === true)
      .map(([key]) => key.slice(source.length + 1))
  }

  async function writeHealth(numbers) {
    try {
      await updateStatusImpl(env, (current) => {
        const loop = typeof current.loop === "object" && current.loop !== null && !Array.isArray(current.loop) ? current.loop : {}
        return { ...current, loop: { ...loop, route_issues: { at: new Date(nowMs).toISOString(), ...numbers } } }
      })
    } catch {
      count("status_unwritable")
    }
  }

  async function openCard(source, id) {
    const key = cardKey(source, id)
    let written
    try {
      written = await writeCardCommitted({
        deskRoot,
        personPrefix,
        write: () => openImprovementImpl({ deskRoot, personPrefix, key, source, evidence: [`issue:${id}`], plugin: "desk", signal: null, now: new Date(nowMs) }),
        message: (outcome) => cardCommitMessage("route", outcome.file_name ?? "card"),
      })
    } catch {
      count("card_write_failed")
      return
    }
    const code = written?.result?.result
    if (typeof code !== "string" || !/^[a-z0-9_]{1,40}$/u.test(code)) count("card_write_failed")
    else {
      count(code)
      if (code === "opened" || code === "reopened") opened.push(key)
    }
  }
}
