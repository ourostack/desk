import { fileURLToPath } from "node:url"
import { shellQuote } from "../util/shell-quote.js"

const POLICY = ".desk/publication.json"
const FIELDS = "number,url,state,isDraft,headRefOid,baseRefName,baseRefOid,statusCheckRollup,mergeCommit"
const WAIT_MS = 300_000
const CLOCK = {
  now: Date.now,
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}

export function publicationPolicy(git, commit) {
  const listed = git(["ls-tree", "--full-tree", "--name-only", commit, "--", POLICY])
  if (listed.status !== 0) throw new Error(`Could not read the published ${POLICY}`)
  if (listed.stdout.trim() === "") return null
  const read = git(["show", `${commit}:${POLICY}`])
  if (read.status !== 0) throw new Error(`Could not read the published ${POLICY}`)
  let policy
  try { policy = JSON.parse(read.stdout) } catch { throw new Error(`Published ${POLICY} is not valid JSON`) }
  if (policy?.schema_version !== 1 || policy.mode !== "pull-request" ||
      !Array.isArray(policy.required_checks) || policy.required_checks.length === 0 ||
      policy.required_checks.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new Error(`Published ${POLICY} must specify schema_version 1, mode pull-request, and nonempty required_checks`)
  }
  return policy
}

function repository(remote) {
  const scp = /^git@([^:]+):(.+)$/u.exec(remote)
  let host, name
  if (scp !== null) [host, name] = scp.slice(1)
  else {
    const url = new URL(remote)
    if (!["https:", "ssh:"].includes(url.protocol)) throw new Error("PR publication needs a GitHub HTTPS or SSH remote")
    host = url.hostname
    name = url.pathname.replace(/^\//u, "")
  }
  name = name.replace(/\.git$/u, "")
  if (!/^[\w.-]+$/u.test(host) || !/^[\w.-]+\/[\w.-]+$/u.test(name)) throw new Error("PR publication needs an unambiguous GitHub owner/repository remote")
  return { host, name, full: `${host}/${name}` }
}

const checkIdentity = (check) => JSON.stringify([check.name ?? check.context, check.detailsUrl ?? check.targetUrl ?? null])

function checkState(pr, required, observed) {
  if (!Array.isArray(pr.statusCheckRollup)) throw new Error("GitHub did not return the PR check states")
  const checks = pr.statusCheckRollup.map((check) => ({
    id: checkIdentity(check),
    name: check.name ?? check.context,
    state: check.status === "COMPLETED" ? check.conclusion : check.state ?? "PENDING",
  }))
  for (const check of checks) observed.set(check.id, check.name)
  const bad = checks.find((check) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(check.state))
  if (bad) throw new Error(`PR check ${bad.name} failed (${bad.state})`)
  const waiting = required.filter((name) => !checks.some((check) => check.name === name && check.state === "SUCCESS"))
  const missing = [...observed].filter(([id]) => !checks.some((check) => check.id === id)).map(([, name]) => name)
  return [...new Set([...waiting, ...missing, ...checks.filter((check) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state)).map((check) => check.name)])]
}

function commandArgument(value, platform = process.platform) {
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : shellQuote(value)
}

export function publicationRecovery(root, platform = process.platform) {
  const script = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
  return `node ${commandArgument(script, platform)} --root ${commandArgument(root, platform)}`
}

