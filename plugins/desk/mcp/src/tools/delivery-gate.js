// What "delivered" means for a pull request, and the done-gate that enforces it.
//
// A merged pull request reaches users through whatever ships its repo. For some changes that is the merge itself; for others
// it is a release that comes minutes or hours later (ourostack/desk: a release run ships plugins/desk, and a failed release
// stops it for hours with nothing about the merge showing it). The repository declares which, in `.desk/delivery.json` at its
// root on the branch the pull request merged into (its base branch, because the rules say how that branch reaches its consumers; a base branch with no file falls back to the default branch's):
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
// A pull request that is not merged is never delivered, whatever the rules. A repo with no policy file (and visible to the caller) defaults to `merge` and the answer says "no delivery rule declared". The policy is read from the repo, not from
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
// Credentials: the requests use GH_TOKEN or GITHUB_TOKEN when set. When neither is, and the caller does not inject its own fetch, the GitHub
// CLI is asked once for a token (`gh auth token --hostname github.com`, 3 seconds at most), so a private repo's rules can be read by an agent that
// is signed in to `gh`. The token goes only into the request headers and is kept in this process's memory; it is never logged, printed or written.
// No `gh`, not signed in, a timeout or an empty answer all leave the request anonymous, exactly as before.
// Limit: a pull request's first 300 changed files are read; more than that is `not_verified`.

import { execFile } from "node:child_process"
import { looksLikeNodeTestRunner } from "../runtime/test-state-guard.js"

export const POLICY_PATH = ".desk/delivery.json"
const REQUEST_BUDGET_MS = 5000
const FILE_PAGES = 3
const GITHUB_PR = /^https:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#].*)?$/iu
const MERGE = Object.freeze({ kind: "merge" })

const GH_TOKEN_BUDGET_MS = 3000
const ghTokens = new WeakMap()

// Asks `gh` (through `exec`, a test seam) and resolves with what it printed; rejects on any error, including the time limit.
export function makeRunGh(exec = execFile) {
  return (args) =>
    new Promise((resolve, reject) => {
      exec("gh", args, { timeout: GH_TOKEN_BUDGET_MS, maxBuffer: 65536, windowsHide: true }, (error, stdout) => (error === null ? resolve(String(stdout)) : reject(error)))
    })
}
const runGh = makeRunGh()
// istanbul ignore next -- the real `gh` is chosen only when no fetch was injected; every test injects its own.
const defaultRunner = (fetchFn) => (fetchFn === undefined ? runGh : undefined)

// The token `gh` holds for github.com, or undefined. The lookup is made once per runner for the life of the process, failure included, and
// concurrent callers share the one in flight, so a hanging `gh` costs one time limit, not one per call.
function ghToken(run) {
  if (!ghTokens.has(run)) {
    ghTokens.set(
      run,
      (async () => {
        try {
          return String(await run(["auth", "token", "--hostname", "github.com"])).trim() || undefined
        } catch {
          return undefined
        }
      })(),
    )
  }
  return ghTokens.get(run)
}

