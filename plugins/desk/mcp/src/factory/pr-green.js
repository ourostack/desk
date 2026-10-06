// Whether a countermeasure pull request is merged with green checks. The verify step uses it for the fixed rules
// "close a fix nothing can measure once it merged green" and "after 14 checks, a merged green fix closes unverified".
//
// `mergedWithGreenChecks({ countermeasure, client, maxCalls }) -> { state: "merged_green" } | { state:
// "merged_not_green" } | { state: "not_merged" } | { state: "unavailable", reason }`. `client` is a `githubReader`
// result (any object with `get(route)`). It reads the pull request, then the check runs and the combined commit
// status of its merge commit, or of the pull request's head commit when the merge commit carries no check at all (five calls at most; `maxCalls`, default 5, bounds each lookup). Green means at
// least one check or status exists, every check run is completed as `success`, `neutral` or `skipped`, and the
// combined status, when it holds any status, is `success`. A pull request with no check at all is
// `merged_not_green`: there is no evidence. A lookup that could not be made is never `not_merged` or
// `merged_not_green`: it is `unavailable` with one stable reason (`countermeasure_unparsed`, `call_budget`,
// `too_many_checks`, `lookup_failed`, or the reader's own code such as `gh_missing`, `timeout`, `http_<status>`,
// `gh_failed`, `unexpected_answer`).
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { parsePrUrl } from "./release-version.js"

export const MAX_CALLS = 5
export const MAX_CHECK_RUNS = 100
const GREEN = new Set(["success", "neutral", "skipped"])

function failure(code) {
  const error = new Error(`pr green: ${code}`)
  error.code = code
  return error
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// The checks on one commit: `null` when it carries none, else whether every one is green.
async function checksOf(repo, sha, client) {
  const runs = await client.get(`repos/${repo}/commits/${sha}/check-runs?per_page=${MAX_CHECK_RUNS}`)
  if (!isObject(runs) || !Array.isArray(runs.check_runs) || !Number.isSafeInteger(runs.total_count)) throw failure("unexpected_answer")
  if (runs.total_count > runs.check_runs.length) throw failure("too_many_checks")
  if (runs.check_runs.some((run) => !isObject(run))) throw failure("unexpected_answer")
  const status = await client.get(`repos/${repo}/commits/${sha}/status`)
  if (!isObject(status) || typeof status.state !== "string" || !Number.isSafeInteger(status.total_count)) throw failure("unexpected_answer")
  if (runs.check_runs.length === 0 && status.total_count === 0) return null
  const checksGreen = runs.check_runs.every((run) => run.status === "completed" && GREEN.has(run.conclusion))
  return checksGreen && (status.total_count === 0 || status.state === "success")
}

async function read(repo, number, client) {
  const pull = await client.get(`repos/${repo}/pulls/${number}`)
  if (!isObject(pull)) throw failure("unexpected_answer")
  if (pull.merged_at === null || pull.merged_at === undefined) return { state: "not_merged" }
  const hex = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)
  if (!hex(pull.merge_commit_sha)) throw failure("unexpected_answer")
  let green = await checksOf(repo, pull.merge_commit_sha, client)
  // A squash or rebase merge makes a commit the pull request's checks never ran on, so a merge commit with no
  // checks falls back to the pull request's own last commit.
  if (green === null && isObject(pull.head) && pull.head.sha !== undefined) {
    if (!hex(pull.head.sha)) throw failure("unexpected_answer")
    green = await checksOf(repo, pull.head.sha, client)
  }
  return { state: green === true ? "merged_green" : "merged_not_green" }
}

/** See the header. */
export async function mergedWithGreenChecks({ countermeasure, client, maxCalls = MAX_CALLS }) {
  const pr = parsePrUrl(countermeasure)
  if (pr === null) return { state: "unavailable", reason: "countermeasure_unparsed" }
  let calls = 0
  const counted = {
    get(route) {
      if (calls >= maxCalls) throw failure("call_budget")
      calls += 1
      return client.get(route)
    },
  }
  try {
    return await read(pr.repo, pr.number, counted)
  } catch (error) {
    return { state: "unavailable", reason: typeof error?.code === "string" ? error.code : "lookup_failed" }
  }
}
