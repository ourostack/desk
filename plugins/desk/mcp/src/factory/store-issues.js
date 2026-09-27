// A factory store's issues, through `gh api`: what the kaizen check, andon
// and the friction drain read and write. Every call goes through a runner
// with the `flush.js` `ghRunner` shape, `(args, { token, input, timeoutMs })
// -> { code, stdout, stderr, spawnError?, timedOut? }`, so the token reaches
// `gh` only as `GH_TOKEN` and never as an argument. Answers are parsed as
// data and reduced to the few fields the callers use.
//
// Failures throw an `Error` whose `code` is one stable value: `gh_missing`,
// `timeout`, `http_<status>` for an HTTP error, `unexpected_answer` for an
// answer of the wrong shape, `too_many_issues` or `too_many_comments` past
// the page limit of the list that overflowed, or `gh_failed`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { PATTERNS } from "./schema.js"

const PER_PAGE = 100
const MAX_PAGES = 20
const DEFAULT_TIMEOUT_MS = 60000
const HTTP_STATUS = /\(HTTP (\d{3})\)/u
const STATES = new Set(["open", "closed", "all"])

function failure(code) {
  const error = new Error(`factory issues: ${code}`)
  error.code = code
  return error
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function issueView(raw) {
  if (!isObject(raw) || !Number.isSafeInteger(raw.number) || !Array.isArray(raw.labels)) throw failure("unexpected_answer")
  return {
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    labels: raw.labels.map((label) => (isObject(label) ? label.name : label)).filter((name) => typeof name === "string"),
    state: raw.state === "closed" ? "closed" : "open",
    author: typeof raw.user?.login === "string" ? raw.user.login : null,
    pull_request: raw.pull_request !== undefined && raw.pull_request !== null,
  }
}

function commentView(raw) {
  if (!isObject(raw) || !Number.isSafeInteger(raw.id)) throw failure("unexpected_answer")
  return { id: raw.id, author: typeof raw.user?.login === "string" ? raw.user.login : null, body: typeof raw.body === "string" ? raw.body : "" }
}

/**
 * `issuesClient({ runner, repo, token, timeoutMs }) -> client`: `listIssues({
 * label, state })`, `listComments(number)`, `createComment(number, body)`,
 * `updateComment(id, body)`, `addLabels(number, labels)`,
 * `removeLabel(number, label)`, `createIssue({ title, body, labels }) -> {
 * number, url }` and `updateIssue(number, patch)` for the store `repo`.
 */
export function issuesClient({ runner, repo, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof runner !== "function") throw new TypeError("issuesClient: runner must be a function")
  if (typeof repo !== "string" || !PATTERNS.prRepo.test(repo)) throw new TypeError("issuesClient: repo must be owner/repo")
  if (typeof token !== "string" || token === "") throw new TypeError("issuesClient: token must be a non-empty string")

  async function api(method, route, body) {
    const args = ["api", "--method", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", route]
    if (body !== undefined) args.push("--input", "-")
    const result = await runner(args, { token, input: body === undefined ? undefined : JSON.stringify(body), timeoutMs })
    if (result.spawnError === "ENOENT") throw failure("gh_missing")
    if (result.timedOut === true) throw failure("timeout")
    if (result.code !== 0) {
      const status = HTTP_STATUS.exec(String(result.stderr ?? ""))?.[1]
      throw failure(status === undefined ? "gh_failed" : `http_${status}`)
    }
    const text = String(result.stdout ?? "")
    if (text.trim() === "") return null
    try {
      return JSON.parse(text)
    } catch {
      throw failure("unexpected_answer")
    }
  }

  async function pages(route, view, overflow) {
    const items = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await api("GET", `${route}${route.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`)
      if (!Array.isArray(answer)) throw failure("unexpected_answer")
      items.push(...answer.map(view))
      if (answer.length < PER_PAGE) return items
    }
    throw failure(overflow)
  }

  const base = `repos/${repo}`
  return {
    async listIssues({ label, state }) {
      if (typeof label !== "string" || !STATES.has(state)) throw new TypeError("listIssues: label and state are required")
      return pages(`${base}/issues?state=${state}&labels=${encodeURIComponent(label)}`, issueView, "too_many_issues")
    },
    async listComments(number) {
      return pages(`${base}/issues/${number}/comments`, commentView, "too_many_comments")
    },
    async createComment(number, body) {
      await api("POST", `${base}/issues/${number}/comments`, { body })
    },
    async updateComment(id, body) {
      await api("PATCH", `${base}/issues/comments/${id}`, { body })
    },
    async addLabels(number, labels) {
      await api("POST", `${base}/issues/${number}/labels`, { labels })
    },
    async removeLabel(number, label) {
      await api("DELETE", `${base}/issues/${number}/labels/${encodeURIComponent(label)}`)
    },
    async createIssue({ title, body, labels }) {
      const answer = await api("POST", `${base}/issues`, { title, body, labels })
      if (!isObject(answer) || !Number.isSafeInteger(answer.number) || typeof answer.html_url !== "string") throw failure("unexpected_answer")
      return { number: answer.number, url: answer.html_url }
    },
    async updateIssue(number, patch) {
      await api("PATCH", `${base}/issues/${number}`, patch)
    },
  }
}
