// Andon at session start: which andon issues are open in each consented
// store, so the agent sees a stopped line without being asked.
//
// `refreshAndon(env, { store, runner, now })` runs in the detached
// start-time delivery (`flush.js` `flushConsented`), after that store's
// flush. With the store's recorded consent and account it reads the store's
// `factory.json` (the plugins andon tracks, `pipeline/andon.js`
// `parseStoreConfig`) and its open `andon` issues, and keeps those the
// store's build opened (`github-actions[bot]`) for a tracked plugin and no
// one dismissed (`andon-dismissed`). It records them, at most
// `MAX_RECORDED`, as `status.json` `andon.<store>` = `{ checked_at, issues:
// [{ number, title }] }`, replacing that store's previous record, and
// resolves `{ result: "recorded", count }`. It records nothing and resolves
// `{ result: <code> }` when the store is not contributing (`not_opted_in`),
// has no account (`no_account`), `gh` is missing (`gh_missing`), the token
// cannot be read (`auth_failed`), the store's `factory.json` is missing
// (`config_missing`: a 404, so deleted, renamed or on another branch) or not
// valid (`invalid_config`), or GitHub fails (the issues client's codes). A
// missing `factory.json` is never read as "tracks nothing": that would hide
// every open andon issue and read as clear (fail closed, ruling 2026-10-06).
// Only a present, valid config may track no plugins.
//
// The session-start boot check (`boot-check.js` `andonBootCheck`) reads the
// record synchronously and prints one line per store with open issues, so
// the line reflects the previous session's refresh.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { readConsent, readStatus, writeStatus } from "./outbox.js"
import { ANDON_LABEL, DISMISSED_LABEL, parseAndonTitle, parseStoreConfig } from "./pipeline/andon.js"
import { issuesClient } from "./store-issues.js"

export const MAX_RECORDED = 20
export const BUILD_AUTHOR = "github-actions[bot]"

/** The open andon issues the store's build opened for a tracked plugin and no one dismissed, lowest number first. Shared with the loop's route step. */
export function trackedAndonIssues(issues, tracked) {
  return issues
    .filter((issue) => buildAndon(issue) && tracked.has(parseAndonTitle(issue.title)?.plugin))
    .sort((left, right) => left.number - right.number)
}

/** Candidates for a tracked andon issue before the plugin filter: open issues the store's build opened and no one dismissed. */
const buildAndon = (issue) => !issue.pull_request && issue.author === BUILD_AUTHOR && !issue.labels.includes(DISMISSED_LABEL)

/**
 * The open andon issues of `issues` the build opened and no one dismissed but whose plugin `tracked` leaves out, lowest number first.
 * The loop keeps their ids present instead of reading a shrunken plugin list as a clear look. Shared with the loop's route step.
 */
export function untrackedAndonIssues(issues, tracked) {
  return issues.filter((issue) => buildAndon(issue) && !tracked.has(parseAndonTitle(issue.title)?.plugin)).sort((left, right) => left.number - right.number)
}

/**
 * `readAndonConfig(client) -> { ok: true, plugins } | { ok: false, code }`: the store's `factory.json` read through the issues client.
 * A missing file is `config_missing`, never an empty plugin list. Shared with the loop's route step.
 */
export async function readAndonConfig(client) {
  const text = await client.readFile("factory.json")
  return text === null ? { ok: false, code: "config_missing" } : parseStoreConfig(text)
}

/** See the header. Never throws for GitHub or consent problems; each is a result code. */
export async function refreshAndon(env, { store, runner, now = Date.now }) {
  const consent = (await readConsent(env)).stores[store]
  if (consent?.contribute !== true) return { result: "not_opted_in" }
  if (typeof consent.account !== "string") return { result: "no_account" }
  const auth = await runner(["auth", "token", "--user", consent.account])
  if (auth.spawnError === "ENOENT") return { result: "gh_missing" }
  const token = auth.code === 0 ? String(auth.stdout ?? "").trim() : ""
  if (token === "") return { result: "auth_failed" }
  let issues
  try {
    const client = issuesClient({ runner, repo: store, token })
    const config = await readAndonConfig(client)
    if (!config.ok) return { result: config.code === "config_missing" ? "config_missing" : "invalid_config" }
    const tracked = new Set(config.plugins)
    issues = trackedAndonIssues(await client.listIssues({ label: ANDON_LABEL, state: "open" }), tracked)
      .slice(0, MAX_RECORDED)
      .map(({ number, title }) => ({ number, title }))
  } catch (error) {
    if (typeof error.code === "string") return { result: error.code }
    throw error
  }
  const current = (await readStatus(env)).andon
  const andon = current !== null && typeof current === "object" && !Array.isArray(current) ? current : {}
  await writeStatus(env, { andon: { ...andon, [store]: { checked_at: new Date(now()).toISOString(), issues } } })
  return { result: "recorded", count: issues.length }
}
