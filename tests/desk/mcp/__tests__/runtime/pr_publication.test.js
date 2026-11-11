import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { publicationPolicy, publicationRecovery, publishPullRequest } from "../../../../../plugins/desk/mcp/src/runtime/pr-publication.js"

const head = "a".repeat(40)
const onto = "b".repeat(40)
const merged = "c".repeat(40)
const policy = { schema_version: 1, mode: "pull-request", required_checks: ["workspace-policy"] }
const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) })
const success = { name: "workspace-policy", status: "COMPLETED", conclusion: "SUCCESS" }

function fixture(options = {}) {
  const calls = []
  let created = false
  let views = 0
  let checkReads = 0
  let statusReads = 0
  const runIds = new Map()
  let elapsed = 0
  const pr = {
    number: 42, url: "https://github.example/example/workspace/pull/42", state: "OPEN", isDraft: false,
    headRefOid: head, baseRefName: "main", baseRefOid: onto, statusCheckRollup: [success],
    ...options.pr,
  }
  let currentPr = pr
  const git = (args) => {
    calls.push(["git", ...args])
    if (args[0] === "remote") return options.remoteResult ?? { status: 0, stdout: options.remote ?? "https://github.example/example/workspace.git" }
    if (args[0] === "push") return options.pushResult ?? { status: 0 }
    if (args[0] === "fetch") return options.fetchResult ?? { status: 0 }
    if (args[0] === "rev-parse") return { status: 0, stdout: merged }
    if (args[0] === "merge-base") return { status: options.ancestryFailure ? 1 : 0 }
    assert.fail(`unexpected git call: ${args.join(" ")}`)
  }
  const spawnGit = (command, args) => {
    assert.equal(command, "gh")
    calls.push(["gh", ...args])
    const operation = args[0] === "api" ? args.includes("PUT") ? "merge" : args.some((arg) => arg.includes("/status?")) ? "statuses"
      : args.some((arg) => arg.includes("/rules/branches/")) ? "rules" : args.some((arg) => /\/branches\/[^/]+$/u.test(arg)) ? "branch" : "checks" : args[1]
    if (options.fail === operation) return { status: options.timeout ? null : 1, stderr: "made-up-private-credential" }
    if (options.invalidJson === operation) return { status: 0, stdout: "not JSON" }
    if (operation === "rules") {
      assert.ok(args.includes(`repos/example/workspace/rules/branches/${encodeURIComponent(options.pr?.baseRefName ?? "main")}?per_page=100`))
      assert.ok(args.includes("--paginate") && args.includes("--slurp"))
      return ok(options.rules ?? [[]])
    }
    if (operation === "branch") return ok(options.branch ?? { protected: false, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } })
    if (operation === "list") return ok(options.list ?? (options.noReadback || !created && options.create ? [] : [pr]))
    if (operation === "create") { created = true; return { status: 0, stdout: pr.url } }
    if (operation === "view") {
      const current = options.views?.[Math.min(views++, options.views.length - 1)] ?? pr
      currentPr = current
      return ok(current)
    }
    if (operation === "checks") {
      assert.ok(args.includes(`repos/example/workspace/commits/${head}/check-runs?filter=latest&per_page=100`))
      assert.ok(args.includes("--paginate"))
      assert.ok(args.includes("--slurp"))
      if (options.checkPages !== undefined) return ok(options.checkPages[Math.min(checkReads++, options.checkPages.length - 1)])
      const runs = (currentPr.statusCheckRollup ?? []).filter((check) => check.name !== undefined).map((check) => {
        if (!runIds.has(check.name)) runIds.set(check.name, runIds.size + 1)
        return { ...check, id: runIds.get(check.name), status: check.status.toLowerCase(), conclusion: check.conclusion?.toLowerCase() ?? null }
      })
      return ok([{ check_runs: runs }])
    }
    if (operation === "statuses") {
      assert.ok(args.includes(`repos/example/workspace/commits/${head}/status?per_page=100`))
      assert.ok(args.includes("--paginate"))
      assert.ok(args.includes("--slurp"))
      if (options.statusPages !== undefined) return ok(options.statusPages[Math.min(statusReads++, options.statusPages.length - 1)])
      const statuses = currentPr.statusCheckRollup?.filter((check) => check.context !== undefined).map((check) => ({ context: check.context, state: check.state.toLowerCase() })) ?? null
      return ok([{ statuses }])
    }
    if (operation === "merge") return ok(options.mergeResult ?? { merged: true, sha: merged })
    assert.fail(`unexpected gh call: ${args.join(" ")}`)
  }
  const request = {
    git, spawnGit, root: "/made-up/workspace", upstream: { remote: "origin", merge: "refs/heads/main", tracking: "refs/remotes/origin/main" },
    head, onto, policy,
    clock: { now: () => elapsed, sleep: (ms) => { elapsed += ms } },
  }
  return { calls, request, pr }
}

