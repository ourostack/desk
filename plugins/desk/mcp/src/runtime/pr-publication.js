import { fileURLToPath } from "node:url"
import { shellQuote } from "../util/shell-quote.js"

const POLICY = ".desk/publication.json"
const FIELDS = "number,url,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeCommit"
const WAIT_MS = 300_000
const CLOCK = {
  now: Date.now,
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}

export function publicationPolicy(git, commit) {
  const listed = git(["ls-tree", "--full-tree", "--name-only", commit, "--", POLICY])
  if (listed.status !== 0) throw Object.assign(new Error(`Check the published publication policy, then try again: Could not read the published ${POLICY}`), { code: "pr_publication_check_the_published_publication_policy_2" })
  if (listed.stdout.trim() === "") return null
  const read = git(["show", `${commit}:${POLICY}`])
  if (read.status !== 0) throw Object.assign(new Error(`Check the published publication policy, then try again: Could not read the published ${POLICY}`), { code: "pr_publication_check_the_published_publication_policy" })
  let policy
  try { policy = JSON.parse(read.stdout) } catch { throw Object.assign(new Error(`Fix the published policy's JSON: Published ${POLICY} is not valid JSON`), { code: "pr_publication_fix_the_published_policy_s" }) }
  if (policy?.schema_version !== 1 || policy.mode !== "pull-request" ||
      !Array.isArray(policy.required_checks) || policy.required_checks.length === 0 ||
      policy.required_checks.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw Object.assign(new Error(`Set schema_version 1, mode pull-request and nonempty required_checks in the published policy: Published ${POLICY} must specify schema_version 1, mode pull-request, and nonempty required_checks`), { code: "pr_publication_set_schema_version_1_mode" })
  }
  return policy
}

function repository(remote) {
  const scp = /^git@([^:]+):(.+)$/u.exec(remote)
  let host, name
  if (scp !== null) [host, name] = scp.slice(1)
  else {
    const url = new URL(remote)
    if (!["https:", "ssh:"].includes(url.protocol)) throw Object.assign(new Error("Give the repository a GitHub HTTPS or SSH remote: PR publication needs a GitHub HTTPS or SSH remote"), { code: "pr_publication_give_the_repository_a_github" })
    host = url.hostname
    name = url.pathname.replace(/^\//u, "")
  }
  name = name.replace(/\.git$/u, "")
  if (!/^[\w.-]+$/u.test(host) || !/^[\w.-]+\/[\w.-]+$/u.test(name)) throw Object.assign(new Error("Keep one GitHub owner/repository remote: PR publication needs an unambiguous GitHub owner/repository remote"), { code: "pr_publication_keep_one_github_owner_repository" })
  return { host, name, full: `${host}/${name}` }
}

// `required` is the published floor and must succeed; `ruled` comes from the base branch's rules and protection, which GitHub
// satisfies with any passing completion. Every other reported check must also finish passing, so a repository's own
// validation is never skipped because the policy did not name it.
function checkState(checks, required, observed, ruled) {
  for (const check of checks) observed.set(check.id, check.name)
  const bad = checks.find((check) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(check.state))
  if (bad) throw Object.assign(new Error(`Fix the failing check, then try again: PR check ${bad.name} failed (${bad.state})`), { code: "pr_publication_fix_the_failing_check_then" })
  const waiting = [...required.filter((name) => !checks.some((check) => check.name === name && check.state === "SUCCESS")),
    ...ruled.filter((name) => !checks.some((check) => check.name === name))]
  const missing = [...observed].filter(([id]) => !checks.some((check) => check.id === id)).map(([, name]) => name)
  return [...new Set([...waiting, ...missing, ...checks.filter((check) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state)).map((check) => check.name)])]
}

export function commandArgument(value, platform = process.platform) {
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : shellQuote(value)
}

export function publicationRecovery(root, platform = process.platform) {
  const script = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
  return `node ${commandArgument(script, platform)} --root ${commandArgument(root, platform)}`
}

