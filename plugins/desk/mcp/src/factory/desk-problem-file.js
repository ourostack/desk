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
import { beginFiling, endFiling, recordKnownHit, recordLostHit } from "./desk-problem-known.js"
import { endLaunch } from "./filer-launch.js"
import { chooseAccount, ghRunner } from "./flush.js"
import { readConsent, readStatus, withNamedLock, writeStatus } from "./outbox.js"
import { issuesClient } from "./store-issues.js"

export const STORE = "ourostack/desk"
export const LABEL = "desk-problem"
export const MAX_PROBLEMS_PER_DAY = 5
const DAY_MS = 24 * 60 * 60 * 1000
// The whole filing attempt's own hard deadline (ruling 3, spec.md §1): callers that reach this from a
// bounded context (the detached filer script; a future caller with its own budget) pass their own
// `deadlineMs`. It bounds `chooseAccount` and every `gh` call this function itself makes afterward
// (`auth token`, the dedup listing, the create), never just the account lookup, so a hanging runner
// never leaves this function running past it -- see `desk_problem_file.test.js`'s deadline test.
const DEFAULT_DEADLINE_MS = 30000

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
 * The account that may file to `ourostack/desk` (ruling 4), or the reason none can:
 * `{ account }` or `{ account: null, reason }`, `reason` being one of `chooseAccount`'s own
 * `ACCOUNT_RESULTS` (`"deadline"` included -- surfaced as-is rather than folded into
 * `no_suitable_account`, so a caller can tell a hanging runner from a genuinely unusable account).
 * Never prints a token: `chooseAccount` keeps every token in memory and this function never reads
 * one out of it. `chooseAccount` itself already converts every failure (no signed-in account, only
 * a managed login, the store unreachable, a misbehaving runner, its own deadline) into a `result`
 * other than `"account_found"` rather than throwing, given a valid `store` string -- and `STORE` is
 * a fixed, valid literal -- so there is nothing further to catch here.
 */
async function selectAccount(env, { runner, now, deadlineMs }) {
  const chosen = await chooseAccount({ store: STORE, runner, now, deadlineMs })
  if (chosen.result !== "account_found") return { account: null, reason: chosen.result }
  const consentAccount = (await readConsent(env)).stores[STORE]?.account
  if (typeof consentAccount === "string") {
    const preferred = chosen.accounts.find((entry) => entry.account === consentAccount && (entry.route === "direct" || entry.route === "fork"))
    if (preferred !== undefined) return { account: preferred.account }
  }
  return { account: chosen.account }
}

/**
 * `fileDeskProblem(env, { mechanism, rawText, fixAttempt, host, runner, now, deadlineMs })
 * -> { result: "filed" | "known" | "held_cap" | "not_filed", url?, reason?, body? }`. A `not_filed` attempt, a known hit that could
 * not be recorded, and an unexpected throw each count a drop (`recordLostHit`), since a recurrence may be among them.
 * `url` is the issue URL for `"filed"`/`"known"`; `reason` (`"deadline"` when the whole attempt ran out
 * of time, `"no_suitable_account"`, or a `gh`/HTTP error code) and a paste-ready `body` (title and body
 * joined) come with `"not_filed"`. Never throws.
 *
 * `deadlineMs` (default 30 s, ruling 3) bounds the whole attempt -- account selection and every `gh`
 * call this function makes afterward -- so a hanging runner or a slow network never keeps this running
 * past its bound; the caller most exposed to that is the detached filer
 * (`mcp/scripts/file-desk-problem.js`, `runFileDeskProblemCli` below), started off a boot check's own
 * critical path for exactly this reason.
 *
 * The dedup check, the cap check and the creation itself run under a lock named for `mechanism`
 * (`outbox.js`'s `withNamedLock`) so two processes racing the same broken mechanism -- two sessions
 * starting at once, say -- can't both pass the dedup/cap check before either has created the issue and
 * file it twice; the fingerprint and the cap counter alone check-then-act outside a lock, which a
 * concurrent second caller can still slip through.
 */
export async function fileDeskProblem(env, options = {}) {
  const { now = Date.now, recordLost = recordLostHit, begin = beginFiling, end = endFiling } = options
  // Any attempt that neither filed a new issue, nor recorded a known hit, nor held a new problem at the cap may have lost a recurrence of a
  // known issue: it is counted as a drop, so the verify step never reads it as a measured "no hit" (`desk-problem-known.js`).
  const lost = async () => {
    const counted = await Promise.resolve().then(() => recordLost(env, { now })).catch(() => ({ recorded: false, code: "record_failed" }))
    if (!counted.recorded && counted.code !== "headless_session") process.stderr.write(`desk-problem: lost_hit_not_recorded ${counted.code}\n`)
  }
  // The attempt is recorded before any network step and cleared once its outcome is recorded, so a filer killed part way is a drop too.
  const token = await begin(env, { now })
  let outcome
  try {
    outcome = await attemptFiling(env, options)
  } catch (error) {
    await lost()
    await end(env, token)
    throw error
  }
  if (outcome.result === "not_filed" || outcome.hitLost === true) await lost()
  await end(env, token)
  const { hitLost, ...result } = outcome
  return result
}