test("published policy is absent, valid, or explicitly refused before delivery", () => {
  assert.equal(publicationPolicy(() => ({ status: 0, stdout: "" }), onto), null)
  assert.throws(() => publicationPolicy(() => ({ status: 1 }), onto), /Could not read the published/u)
  assert.throws(() => publicationPolicy((args) => args[0] === "show" ? { status: 1 } : { status: 0, stdout: ".desk/publication.json" }, onto), /Could not read the published/u)
  for (const value of ["{", "null", '{"schema_version":2}', JSON.stringify({ ...policy, mode: "direct" }),
    JSON.stringify({ ...policy, required_checks: null }), JSON.stringify({ ...policy, required_checks: [] }),
    JSON.stringify({ ...policy, required_checks: [12] }), JSON.stringify({ ...policy, required_checks: [" "] })]) {
    assert.throws(() => publicationPolicy((args) => ({ status: 0, stdout: args[0] === "show" ? value : ".desk/publication.json" }), onto), /Published .* (not valid JSON|must specify)/u)
  }
  assert.deepEqual(publicationPolicy((args) => ({ status: 0, stdout: args[0] === "show" ? JSON.stringify(policy) : ".desk/publication.json" }), onto), policy)
})

test("HTTPS, SCP and SSH publication use an exact-head merge and never push upstream", () => {
  for (const remote of ["https://github.example/example/workspace.git", "git@github.example:example/workspace.git", "ssh://git@github.example/example/workspace"]) {
    const f = fixture({ remote, create: true })
    const result = publishPullRequest(f.request)
    assert.equal(result.head, merged)
    assert.equal(result.receipt.merge, merged)
    assert.deepEqual(f.calls.filter((call) => call[1] === "push").map((call) => call.at(-1)), [`${head}:refs/heads/desk/publish/${head}`])
    assert.ok(f.calls.some((call) => call.includes(`sha=${head}`)))
  }
})

test("remote, branch, JSON, lookup, creation and merge failures refuse without credential echoes", () => {
  const cases = [
    [{ remoteResult: { status: 1 } }, /Could not read the publication remote/u],
    [{ remote: "file:///example/workspace" }, /needs a GitHub/u],
    [{ remote: "https://github.example/ambiguous" }, /unambiguous/u],
    [{ remote: "git@bad!host:example/workspace" }, /unambiguous/u],
    [{ pushResult: { status: 1 } }, /branch push was refused.*Fix: git push/u],
    [{ list: {} }, /unambiguous publication PR/u],
    [{ list: [{}, {}] }, /unambiguous publication PR/u],
    [{ create: true, noReadback: true }, /could not be read back/u],
    [{ fail: "list" }, /CLI pr list failed.*exit 1/u],
    [{ fail: "create", create: true }, /CLI pr create failed/u],
    [{ fail: "view", timeout: true }, /CLI pr view failed.*timeout/u],
    [{ invalidJson: "list" }, /invalid publication JSON/u],
    [{ fail: "merge" }, /CLI api --hostname failed/u],
    [{ fail: "checks" }, /CLI api --hostname failed/u],
    [{ invalidJson: "checks" }, /invalid publication JSON/u],
    [{ fail: "statuses" }, /CLI api --hostname failed/u],
    [{ invalidJson: "statuses" }, /invalid publication JSON/u],
    [{ mergeResult: { merged: false, sha: merged } }, /refused the exact-head merge/u],
    [{ mergeResult: { merged: true, sha: null } }, /refused the exact-head merge/u],
    [{ fetchResult: { status: 1 } }, /could not be fetched/u],
    [{ ancestryFailure: true }, /not reachable/u],
  ]
  for (const [options, expected] of cases) {
    const f = fixture(options)
    assert.throws(() => publishPullRequest(f.request), (error) => {
      assert.match(error.message, expected)
      assert.doesNotMatch(error.message, /made-up-private-credential/u)
      return true
    })
  }
})