async function github({ fetchFn, env, budgetMs, token: fromGh }, route, accept = "application/vnd.github+json") {
  const headers = { "User-Agent": "desk-delivery-gate", Accept: accept }
  const token = [env.GH_TOKEN, env.GITHUB_TOKEN].find((value) => typeof value === "string" && value.trim() !== "") ?? fromGh
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
const hiddenReason = (repo, status) => `${repo} is not visible to GitHub requests from here (${why(status)}), so whether it declares delivery rules is unknown; set GH_TOKEN or sign in with gh (gh auth login) for a private repo`

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

function usableRule(rule) {
  const at = rule?.delivered_at
  if (!Array.isArray(rule?.paths) || rule.paths.length === 0 || !rule.paths.every((entry) => typeof entry === "string" && entry !== "") || at === null || typeof at !== "object") return null
  if (at.kind === "merge") return { paths: rule.paths.map(globToRegExp), delivered_at: MERGE, label: "merge" }
  if (at.kind === "github_label" && typeof at.name === "string" && at.name !== "") return { paths: rule.paths.map(globToRegExp), delivered_at: { kind: at.kind, name: at.name }, label: `the \`${at.name}\` label` }
  return null
}

/**
 * Is pull request `repo`#`number` delivered? Never throws. `{ status: "delivered", basis }` (`basis` says why: "no delivery rule declared",
 * "merge", the label), `{ status: "undelivered", unmet: [{ paths, delivered_at, need }], merged }` with a ready sentence in `need`,
 * `{ status: "not_verified", reason }` when GitHub could not answer, `{ status: "not_found" }` for a pull request GitHub does not know.
 * `fetchFn`, `budgetMs` (per request) and `ghRunner` (asks `gh` for a token) are test seams; a caller that injects `fetchFn` without `ghRunner` never runs `gh`.
 */
export async function prDelivery({ repo, number, env = process.env, fetchFn, budgetMs = REQUEST_BUDGET_MS, ghRunner }) {
  const runner = ghRunner ?? defaultRunner(fetchFn)
  const inEnv = [env.GH_TOKEN, env.GITHUB_TOKEN].some((value) => typeof value === "string" && value.trim() !== "")
  const token = inEnv || runner === undefined ? undefined : await ghToken(runner)
  // istanbul ignore next -- outside a node:test run the real fetch is used; every test hands its own.
  const ask = { fetchFn: fetchFn ?? globalThis.fetch, env, budgetMs, token }
  // The pull request comes first: it must exist, and its base branch says which copy of the rules applies.
  const prAnswer = await github(ask, `/repos/${repo}/pulls/${number}`)
  if (prAnswer.status === 404) {
    // A private or hidden repo also answers 404, so "no such pull request" is believed only when the repo itself is visible.
    const visible = await github(ask, `/repos/${repo}`)
    return visible.status === 200 ? { status: "not_found" } : notVerified(hiddenReason(repo, visible.status))
  }
  const pr = prAnswer.status === 200 ? parse(prAnswer.body) : null
  if (pr === null || !Array.isArray(pr.labels)) return notVerified(`pull request ${repo}#${number} could not be read from GitHub (${why(prAnswer.status)})`)

  // Not merged is never delivered, whatever the rules say.
  if (!pr.merged_at) return { status: "undelivered", unmet: [{ need: "be merged" }], merged: false }

  // The rules describe how the branch the pull request merged into reaches its consumers, so they are read from that branch. A base branch
  // with no rules file (a release branch, a stacked branch, a deleted base) falls back to the default branch's rules.
  const baseRef = typeof pr.base?.ref === "string" ? pr.base.ref : ""
  const rulesAt = (ref) => github(ask, `/repos/${repo}/contents/${POLICY_PATH}${ref === "" ? "" : `?ref=${encodeURIComponent(ref)}`}`, "application/vnd.github.raw+json")
  let policyAnswer = await rulesAt(baseRef)
  if (policyAnswer.status === 404) {
    // A private or hidden repo also answers 404, so "no rules" is believed only when the repo itself is visible.
    const visible = await github(ask, `/repos/${repo}`)
    if (visible.status !== 200) return notVerified(hiddenReason(repo, visible.status))
    if (baseRef !== "" && parse(visible.body)?.default_branch !== baseRef) policyAnswer = await rulesAt("")
  }
  let rules = null
  if (policyAnswer.status !== 404) {
    if (policyAnswer.status !== 200) return notVerified(`${repo}'s delivery rules could not be read from GitHub (${why(policyAnswer.status)})`)
    const policy = parse(policyAnswer.body)
    rules = Array.isArray(policy?.rules) ? policy.rules.map(usableRule) : []
    if (rules.length === 0 || rules.includes(null)) return notVerified(`${repo}'s ${POLICY_PATH} is not a usable delivery policy (every rule needs \`paths\` and a \`delivered_at\` of kind merge or github_label)`)
  }

  if (rules === null) return { status: "delivered", basis: `no delivery rule declared in ${repo} (${POLICY_PATH}); merge counts as delivery` }
  if (rules.every((rule) => rule.delivered_at.kind === "merge")) return { status: "delivered", basis: "every rule delivers at merge" }
  const labels = new Set(pr.labels.map((label) => label?.name))

  // Which rules does this pull request's change fall under? Files are read only when a rule that needs more than the merge exists.
  const changed = []
  for (let page = 1; page <= FILE_PAGES; page += 1) {
    const filesAnswer = await github(ask, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)
    const files = filesAnswer.status === 200 ? parse(filesAnswer.body) : null
    if (!Array.isArray(files)) return notVerified(`the files of ${repo}#${number} could not be read from GitHub (${why(filesAnswer.status)})`)
    changed.push(...files.map((file) => String(file?.filename ?? "")).filter((name) => name !== ""))
    if (files.length < 100) break
    if (page === FILE_PAGES) return notVerified(`${repo}#${number} changes more than ${FILE_PAGES * 100} files, so its rules cannot be matched`)
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
    if (labels.has(at.name)) bases.push(`carries the \`${at.name}\` label`)
    else unmet.push({ delivered_at: at, need: `carry ${rule.label}` })
  }
  if (unmet.length === 0) return { status: "delivered", basis: bases.length === 0 ? "its changes deliver at merge" : bases.join(" and ") }
  return { status: "undelivered", unmet, merged: true }
}

/**
 * The done-gate's use of `prDelivery`: null when `evidence` is not a GitHub pull request URL (or a node:test run gave no fetch), otherwise
 * the answer, thrown as a refusal naming the pull request when it is `undelivered` or `not_found`. The caller reports `not_verified`.
 */
export async function checkDelivery({ toolName, evidence, env = process.env, fetchFn, budgetMs, ghRunner }) {
  const match = evidence.kind === "pr" ? GITHUB_PR.exec(evidence.ref.trim()) : null
  if (match === null) return null
  if (fetchFn === undefined && looksLikeNodeTestRunner(env)) return null
  const repo = `${match[1]}/${match[2]}`
  const number = Number(match[3])
  const answer = await prDelivery({ repo, number, env, fetchFn, budgetMs, ghRunner })
  if (answer.status === "not_found") throw new Error(`${toolName}: ${evidence.ref.trim()} does not exist on GitHub, so nothing can carry it. Supply the URL of the pull request that did the work.`)
  if (answer.status === "undelivered") {
    const need = answer.unmet.map((entry) => entry.need).join(" and ")
    if (!answer.merged) throw new Error(`${toolName}: ${repo}#${number} is not delivered: the pull request is not merged. Merge it, and wait for the release that carries it, before closing the task.`)
    throw new Error(
      `${toolName}: ${repo}#${number} is not delivered yet: ${repo} ships these changes through more than the merge, so the pull request must ${need}, and it does not. ` +
        `The release has not carried it yet. ` +
        "Leave the task at `validating`, check the release run (the \"Desk release needs attention\" issue lists a failed one) and repeat this call once that is true.",
    )
  }
  return answer
}
