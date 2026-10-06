// An in-memory GitHub for the release lookup tests: one repository with a
// merged (or unmerged) pull request, the commits that changed one file, a
// relation of each commit to the merge commit, and the file's content at each
// commit. It answers `gh api` calls through the `ghRunner` shape and records
// every call. Nothing here reaches the network or runs a process.

export const TOKEN = "ghs_RELEASE_SENTINEL"
export const REPO = "ourostack/desk"
export const FILE = "plugins/desk/plugin.json"
export const MERGE_SHA = "e".repeat(40)

const ok = (json) => ({ code: 0, stdout: JSON.stringify(json), stderr: "" })
export const httpError = (status, message = "error") => ({ code: 1, stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP ${status})\n` })
export const sha = (n) => n.toString(16).padStart(40, "0")

/**
 * `releases` is newest first, as GitHub lists commits: `{ sha, relation, content }`, where `relation` is the
 * compare status of the commit against the merge commit and `content` is the file's text at it (a string,
 * or `null` for a missing file).
 */
export function fakeReleaseGitHub({ merged = true, mergeSha = MERGE_SHA, releases = [], intercept = null, pull } = {}) {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args: [...args], token: options.token })
    const route = args.find((arg) => /^repos\//u.test(arg)) ?? ""
    const intercepted = intercept?.(route, calls.length)
    if (intercepted !== undefined) return intercepted
    let m
    if ((m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/u.exec(route))) {
      if (pull !== undefined) return pull
      return ok({ number: Number(m[2]), merged_at: merged ? "2026-10-01T00:00:00Z" : null, merge_commit_sha: merged ? mergeSha : null })
    }
    if (/^repos\/[^/]+\/[^/]+\/commits\?/u.test(route)) {
      // Newest first, and only `per_page` of them, as GitHub answers.
      const perPage = Number(new URLSearchParams(route.split("?")[1]).get("per_page") ?? 30)
      return ok(releases.slice(0, perPage).map((release) => ({ sha: release.sha })))
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/u.exec(route))) {
      const release = releases.find((item) => item.sha === m[2])
      return release ? ok({ status: release.relation }) : httpError(404, "Not Found")
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/contents\/(.+)\?ref=([0-9a-f]+)$/u.exec(route))) {
      const release = releases.find((item) => item.sha === m[2])
      if (!release || release.content === null) return httpError(404, "Not Found")
      return ok({ encoding: "base64", content: Buffer.from(release.content, "utf8").toString("base64") })
    }
    return httpError(404, `unmodelled ${route}`)
  }
  return { runner, calls, routes: () => calls.map((call) => call.args.find((arg) => /^repos\//u.test(arg))) }
}

export const pluginJson = (version) => JSON.stringify({ name: "desk", version })
