// What "delivered" means for a pull request, and the done-gate that enforces it.
//
// A merged pull request reaches users through whatever ships its repo. For some changes that is the merge itself; for others
// it is a release that comes minutes or hours later (ourostack/desk: a release run ships plugins/desk, and a failed release
// stops it for hours with nothing about the merge showing it). The repository declares which, in `.desk/delivery.json` at its
// root on the default branch:
//
//   { "schema_version": 1, "rules": [
//       { "paths": ["plugins/desk/**"], "delivered_at": { "kind": "github_label", "name": "released" } },
//       { "paths": ["**"], "delivered_at": { "kind": "merge" } } ] }
//
// Each changed file takes the first rule whose `paths` globs match it (`**` crosses folders, `*` and `?` stay inside one; a file no rule
// matches is delivered at merge). A pull request is delivered when every rule its files matched is satisfied:
//   - `merge`: always;
//   - `github_label` (`name`): the pull request carries the label, which the repo's own CI sets when the release that carries it is published
//     (desk-release.yml puts `released` on every pull request a release carries);
//   - `git_ref` (`pattern`, such as `refs/tags/v*`): the pull request's merge commit is an ancestor of a ref that matches the pattern. Read
//     here through GitHub's API; a host without that API reports `not_verified`.
// A repo with no policy file defaults to `merge` and the answer says "no delivery rule declared". The policy is read from the repo, not from
// this plugin, so another repo declares its own without a Desk release.
//
// Two functions, one rule. `prDelivery` answers "is this pull request delivered" for any caller (the done-gate here, step delivery later) and
// never throws: `{ status: "delivered" | "undelivered" | "not_verified" | "not_found", ... }`. `checkDelivery` is the done-gate's use of it:
// it throws on `undelivered` and `not_found`. The rules are a poka-yoke against an honest mistake (closing a task on a merge nothing has
// shipped), not a security boundary: they read what GitHub says.
//
// Offline and unreadable: when GitHub cannot be reached, answers 403, 429 or 5xx, or the policy or its answer cannot be read, the answer is
// `not_verified` and the done-gate lets the move through and says so. A desk with no network must still be able to close a task, and a gate
// that failed closed would make that impossible for as long as GitHub is unreachable. The release workflow and the boot alert are what make an
// unreleased merge visible; this gate only closes the one door. A pull request GitHub says does not exist is refused: nothing can carry it.
// Limits: a pull request's first 300 changed files are read, and a `git_ref` pattern is checked against at most its 100 newest-listed refs.

import { looksLikeNodeTestRunner } from "../runtime/test-state-guard.js"

export const POLICY_PATH = ".desk/delivery.json"
const REQUEST_BUDGET_MS = 5000
const FILE_PAGES = 3
const MAX_REFS = 100
const GITHUB_PR = /^https:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#].*)?$/iu
const MERGE = Object.freeze({ kind: "merge" })

async function github({ fetchFn, env, budgetMs }, route, accept = "application/vnd.github+json") {
  const headers = { "User-Agent": "desk-delivery-gate", Accept: accept }
  const token = [env.GH_TOKEN, env.GITHUB_TOKEN].find((value) => typeof value === "string" && value.trim() !== "")
  if (token !== undefined) headers.Authorization = `Bearer ${token.trim()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    const response = await fetchFn(`https://api.github.com${route}`, { headers, signal: controller.signal })
    return { status: response.status, body: response.status === 200 ? await response.text() : "" }
  } catch {
    return { status: 0, body: "" }
  } finally {
    clearTimeout(timer)
  }
}

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const why = (status) => (status === 0 ? "unreachable" : `HTTP ${status}`)
const notVerified = (reason) => ({ status: "not_verified", reason })

// A glob over repo-relative paths: `**` matches across folders, `*` and `?` stay inside one folder.
function globToRegExp(glob) {
  let source = ""
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*"
      i += 1
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
  }
  return new RegExp(`^${source}$`, "u")
}

