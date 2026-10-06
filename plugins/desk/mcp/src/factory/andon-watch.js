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
// cannot be read (`auth_failed`), the store's `factory.json` is not valid
// (`invalid_config`), or GitHub fails (the issues client's codes). A store
// without `factory.json` tracks nothing, so its record is empty.
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
    .filter((issue) => !issue.pull_request && issue.author === BUILD_AUTHOR && !issue.labels.includes(DISMISSED_LABEL) && tracked.has(parseAndonTitle(issue.title)?.plugin))
    .sort((left, right) => left.number - right.number)
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
    const config = parseStoreConfig(await client.readFile("factory.json"))
    if (!config.ok) return { result: "invalid_config" }
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