test("human changes, base drift, absent checks and every failure state refuse automatic merge", () => {
  const changes = [
    { headRefOid: onto }, { baseRefName: "another" }, { isDraft: true }, { state: "CLOSED" },
    { baseRefOid: head }, { statusCheckRollup: null },
    ...["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].map((state) => ({
      statusCheckRollup: [{ context: "workspace-policy", state }],
    })),
    { statusCheckRollup: [] },
    { statusCheckRollup: [{ name: "workspace-policy", status: "IN_PROGRESS" }] },
    { statusCheckRollup: [{ ...success, conclusion: "SKIPPED" }] },
  ]
  for (const pr of changes) {
    const f = fixture({ pr })
    assert.throws(() => publishPullRequest(f.request), (error) => {
      assert.match(error.message, /Fix: gh pr checks/u)
      assert.equal(error.publication.head, head)
      return true
    })
    assert.ok(!f.calls.some((call) => call.includes("PUT")))
  }
})

test("already-merged PRs still require actual upstream proof and return the recorded merge identity", () => {
  for (const mergeCommit of [{ oid: merged }, undefined]) {
    const f = fixture({ pr: { state: "MERGED", mergeCommit } })
    assert.equal(publishPullRequest(f.request).receipt.merge, merged)
    assert.ok(!f.calls.some((call) => call.includes("PUT")))
  }
})