const GIT_REF = /^refs\/[^*?]+(?:[*?][^/]*)?$/u
function usableRule(rule) {
  const at = rule?.delivered_at
  if (!Array.isArray(rule?.paths) || rule.paths.length === 0 || !rule.paths.every((entry) => typeof entry === "string" && entry !== "") || at === null || typeof at !== "object") return null
  if (at.kind === "merge") return { paths: rule.paths.map(globToRegExp), delivered_at: MERGE, label: "merge" }
  if (at.kind === "github_label" && typeof at.name === "string" && at.name !== "") return { paths: rule.paths.map(globToRegExp), delivered_at: { kind: at.kind, name: at.name }, label: `the \`${at.name}\` label` }
  if (at.kind === "git_ref" && typeof at.pattern === "string" && GIT_REF.test(at.pattern)) return { paths: rule.paths.map(globToRegExp), delivered_at: { kind: at.kind, pattern: at.pattern }, label: `a ref matching \`${at.pattern}\`` }
  return null
}

// Whether `sha` is an ancestor of some ref that matches `pattern` (GitHub: matching-refs for the pattern's literal prefix, then compare).
async function reachedByRef(ask, repo, sha, pattern) {
  const prefix = pattern.slice("refs/".length).split(/[*?]/u)[0]
  const listed = await github(ask, `/repos/${repo}/git/matching-refs/${prefix}?per_page=${MAX_REFS}`)
  const refs = listed.status === 200 ? parse(listed.body) : null
  if (!Array.isArray(refs)) return { error: `the refs matching ${pattern} could not be read from GitHub (${why(listed.status)})` }
  const matcher = globToRegExp(pattern)
  for (const ref of refs.filter((item) => matcher.test(String(item?.ref))).reverse()) {
    const compared = await github(ask, `/repos/${repo}/compare/${sha}...${encodeURIComponent(String(ref.object?.sha))}?per_page=1`)
    const answer = compared.status === 200 ? parse(compared.body) : null
    if (answer === null) return { error: `${ref.ref} could not be compared with the merge commit on GitHub (${why(compared.status)})` }
    if (answer.status === "ahead" || answer.status === "identical") return { reached: ref.ref }
  }
  return { reached: null }
}

/**
 * Is pull request `repo`#`number` delivered? Never throws. `{ status: "delivered", basis }` (`basis` says why: "no delivery rule declared",
 * "merge", the label, the ref), `{ status: "undelivered", unmet: [{ paths, delivered_at, need }], merged }` with a ready sentence in `need`,
 * `{ status: "not_verified", reason }` when GitHub could not answer, `{ status: "not_found" }` for a pull request GitHub does not know.
 * `fetchFn` and `budgetMs` (per request) are test seams.
 */