async function attemptFiling(env, {
  mechanism, rawText = "", fixAttempt = "not recorded", host = "unknown", runner = ghRunner({ env }), now = Date.now, deadlineMs = DEFAULT_DEADLINE_MS, recordKnown = recordKnownHit,
}) {
  const signature = normalizeErrorSignature(rawText)
  const fingerprint = deskProblemFingerprint(mechanism, signature)
  const deskVersion = ownDeskVersion()
  const { title, body } = deskProblemCard({ mechanism, deskVersion, host, rawText, fixAttempt, fingerprint })
  const pasteReady = `${title}\n\n${body}`
  const deadline = now() + deadlineMs
  const remaining = () => Math.max(0, deadline - now())

  const selected = await selectAccount(env, { runner, now, deadlineMs: remaining() })
  if (selected.account === null) {
    return { result: "not_filed", reason: selected.reason === "deadline" ? "deadline" : "no_suitable_account", body: pasteReady }
  }
  if (remaining() <= 0) return { result: "not_filed", reason: "deadline", body: pasteReady }

  try {
    const auth = await runner(["auth", "token", "--user", selected.account], { timeoutMs: remaining() })
    const token = auth.code === 0 ? String(auth.stdout ?? "").trim() : ""
    if (token === "") return { result: "not_filed", reason: "no_suitable_account", body: pasteReady }

    return await withNamedLock(env, `desk-problem-${mechanism}`, async () => {
      const client = issuesClient({ runner, repo: STORE, token, timeoutMs: remaining() })
      const marker = `${FINGERPRINT_PREFIX}${fingerprint} -->`
      const existing = (await client.listIssues({ label: LABEL, state: "all" })).find((issue) => !issue.pull_request && issue.body.includes(marker))
      if (existing !== undefined) {
        // A known problem is hit again: count it, with the running Desk version, so a recurrence after the fix is visible.
        // The count never changes the result; a failed write leaves one stable code on stderr.
        const recorded = await Promise.resolve().then(() => recordKnown(env, existing.number, { version: deskVersion, now })).catch(() => ({ recorded: false, code: "record_failed" }))
        const hitLost = !recorded.recorded && recorded.code !== "headless_session"
        if (hitLost) process.stderr.write(`desk-problem: known_hit_not_recorded ${recorded.code}\n`)
        return { result: "known", url: existing.url, hitLost }
      }

      const at = now()
      const { filed, times } = await recentFilings(env, at)
      if (times.length >= MAX_PROBLEMS_PER_DAY) return { result: "held_cap" }

      const { url } = await client.createIssue({ title, body, labels: [LABEL, "bug"] })
      await writeStatus(env, { desk_problem_filed: { ...filed, [STORE]: [...times, new Date(at).toISOString()] } })
      return { result: "filed", url }
    })
  } catch (error) {
    if (typeof error.code === "string") return { result: "not_filed", reason: error.code, body: pasteReady }
    throw error
  }
}

/**
 * The detached filer's whole CLI surface (`mcp/scripts/file-desk-problem.js`), kept here so it is
 * unit-tested directly rather than through a subprocess -- the script itself is one line. Mechanism-
 * agnostic: any boot check or future caller that wants filing off its own critical path launches this
 * script detached (the same `launchCommand`/`compatibleCommand` pattern boot-checks.cjs already uses
 * for its repairs) with `--mechanism <m> [--reason <text>] [--host <h>] [--fix-attempt <text>]`.
 * `--mechanism` is the only required flag. A usage error throws (a bad launch site is a bug in Desk's
 * own code to fix, not a runtime condition this needs to survive); `fileDeskProblem` itself beneath it
 * already never throws. Nothing reads this process's exit code or output -- it is started with ignored
 * stdio -- so there is nothing to print; the fingerprint dedup and the daily cap make it safe to run
 * again at the next session start if this attempt is lost.
 */
export async function runFileDeskProblemCli({ argv = process.argv.slice(2), env = process.env } = {}) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) throw new Error(`file-desk-problem.js: unexpected argument ${JSON.stringify(key ?? "")}`)
    options.set(key.slice(2), argv[index + 1])
  }
  const mechanism = options.get("mechanism")
  if (typeof mechanism !== "string" || mechanism === "") throw new Error("file-desk-problem.js: --mechanism <name> is required")
  const reason = options.get("reason") ?? ""
  try {
    await fileDeskProblem(env, { mechanism, rawText: reason, fixAttempt: options.get("fix-attempt") ?? "not recorded", host: options.get("host") ?? "unknown" })
  } finally {
    // The outcome (or the drop for a failed attempt) is recorded: the launcher's stamp is no longer a pending launch (`filer-launch.js`). A
    // launcher whose stamp is keyed by something other than the reason (protected-checkout keys it by the command) names it.
    endLaunch(env, { mechanism, signature: options.get("launch-signature") ?? reason })
  }
  return 0
}