test("context checks, optional skipped/neutral checks and an observed pending check are qualified", () => {
  const optional = [{ context: "optional", state: "NEUTRAL" }, { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" }]
  const initial = { ...fixture().pr, statusCheckRollup: [{ context: "workspace-policy", state: "SUCCESS" }, ...optional, { context: "later", state: "PENDING" }] }
  const ready = { ...initial, statusCheckRollup: [{ context: "workspace-policy", state: "SUCCESS" }, ...optional, { context: "later", state: "SUCCESS" }] }
  const server = fixture({ pr: initial, views: [initial, ready] })
  assert.equal(publishPullRequest(server.request).receipt.merge, merged)
})

test("disappearing observed checks cannot authorize a merge, including checks seen in the initial lookup", () => {
  const pending = { context: "later", state: "PENDING" }
  const initial = { ...fixture().pr, statusCheckRollup: [success, pending] }
  const missing = { ...initial, statusCheckRollup: [success] }
  for (const views of [[initial, missing], [missing]]) {
    const f = fixture({ pr: initial, views })
    assert.throws(() => publishPullRequest(f.request), /still missing or pending: later/u)
    assert.ok(!f.calls.some((call) => call.includes("PUT")))
  }
})

test("observed job identities stay pending when another job with the same name succeeds", () => {
  const pending = { name: "same-name", detailsUrl: "https://github.example/jobs/1", status: "IN_PROGRESS" }
  const replacement = { ...pending, detailsUrl: "https://github.example/jobs/2", status: "COMPLETED", conclusion: "SUCCESS" }
  const initial = { ...fixture().pr, statusCheckRollup: [success, pending] }
  const requiredRun = { id: 99, name: "workspace-policy", status: "completed", conclusion: "success" }
  const f = fixture({
    pr: initial, views: [{ ...initial, statusCheckRollup: [success, replacement] }],
    checkPages: [[{ check_runs: [requiredRun, { id: 1, name: pending.name, status: "in_progress", conclusion: null }] }], [{ check_runs: [requiredRun, { id: 2, name: replacement.name, status: "completed", conclusion: "success" }] }]],
  })
  assert.throws(() => publishPullRequest(f.request), /still missing or pending: same-name/u)
  assert.ok(!f.calls.some((call) => call.includes("PUT")))
})

test("an observed context can disappear temporarily and then complete before merging", () => {
  const pending = { context: "later", targetUrl: "https://github.example/status/1", state: "PENDING" }
  const initial = { ...fixture().pr, statusCheckRollup: [success, pending] }
  const missing = { ...initial, statusCheckRollup: [success] }
  const ready = { ...initial, statusCheckRollup: [success, { ...pending, state: "SUCCESS" }] }
  const f = fixture({ views: [initial, missing, ready] })
  assert.equal(publishPullRequest(f.request).receipt.merge, merged)
  assert.equal(f.calls.filter((call) => call[2] === "view").length, 3)
})

test("contexts sharing a target URL keep independent observed identities", () => {
  const pending = { context: "later", targetUrl: "https://github.example/status", state: "PENDING" }
  const required = { context: "workspace-policy", targetUrl: pending.targetUrl, state: "SUCCESS" }
  const initial = { ...fixture().pr, statusCheckRollup: [pending, required] }
  const f = fixture({ pr: initial, views: [{ ...initial, statusCheckRollup: [required] }] })
  assert.throws(() => publishPullRequest(f.request), /still missing or pending: later/u)
  assert.ok(!f.calls.some((call) => call.includes("PUT")))
})

test("status contexts can complete when their results URL appears or changes", () => {
  for (const before of [null, "https://github.example/status/started"]) {
    const pending = { context: "later", targetUrl: before, state: "PENDING" }
    const initial = { ...fixture().pr, statusCheckRollup: [success, pending] }
    const ready = { ...initial, statusCheckRollup: [success, { ...pending, targetUrl: "https://github.example/status/completed", state: "SUCCESS" }] }
    const f = fixture({ views: [initial, ready] })
    assert.equal(publishPullRequest(f.request).receipt.merge, merged)
  }
})

test("the same check run can complete when its results URL appears or changes", () => {
  for (const before of [null, "https://github.example/jobs/started"]) {
    const pending = { name: "later", detailsUrl: before, status: "IN_PROGRESS" }
    const initial = { ...fixture().pr, statusCheckRollup: [success, pending] }
    const ready = { ...initial, statusCheckRollup: [success, { ...pending, detailsUrl: "https://github.example/jobs/completed", status: "COMPLETED", conclusion: "SUCCESS" }] }
    const f = fixture({ views: [initial, ready] })
    assert.equal(publishPullRequest(f.request).receipt.merge, merged)
  }
})

test("check-run pagination is complete and malformed immutable identities fail closed", () => {
  const pages = [{ check_runs: [{ id: 1, name: "workspace-policy", status: "completed", conclusion: "success" }] }, { check_runs: [{ id: 2, name: "optional", status: "completed", conclusion: "success" }] }]
  assert.equal(publishPullRequest(fixture({ checkPages: [pages] }).request).receipt.merge, merged)
  for (const invalid of [null, {}, [], [null], [{ check_runs: null }],
    ...[null, { name: "job" }, { id: 0, name: "job" }, { id: 1 }, { id: 1, name: " " }, { id: 1, name: "job" }, { id: 1, name: "job", status: "completed", conclusion: null }].map((run) => [{ check_runs: [run] }])]) {
    const f = fixture({ checkPages: [invalid] })
    assert.throws(() => publishPullRequest(f.request), /GitHub did not return.*check/u)
    assert.ok(!f.calls.some((call) => call.includes("PUT")))
  }
})

test("status-context pagination is complete and malformed status states fail closed", () => {
  const pages = [{ statuses: [{ context: "workspace-policy", state: "success" }] }, { statuses: [{ context: "optional", state: "success" }] }]
  assert.equal(publishPullRequest(fixture({ statusPages: [pages], checkPages: [[{ check_runs: [] }]] }).request).receipt.merge, merged)
  for (const invalid of [null, {}, [], [null], [{ statuses: null }],
    ...[null, {}, { context: " " }, { context: "job", state: null }].map((status) => [{ statuses: [status] }])]) {
    const f = fixture({ statusPages: [invalid] })
    assert.throws(() => publishPullRequest(f.request), /GitHub did not return.*check/u)
    assert.ok(!f.calls.some((call) => call.includes("PUT")))
  }
})

test("recovery commands preserve simple and metacharacter paths in POSIX shells and PowerShell", () => {
  for (const platform of ["linux", "win32"]) {
    const special = platform === "win32" ? "C:\\Desk Space\\O'Brien\\$DeskReviewMissing\\`literal`" : "/Desk Space/O'Brien/$DeskReviewMissing/`literal`"
    for (const root of ["/made-up/workspace", special]) {
      const command = publicationRecovery(root, platform)
      const args = platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", `function node { ConvertTo-Json -Compress -InputObject @($args) }; ${command}`]
        : ["-c", `node() { printf '%s\\0' "$@"; }; ${command}`]
      const result = spawnSync(platform === "win32" ? "pwsh" : "bash", args, { encoding: "utf8", timeout: 10_000 })
      assert.equal(result.status, 0, result.stderr)
      const actual = platform === "win32" ? JSON.parse(result.stdout) : result.stdout.split("\0").slice(0, -1)
      assert.equal(actual.length, 3)
      assert.equal(actual[1], "--root")
      assert.equal(actual[2], root)
      assert.match(actual[0], /sync-push\.js$/u)
    }
  }
})

test("the production clock waits once for a pending check before exact-head publication", () => {
  const pending = { ...fixture().pr, statusCheckRollup: [] }
  const ready = { ...pending, statusCheckRollup: [success] }
  const f = fixture({ views: [pending, ready] })
  delete f.request.clock
  assert.equal(publishPullRequest(f.request).receipt.merge, merged)
})

const ruleset = (...contexts) => [[{ type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: contexts.map((context) => ({ context, integration_id: 1 })) } }]]
const protectedBranch = (...contexts) => ({ protected: true, protection: { enabled: true, required_status_checks: { contexts, checks: [] } } })
const run = (name, conclusion) => conclusion === undefined ? { name, status: "IN_PROGRESS" } : { name, status: "COMPLETED", conclusion }

test("a reported check the policy does not name blocks the merge while it is pending or failing", () => {
  const pending = fixture({ pr: { statusCheckRollup: [success, run("repository-validation")] } })
  assert.throws(() => publishPullRequest(pending.request), /still missing or pending: repository-validation/u)
  assert.ok(!pending.calls.some((call) => call.includes("PUT")))
  const failing = fixture({ pr: { statusCheckRollup: [success, { context: "repository-validation", state: "FAILURE" }] } })
  assert.throws(() => publishPullRequest(failing.request), /PR check repository-validation failed \(FAILURE\)/u)
  assert.ok(!failing.calls.some((call) => call.includes("PUT")))
})

test("a check the base branch's rules or protection require blocks the merge until it is reported", () => {
  for (const options of [{ rules: ruleset("ci-gate") }, { branch: protectedBranch("ci-gate") }]) {
    const f = fixture(options)
    assert.throws(() => publishPullRequest(f.request), /still missing or pending: ci-gate/u)
    assert.ok(!f.calls.some((call) => call.includes("PUT")))
  }
})

test("every reported check passing, with branch-required checks present, merges the exact head", () => {
  const checks = [success, run("ci-gate", "SUCCESS"), run("path-filtered", "SKIPPED"), { context: "legacy-required", state: "SUCCESS" }, run("extra", "SUCCESS")]
  const later = fixture({ pr: { statusCheckRollup: [success] }, views: [{ ...fixture().pr, statusCheckRollup: [success] }, { ...fixture().pr, statusCheckRollup: checks }],
    rules: ruleset("ci-gate", "path-filtered"), branch: protectedBranch("legacy-required") })
  assert.equal(publishPullRequest(later.request).receipt.merge, merged)
  assert.ok(later.calls.some((call) => call.includes(`sha=${head}`)))
  const slashed = fixture({ pr: { baseRefName: "release/2026", statusCheckRollup: checks }, rules: ruleset("ci-gate") })
  slashed.request.upstream = { ...slashed.request.upstream, merge: "refs/heads/release/2026" }
  assert.equal(publishPullRequest(slashed.request).receipt.merge, merged)
  assert.ok(slashed.calls.some((call) => call.includes("repos/example/workspace/branches/release%2F2026")))
})

test("an unreadable or malformed branch-rules read refuses clearly and never merges", () => {
  const cases = [
    { fail: "rules" }, { fail: "branch" }, { invalidJson: "rules" }, { fail: "rules", timeout: true },
    { rules: {} }, { rules: [{}] }, { rules: [[null]] }, { rules: [[{ type: "required_status_checks" }]] },
    { rules: [[{ type: "required_status_checks", parameters: { required_status_checks: [{ context: " " }] } }]] },
    { branch: {} }, { branch: { protected: true, protection: { required_status_checks: { contexts: "ci-gate" } } } },
    { branch: protectedBranch(null) }, { branch: { protected: true } }, { branch: { protected: true, protection: { enabled: false } } },
  ]
  for (const options of cases) {
    const f = fixture(options)
    assert.throws(() => publishPullRequest(f.request), (error) => {
      assert.match(error.message, /Could not read the checks github\.example\/example\/workspace requires on main .*will not be merged.*Fix: gh pr checks/u)
      assert.doesNotMatch(error.message, /made-up-private-credential/u)
      return true
    })
    assert.ok(!f.calls.some((call) => call.includes("PUT")), JSON.stringify(options))
  }
})