export async function prDelivery({ repo, number, env = process.env, fetchFn, budgetMs = REQUEST_BUDGET_MS }) {
  // istanbul ignore next -- outside a node:test run the real fetch is used; every test hands its own.
  const ask = { fetchFn: fetchFn ?? globalThis.fetch, env, budgetMs }
  const policyAnswer = await github(ask, `/repos/${repo}/contents/${POLICY_PATH}`, "application/vnd.github.raw+json")
  if (policyAnswer.status === 404) return { status: "delivered", basis: `no delivery rule declared in ${repo} (${POLICY_PATH}); merge counts as delivery` }
  if (policyAnswer.status !== 200) return notVerified(`${repo}'s delivery rules could not be read from GitHub (${why(policyAnswer.status)})`)
  const policy = parse(policyAnswer.body)
  const rules = Array.isArray(policy?.rules) ? policy.rules.map(usableRule) : []
  if (rules.length === 0 || rules.includes(null)) return notVerified(`${repo}'s ${POLICY_PATH} is not a usable delivery policy (every rule needs \`paths\` and a \`delivered_at\` of kind merge, github_label or git_ref)`)
  if (rules.every((rule) => rule.delivered_at.kind === "merge")) return { status: "delivered", basis: "every rule delivers at merge" }

  const prAnswer = await github(ask, `/repos/${repo}/pulls/${number}`)
  if (prAnswer.status === 404) return { status: "not_found" }
  const pr = prAnswer.status === 200 ? parse(prAnswer.body) : null
  if (pr === null || !Array.isArray(pr.labels)) return notVerified(`pull request ${repo}#${number} could not be read from GitHub (${why(prAnswer.status)})`)
  const labels = new Set(pr.labels.map((label) => label?.name))
  const merged = Boolean(pr.merged_at)

  // Which rules does this pull request's change fall under? Files are read only when a rule that needs more than the merge exists.
  const changed = []
  for (let page = 1; page <= FILE_PAGES; page += 1) {
    const filesAnswer = await github(ask, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)
    const files = filesAnswer.status === 200 ? parse(filesAnswer.body) : null
    if (!Array.isArray(files)) return notVerified(`the files of ${repo}#${number} could not be read from GitHub (${why(filesAnswer.status)})`)
    changed.push(...files.map((file) => String(file?.filename ?? "")).filter((name) => name !== ""))
    if (files.length < 100) break
  }
  const matched = new Set()
  for (const file of changed) {
    const rule = rules.find((candidate) => candidate.paths.some((glob) => glob.test(file)))
    if (rule !== undefined) matched.add(rule)
  }
  const unmet = []
  const bases = []
  for (const rule of matched) {
    const at = rule.delivered_at
    if (at.kind === "merge") continue
    if (at.kind === "github_label") {
      if (labels.has(at.name)) bases.push(`carries the \`${at.name}\` label`)
      else unmet.push({ delivered_at: at, need: `carry ${rule.label}` })
      continue
    }
    if (!merged) {
      unmet.push({ delivered_at: at, need: `be merged and reach ${rule.label}` })
      continue
    }
    const reached = await reachedByRef(ask, repo, String(pr.merge_commit_sha), at.pattern)
    if (reached.error !== undefined) return notVerified(reached.error)
    if (reached.reached === null) unmet.push({ delivered_at: at, need: `reach ${rule.label}` })
    else bases.push(`its merge commit is in ${reached.reached}`)
  }
  if (unmet.length === 0) return { status: "delivered", basis: bases.length === 0 ? "its changes deliver at merge" : bases.join(" and ") }
  return { status: "undelivered", unmet, merged }
}

/**
 * The done-gate's use of `prDelivery`: null when `evidence` is not a GitHub pull request URL (or a node:test run gave no fetch), otherwise
 * the answer, thrown as a refusal naming the pull request when it is `undelivered` or `not_found`. The caller reports `not_verified`.
 */
export async function checkDelivery({ toolName, evidence, env = process.env, fetchFn, budgetMs }) {
  const match = evidence.kind === "pr" ? GITHUB_PR.exec(evidence.ref.trim()) : null
  if (match === null) return null
  if (fetchFn === undefined && looksLikeNodeTestRunner(env)) return null
  const repo = `${match[1]}/${match[2]}`
  const number = Number(match[3])
  const answer = await prDelivery({ repo, number, env, fetchFn, budgetMs })
  if (answer.status === "not_found") throw new Error(`${toolName}: ${evidence.ref.trim()} does not exist on GitHub, so nothing can carry it. Supply the URL of the pull request that did the work.`)
  if (answer.status === "undelivered") {
    const need = answer.unmet.map((entry) => entry.need).join(" and ")
    throw new Error(
      `${toolName}: ${repo}#${number} is not delivered yet: ${repo} ships these changes through more than the merge, so the pull request must ${need}, and it does not. ` +
        `The release has not carried it yet${answer.merged ? "" : " (the pull request is not merged)"}. ` +
        "Leave the task at `validating`, check the release run (the \"Desk release needs attention\" issue lists a failed one) and repeat this call once that is true.",
    )
  }
  return answer
}
