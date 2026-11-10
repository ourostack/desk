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
  let elapsed = 0
  const pr = {
    number: 42, url: "https://github.example/example/workspace/pull/42", state: "OPEN", isDraft: false,
    headRefOid: head, baseRefName: "main", baseRefOid: onto, statusCheckRollup: [success],
    ...options.pr,
  }
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
    const operation = args[0] === "api" ? "merge" : args[1]
    if (options.fail === operation) return { status: options.timeout ? null : 1, stderr: "made-up-private-credential" }
    if (options.invalidJson === operation) return { status: 0, stdout: "not JSON" }
    if (operation === "list") return ok(options.list ?? (options.noReadback || !created && options.create ? [] : [pr]))
    if (operation === "create") { created = true; return { status: 0, stdout: pr.url } }
    if (operation === "view") {
      const current = options.views?.[Math.min(views++, options.views.length - 1)] ?? pr
      return ok(current)
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
    assert.match(publicationRecovery(f.request.root), /sync-push\.js.*--root \/made-up\/workspace/u)
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
  const server = fixture({ views: [initial, ready] })
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
  const f = fixture({ pr: initial, views: [{ ...initial, statusCheckRollup: [success, replacement] }] })
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

test("recovery commands preserve literal paths in POSIX shells and PowerShell", () => {
  for (const platform of ["linux", "win32"]) {
    const root = platform === "win32" ? "C:\\Desk Space\\O'Brien\\$DeskReviewMissing\\`literal`" : "/Desk Space/O'Brien/$DeskReviewMissing/`literal`"
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
})

test("the production clock waits once for a pending check before exact-head publication", () => {
  const pending = { ...fixture().pr, statusCheckRollup: [] }
  const ready = { ...pending, statusCheckRollup: [success] }
  const f = fixture({ views: [pending, ready] })
  delete f.request.clock
  assert.equal(publishPullRequest(f.request).receipt.merge, merged)
})
