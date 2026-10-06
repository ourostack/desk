// Which Desk release first carries a merged countermeasure. The verify step
// needs a shipped version for a card; a person does not supply it. Desk has no
// tags or GitHub releases, so a release is a commit that changed the plugin's
// version file.
//
// `shippedVersion({ plugin, countermeasure, client, maxCalls }) -> { state:
// "version", version } | { state: "not_merged" } | { state:
// "not_released_yet" } | { state: "unavailable", reason }`. For a mapped
// plugin (`PLUGIN_REPOS`) and a countermeasure PR in its repository it reads
// the PR; unmerged is `not_merged`. Merged, it lists the commits that changed
// the version file since the merge time (one page of 20, newest first, read
// oldest first), takes the
// first the compare API reports as `ahead` of or `identical` to the merge
// commit, and reads `version` from the file at that commit. Calls that
// succeeded and found no such commit are `not_released_yet`. A lookup that
// could not be made is never `not_released_yet`: it is `unavailable` with one
// stable reason, `plugin_unmapped` (unknown plugin or a PR in another
// repository), `countermeasure_unparsed`, `version_unreadable`, `call_budget`,
// `lookup_failed`, `too_many_releases`, or the reader's own code
// (`gh_missing`, `timeout`, `http_<status>`, `gh_failed`, `unexpected_answer`).
//
// A full page (20 commits) may hide older ones, and the true first release is
// the oldest, so a full page is `unavailable` `too_many_releases` and is never
// read as an answer; at most 19 candidates are examined, so the worst case is
// 22 calls (pull, listing, 19 compares, one file read), under the bound of
// `maxCalls` (default 25) that applies to each lookup, not to a reader, so one
// reader serves any number of cards.
//
// `githubReader({ runner, token, timeoutMs }) -> { get(route) }`
// is the small API reader: `get` answers the parsed JSON of a `gh api` GET
// through a runner with the `flush.js` `ghRunner` shape, `(args, { token,
// input, timeoutMs }) -> { code, stdout, stderr, spawnError?, timedOut? }`
// (the token reaches `gh` only as `GH_TOKEN`) and throws an `Error` with a
// stable `code` on failure. It keeps no count: the call bound is per lookup.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

export const PLUGIN_REPOS = { desk: { repo: "ourostack/desk", file: "plugins/desk/plugin.json" } }

export const MAX_CANDIDATES = 20
export const MAX_CALLS = 25
const DEFAULT_TIMEOUT_MS = 60000
const HTTP_STATUS = /\(HTTP (\d{3})\)/u
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,8})$/u

function failure(code) {
  const error = new Error(`release version: ${code}`)
  error.code = code
  return error
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/** `parsePrUrl(url) -> { repo, number } | null`: only `https://github.com/<owner>/<repo>/pull/<n>`. */
export function parsePrUrl(url) {
  const match = typeof url === "string" ? PR_URL.exec(url) : null
  return match === null ? null : { repo: match[1], number: Number(match[2]) }
}

/** See the header. */
export function githubReader({ runner, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof runner !== "function") throw new TypeError("githubReader: runner must be a function")
  if (typeof token !== "string" || token === "") throw new TypeError("githubReader: token must be a non-empty string")
  return {
    async get(route) {
      const args = ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", route]
      const result = await runner(args, { token, timeoutMs })
      if (result.spawnError === "ENOENT") throw failure("gh_missing")
      if (result.timedOut === true) throw failure("timeout")
      if (result.code !== 0) {
        const status = HTTP_STATUS.exec(String(result.stderr))?.[1]
        throw failure(status === undefined ? "gh_failed" : `http_${status}`)
      }
      try {
        return JSON.parse(String(result.stdout))
      } catch {
        throw failure("unexpected_answer")
      }
    },
  }
}

function versionOf(content) {
  if (!isObject(content) || content.encoding !== "base64" || typeof content.content !== "string") throw failure("unexpected_answer")
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(content.content, "base64").toString("utf8"))
  } catch {
    throw failure("version_unreadable")
  }
  if (!isObject(parsed) || typeof parsed.version !== "string" || parsed.version === "") throw failure("version_unreadable")
  return parsed.version
}

async function find({ repo, file }, number, client) {
  const pull = await client.get(`repos/${repo}/pulls/${number}`)
  if (!isObject(pull)) throw failure("unexpected_answer")
  if (pull.merged_at === null || pull.merged_at === undefined) return { state: "not_merged" }
  if (typeof pull.merged_at !== "string" || typeof pull.merge_commit_sha !== "string" || pull.merge_commit_sha === "") throw failure("unexpected_answer")
  const listed = await client.get(`repos/${repo}/commits?path=${encodeURIComponent(file)}&since=${encodeURIComponent(pull.merged_at)}&per_page=${MAX_CANDIDATES}`)
  if (!Array.isArray(listed) || listed.some((item) => !isObject(item) || typeof item.sha !== "string")) throw failure("unexpected_answer")
  if (listed.length >= MAX_CANDIDATES) throw failure("too_many_releases")
  const candidates = listed.map((item) => item.sha).reverse()
  for (const candidate of candidates) {
    const compared = await client.get(`repos/${repo}/compare/${pull.merge_commit_sha}...${candidate}`)
    if (!isObject(compared) || typeof compared.status !== "string") throw failure("unexpected_answer")
    if (compared.status !== "ahead" && compared.status !== "identical") continue
    return { state: "version", version: versionOf(await client.get(`repos/${repo}/contents/${file}?ref=${candidate}`)) }
  }
  return { state: "not_released_yet" }
}

/** See the header. */
export async function shippedVersion({ plugin, countermeasure, client, maxCalls = MAX_CALLS }) {
  const mapped = Object.hasOwn(PLUGIN_REPOS, plugin) ? PLUGIN_REPOS[plugin] : null
  if (mapped === null) return { state: "unavailable", reason: "plugin_unmapped" }
  const pr = parsePrUrl(countermeasure)
  if (pr === null) return { state: "unavailable", reason: "countermeasure_unparsed" }
  if (pr.repo !== mapped.repo) return { state: "unavailable", reason: "plugin_unmapped" }
  try {
    let calls = 0
    const counted = {
      get(route) {
        if (calls >= maxCalls) throw failure("call_budget")
        calls += 1
        return client.get(route)
      },
    }
    return await find(mapped, pr.number, counted)
  } catch (error) {
    return { state: "unavailable", reason: typeof error?.code === "string" ? error.code : "lookup_failed" }
  }
}