/** Publishes one immutable candidate. No upstream ref is pushed; only GitHub's exact-head merge endpoint can advance it. */
export function publishPullRequest({ git, spawnGit, root, upstream, head, onto, policy, clock = CLOCK }) {
  const remote = git(["remote", "get-url", upstream.remote])
  if (remote.status !== 0) throw new Error("Could not read the publication remote")
  const repo = repository(remote.stdout.trim())
  const base = upstream.merge.replace(/^refs\/heads\//u, "")
  const branch = `desk/publish/${head}`
  const gh = (args, json = true) => {
    const result = spawnGit("gh", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, env: process.env })
    if (result.status !== 0) {
      // Do not echo arbitrary subprocess output, which can contain credentials.
      throw new Error(`GitHub CLI ${args[0]} ${args[1]} failed (exit ${result.status ?? "timeout"}); check gh auth status --hostname ${repo.host}`)
    }
    if (!json) return result.stdout
    try { return JSON.parse(result.stdout) } catch { throw new Error("GitHub CLI returned invalid publication JSON") }
  }
  const list = () => {
    const prs = gh(["pr", "list", "--repo", repo.full, "--head", branch, "--base", base, "--state", "all", "--json", FIELDS])
    if (!Array.isArray(prs) || prs.length > 1) throw new Error("GitHub did not return one unambiguous publication PR")
    return prs[0]
  }
  const pushed = git(["push", "--quiet", upstream.remote, `${head}:refs/heads/${branch}`], 60_000)
  if (pushed.status !== 0) throw new Error(`The contribution branch push was refused by its hook or remote; the upstream branch was not pushed. Fix: git push ${commandArgument(upstream.remote)} ${commandArgument(`${head}:refs/heads/${branch}`)} to read its admission diagnostic`)
  let pr = list()
  if (pr === undefined) {
    gh(["pr", "create", "--repo", repo.full, "--head", branch, "--base", base, "--title", "Publish workspace changes",
      "--body", `Workspace publication of ${head}. The published ${POLICY} defines the checks required before merging.`], false)
    pr = list()
  }
  if (pr === undefined) throw new Error("The created publication PR could not be read back")
  const receipt = { url: pr.url, head, branch, base }
  const view = () => gh(["pr", "view", String(pr.number), "--repo", repo.full, "--json", FIELDS])
  const verify = (current) => {
    if (current.headRefOid !== head || current.baseRefName !== base || current.isDraft || !["OPEN", "MERGED"].includes(current.state)) {
      throw new Error("The publication PR was changed, closed, or made draft; it will not be merged automatically")
    }
  }
  try {
    const observed = new Map((pr.statusCheckRollup ?? []).map((check) => [checkIdentity(check), check.name ?? check.context]))
    const deadline = clock.now() + WAIT_MS
    for (;;) {
      pr = view()
      verify(pr)
      if (pr.state === "MERGED") break
      if (pr.baseRefOid !== onto) throw new Error("The publication base advanced; retry to qualify a fresh candidate")
      const waiting = checkState(pr, policy.required_checks, observed)
      if (waiting.length === 0) {
        const merged = gh(["api", "--hostname", repo.host, "--method", "PUT", `repos/${repo.name}/pulls/${pr.number}/merge`,
          "-f", `sha=${head}`, "-f", "merge_method=merge"])
        if (merged.merged !== true || typeof merged.sha !== "string") throw new Error("GitHub refused the exact-head merge")
        receipt.merge = merged.sha
        break
      }
      if (clock.now() >= deadline) throw new Error(`PR checks still missing or pending: ${waiting.join(", ")}`)
      clock.sleep(Math.min(5000, deadline - clock.now()))
    }
    const fetched = git(["fetch", "--quiet", "--no-tags", upstream.remote, `+${upstream.merge}:${upstream.tracking}`], 60_000)
    if (fetched.status !== 0) throw new Error("The PR merge could not be fetched for verification")
    const target = git(["rev-parse", upstream.tracking]).stdout.trim()
    if (git(["merge-base", "--is-ancestor", head, target]).status !== 0) throw new Error("The candidate is not reachable from the actual remote upstream")
    receipt.merge ??= pr.mergeCommit?.oid ?? target
    return { head: target, receipt }
  } catch (error) {
    error.publication = receipt
    error.message += `. Fix: gh pr checks ${receipt.url}; after resolving it, run ${publicationRecovery(root)}`
    throw error
  }
}
