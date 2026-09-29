// The Desk-problem filer: turns one failure of a Desk mechanism into a
// public issue on `ourostack/desk`, or recognizes an already-known one --
// the desk-problem skill's "Check for a known issue before filing" and
// "File, or mark known" steps (spec.md §1). A sibling module to
// `kaizen-file.js`, reusing its scrub, cap and client primitives rather than
// duplicating them (ruling 5): a Desk problem is a defect report with a
// different audience than a kaizen card (the operator's own friction
// opinion), so it never routes through `friction_add` or `fileKaizenCard`.
//
// Account selection (ruling 4): never a managed or Enterprise Managed User
// account, and never an account that cannot see `ourostack/desk`. This
// reuses `flush.js`'s `chooseAccount` -- which already asks every signed-in
// account about the store and rejects a managed login (`deliveryRoute`'s
// `MANAGED_LOGIN` check) or one the store refuses -- instead of
// re-implementing that check. The account recorded in this machine's own
// consent for `ourostack/desk`, if any, is preferred when `chooseAccount`
// also reports it as able to deliver; otherwise `chooseAccount`'s own pick
// (the active signed-in account, direct push preferred over a fork) is used.
// No suitable account is `not_filed: no_suitable_account`, carrying a
// paste-ready issue title and body so the agent can file it by hand. No new
// consent prompt is needed (ruling 4): reporting that Desk's own shared tool
// broke is not the operator's private data, and the target is always this
// one fixed public infrastructure repo, never a routed private store. A
// token is never logged, thrown or returned -- only ever passed to
// `issuesClient` and to `gh` as `GH_TOKEN` (`ghRunner`).
//
// Dedup (ruling 5): by the fingerprint marker embedded in the issue body,
// via `listIssues({ state: "all" })` -- never by title, since titles drift
// and the marker does not, and a closed-as-shipped or closed-as-wontfix
// issue is still "known" (refiling it would be pure noise).
//
// Rate limit: the same shape as `kaizen-file.js`'s `MAX_CARDS_PER_DAY`, a
// `desk_problem_filed` counter recorded in the same `status.json`
// (`outbox.js`'s `readStatus`/`writeStatus`), over cap is `held_cap`, never
// an error, never a retry loop.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { readFileSync } from "node:fs"

import { deskProblemFingerprint, normalizeErrorSignature } from "./desk-problem-fingerprint.js"
import { FINGERPRINT_PREFIX, deskProblemCard } from "./desk-problem-template.js"
import { chooseAccount, ghRunner } from "./flush.js"
import { readConsent, readStatus, writeStatus } from "./outbox.js"
import { issuesClient } from "./store-issues.js"

export const STORE = "ourostack/desk"
export const LABEL = "desk-problem"
export const MAX_PROBLEMS_PER_DAY = 5
const DAY_MS = 24 * 60 * 60 * 1000

// The version of Desk actually running this code, read from the plugin.json
// that ships beside it -- the same file and the same unguarded read
// `derive-run.js`'s own `ownDeskVersion` uses; plugin.json always ships with
// this module, so there is nothing to fail over to.
function ownDeskVersion() {
  return JSON.parse(readFileSync(new URL("../../../plugin.json", import.meta.url), "utf8")).version
}

async function recentFilings(env, now) {
  const filed = (await readStatus(env)).desk_problem_filed ?? {}
  const times = Array.isArray(filed[STORE]) ? filed[STORE].filter((at) => typeof at === "string" && now - Date.parse(at) < DAY_MS) : []
  return { filed, times }
}

/**
 * The account that may file to `ourostack/desk`, or `null` when none can
 * (ruling 4). Never prints a token: `chooseAccount` keeps every token in
 * memory and this function never reads one out of it. `chooseAccount` itself
 * already converts every failure (no signed-in account, only a managed
 * login, the store unreachable, a misbehaving runner) into a `result` other
 * than `"account_found"` rather than throwing, given a valid `store` string
 * -- and `STORE` is a fixed, valid literal -- so there is nothing further to
 * catch here.
 */
async function selectAccount(env, { runner, now }) {
  const chosen = await chooseAccount({ store: STORE, runner, now })
  if (chosen.result !== "account_found") return null
  const consentAccount = (await readConsent(env)).stores[STORE]?.account
  if (typeof consentAccount === "string") {
    const preferred = chosen.accounts.find((entry) => entry.account === consentAccount && (entry.route === "direct" || entry.route === "fork"))
    if (preferred !== undefined) return preferred.account
  }
  return chosen.account
}

/**
 * `fileDeskProblem(env, { mechanism, rawText, fixAttempt, host, runner, now })
 * -> { result: "filed" | "known" | "held_cap" | "not_filed", url?, reason?, body? }`.
 * `url` is the issue URL for `"filed"`/`"known"`; `reason` and a paste-ready
 * `body` (title and body joined) come with `"not_filed"`. Never throws.
 */
export async function fileDeskProblem(env, {
  mechanism, rawText = "", fixAttempt = "not recorded", host = "unknown", runner = ghRunner({ env }), now = Date.now,
} = {}) {
  const signature = normalizeErrorSignature(rawText)
  const fingerprint = deskProblemFingerprint(mechanism, signature)
  const deskVersion = ownDeskVersion()
  const { title, body } = deskProblemCard({ mechanism, deskVersion, host, rawText, fixAttempt, fingerprint })
  const pasteReady = `${title}\n\n${body}`

  const account = await selectAccount(env, { runner, now })
  if (account === null) return { result: "not_filed", reason: "no_suitable_account", body: pasteReady }

  try {
    const auth = await runner(["auth", "token", "--user", account])
    const token = auth.code === 0 ? String(auth.stdout ?? "").trim() : ""
    if (token === "") return { result: "not_filed", reason: "no_suitable_account", body: pasteReady }

    const client = issuesClient({ runner, repo: STORE, token })
    const marker = `${FINGERPRINT_PREFIX}${fingerprint} -->`
    const existing = (await client.listIssues({ label: LABEL, state: "all" })).find((issue) => !issue.pull_request && issue.body.includes(marker))
    if (existing !== undefined) return { result: "known", url: existing.url }

    const at = now()
    const { filed, times } = await recentFilings(env, at)
    if (times.length >= MAX_PROBLEMS_PER_DAY) return { result: "held_cap" }

    const { url } = await client.createIssue({ title, body, labels: [LABEL, "bug"] })
    await writeStatus(env, { desk_problem_filed: { ...filed, [STORE]: [...times, new Date(at).toISOString()] } })
    return { result: "filed", url }
  } catch (error) {
    if (typeof error.code === "string") return { result: "not_filed", reason: error.code, body: pasteReady }
    throw error
  }
}