/** Publishes one immutable candidate. No upstream ref is pushed; only GitHub's exact-head merge endpoint can advance it. */
export function publishPullRequest({ git, spawnGit, root, upstream, head, onto, policy, clock = CLOCK }) {
  const remote = git(["remote", "get-url", upstream.remote])
  if (remote.status !== 0) throw Object.assign(new Error("Check the publication remote, then try again: Could not read the publication remote"), { code: "pr_publication_check_the_publication_remote_then" })
  const repo = repository(remote.stdout.trim())
  const base = upstream.merge.replace(/^refs\/heads\//u, "")
  const branch = `desk/publish/${head}`
  const gh = (args, json = true) => {
    const result = spawnGit("gh", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, env: process.env })
    if (result.status !== 0) {
      // Do not echo arbitrary subprocess output, which can contain credentials.
      throw Object.assign(new Error(`Check gh auth status, then try again: GitHub CLI ${args[0]} ${args[1]} failed (exit ${result.status ?? "timeout"}); check gh auth status --hostname ${repo.host}`), { code: "pr_publication_check_gh_auth_status_then" })
    }
    if (!json) return result.stdout
    try { return JSON.parse(result.stdout) } catch { throw Object.assign(new Error("Run it again: GitHub CLI returned invalid publication JSON"), { code: "pr_publication_run_it_again_github_cli" }) }
  }
  const list = () => {
    const prs = gh(["pr", "list", "--repo", repo.full, "--head", branch, "--base", base, "--state", "all", "--json", FIELDS])
    if (!Array.isArray(prs) || prs.length > 1) throw Object.assign(new Error("Run it again: GitHub did not return one unambiguous publication PR"), { code: "pr_publication_run_it_again_github_did_5" })
    return prs[0]
  }
  const loadChecks = () => {
    const paged = (endpoint, field) => {
      const pages = gh(["api", "--hostname", repo.host, `repos/${repo.name}/commits/${head}/${endpoint}`, "--paginate", "--slurp"])
      if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page?.[field]))) {
        throw Object.assign(new Error("Run it again: GitHub did not return complete PR check states"), { code: "pr_publication_run_it_again_github_did_4" })
      }
      return pages.flatMap((page) => page[field])
    }
    const statuses = paged("status?per_page=100", "statuses").map((status) => {
      if (typeof status?.context !== "string" || status.context.trim() === "" || typeof status.state !== "string") {
        throw Object.assign(new Error("Run it again: GitHub did not return valid status-context check states"), { code: "pr_publication_run_it_again_github_did_3" })
      }
      return { id: `context:${status.context}`, name: status.context, state: status.state.toUpperCase() }
    })
    const runs = paged("check-runs?filter=latest&per_page=100", "check_runs").map((run) => {
      if (!Number.isSafeInteger(run?.id) || run.id <= 0 || typeof run.name !== "string" || run.name.trim() === "" || typeof run.status !== "string") {
        throw Object.assign(new Error("Run it again: GitHub did not return stable check-run identities"), { code: "pr_publication_run_it_again_github_did_2" })
      }
      const state = run.status === "completed" ? run.conclusion : "pending"
      if (typeof state !== "string") throw Object.assign(new Error("Run it again: GitHub did not return complete check-run conclusions"), { code: "pr_publication_run_it_again_github_did" })
      return { id: `run:${run.id}`, name: run.name, state: state.toUpperCase() }
    })
    return [...statuses, ...runs]
  }
  // An admin token's API merge bypasses branch protection, so the base branch's required checks are read and enforced here.
  const loadRuledChecks = () => {
    const ref = encodeURIComponent(base)
    const unreadable = (detail) => Object.assign(new Error(`Check access to the repository's required checks, then try again: Could not read the checks ${repo.full} requires on ${base} (${detail}); the publication PR will not be merged without them`), { code: "pr_publication_check_access_to_the_repository" })
    let pages, branch
    try {
      pages = gh(["api", "--hostname", repo.host, `repos/${repo.name}/rules/branches/${ref}?per_page=100`, "--paginate", "--slurp"])
      branch = gh(["api", "--hostname", repo.host, `repos/${repo.name}/branches/${ref}`])
    } catch (error) { throw unreadable(error.message) }
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw unreadable("branch rules were not a list")
    const names = []
    for (const rule of pages.flat()) {
      if (typeof rule?.type !== "string") throw unreadable("a branch rule had no type")
      if (rule.type !== "required_status_checks") continue
      const listed = rule.parameters?.required_status_checks
      if (!Array.isArray(listed) || listed.some((check) => typeof check?.context !== "string" || check.context.trim() === "")) throw unreadable("a required-checks rule had no check names")
      names.push(...listed.map((check) => check.context))
    }
    if (typeof branch?.protected !== "boolean") throw unreadable("branch protection was not reported")
    const contexts = branch.protection?.required_status_checks?.contexts
    if (branch.protected) {
      if (!Array.isArray(contexts) || contexts.some((name) => typeof name !== "string" || name.trim() === "")) throw unreadable("protected-branch checks were not a list of names")
      names.push(...contexts)
    }
    return [...new Set(names)]
  }
  const pushed = git(["push", "--quiet", upstream.remote, `${head}:refs/heads/${branch}`], 60_000)
  if (pushed.status !== 0) throw Object.assign(new Error(`Push the branch with the command below: The contribution branch push was refused by its hook or remote; the upstream branch was not pushed. Fix: push ${commandArgument(`${head}:refs/heads/${branch}`)} to ${commandArgument(upstream.remote)} yourself to read its admission diagnostic`), { code: "pr_publication_push_the_branch_with_the" })
  let pr = list()
  if (pr === undefined) {
    gh(["pr", "create", "--repo", repo.full, "--head", branch, "--base", base, "--title", "Publish workspace changes",
      "--body", `Workspace publication of ${head}. The published ${POLICY} defines the checks required before merging.`], false)
    pr = list()
  }
  if (pr === undefined) throw Object.assign(new Error("Run it again: The created publication PR could not be read back"), { code: "pr_publication_run_it_again_the_created" })
  const receipt = { url: pr.url, head, branch, base }
  const view = () => gh(["pr", "view", String(pr.number), "--repo", repo.full, "--json", FIELDS])
  const verify = (current) => {
    if (current.headRefOid !== head || current.baseRefName !== base || current.isDraft || !["OPEN", "MERGED"].includes(current.state)) {
      throw Object.assign(new Error("Review the pull request, then merge it yourself or run it again: The publication PR was changed, closed, or made draft; it will not be merged automatically"), { code: "pr_publication_review_the_pull_request_then" })
    }
  }
  try {
    verify(pr)
    const observed = new Map()
    const ruled = pr.state === "MERGED" ? [] : loadRuledChecks()
    if (pr.state !== "MERGED") for (const check of loadChecks()) observed.set(check.id, check.name)
    const deadline = clock.now() + WAIT_MS
    for (;;) {
      pr = view()
      verify(pr)
      if (pr.state === "MERGED") break
      if (pr.baseRefOid !== onto) throw Object.assign(new Error("Run it again: The publication base advanced; retry to qualify a fresh candidate"), { code: "pr_publication_run_it_again_the_publication" })
      const reported = loadChecks()
      const waiting = checkState(reported, policy.required_checks, observed, ruled)
      if (waiting.length === 0) {
        const merged = gh(["api", "--hostname", repo.host, "--method", "PUT", `repos/${repo.name}/pulls/${pr.number}/merge`,
          "-f", `sha=${head}`, "-f", "merge_method=merge"])
        if (merged.merged !== true || typeof merged.sha !== "string") throw Object.assign(new Error("Check the pull request's merge requirements, then run it again: GitHub refused the exact-head merge"), { code: "pr_publication_check_the_pull_request_s" })
        receipt.merge = merged.sha
        break
      }
      if (clock.now() >= deadline) {
        const unreported = policy.required_checks.filter((name) => !reported.some((check) => check.name === name))
        throw Object.assign(new Error(`Wait for the checks to finish, then run it again: PR checks still missing or pending: ${waiting.join(", ")}${unreported.length === 0 ? "" : `. Never reported on ${head}: ${unreported.join(", ")}. GitHub Actions will not supply a check that is only posted by running it against this exact commit (for example CIT's cit-check, which runs on a writer's machine); run it on branch ${branch}`}`), { code: "pr_publication_wait_for_the_checks_to" })
      }
      clock.sleep(Math.min(5000, deadline - clock.now()))
    }
    const fetched = git(["fetch", "--quiet", "--no-tags", upstream.remote, `+${upstream.merge}:${upstream.tracking}`], 60_000)
    if (fetched.status !== 0) throw Object.assign(new Error("Run it again: The PR merge could not be fetched for verification"), { code: "pr_publication_run_it_again_the_pr" })
    const target = git(["rev-parse", upstream.tracking]).stdout.trim()
    if (git(["merge-base", "--is-ancestor", head, target]).status !== 0) throw Object.assign(new Error("Run it again once the upstream has caught up: The candidate is not reachable from the actual remote upstream"), { code: "pr_publication_run_it_again_once_the" })
    receipt.merge ??= pr.mergeCommit?.oid ?? target
    return { head: target, receipt }
  } catch (error) {
    error.publication = receipt
    error.message += `. Fix: gh pr checks ${receipt.url}; after resolving it, run ${publicationRecovery(root)}`
    throw error
  }
}
