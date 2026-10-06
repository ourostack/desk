// The delivery gate: a pull request is delivered when its repo's own delivery rules say so (merge, a label, a ref).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { readFileSync } from "node:fs"
import { checkDelivery, prDelivery, makeRunGh, POLICY_PATH } from "../../../../../plugins/desk/mcp/src/tools/delivery-gate.js"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const PR = { kind: "pr", ref: "https://github.com/ourostack/desk/pull/200" }
const LABEL_RULE = { paths: ["plugins/desk/**"], delivered_at: { kind: "github_label", name: "released" } }
const MERGE_RULE = { paths: ["**"], delivered_at: { kind: "merge" } }
const POLICY = { schema_version: 1, rules: [LABEL_RULE, MERGE_RULE] }

// A fake GitHub: routes by path, records every request.
function fakeGitHub({
  policy = { status: 200, body: JSON.stringify(POLICY) },
  pr = { status: 200, body: { labels: [], merged_at: "2026-10-06T00:00:00Z", merge_commit_sha: "abc123" } },
  files = [{ status: 200, body: [{ filename: "plugins/desk/mcp/src/x.js" }] }],
  repo = { status: 200, body: { full_name: "ourostack/desk" } },
  policyByRef = null,
} = {}) {
  const calls = []
  const answer = ({ status, body }) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) })
  const fetchFn = async (url, options) => {
    calls.push({ url, options })
    if (url.includes("/contents/")) {
      if (policyByRef === null) return answer(policy)
      const ref = /[?&]ref=([^&]+)/u.exec(url)
      return answer(policyByRef[ref === null ? "" : decodeURIComponent(ref[1])] ?? { status: 404, body: "" })
    }
    if (url.includes("/files?")) return answer(files[Math.min(Number(/&page=(\d+)/u.exec(url)[1]) - 1, files.length - 1)])
    if (url.endsWith("/repos/ourostack/desk")) return answer(repo)
    return answer(pr)
  }
  return { fetchFn, calls }
}
const ask = (fake, extra = {}) => prDelivery({ repo: "ourostack/desk", number: 200, env: {}, fetchFn: fake.fetchFn, ...extra })
const run = (fake, evidence = PR, env = {}) => checkDelivery({ toolName: "task_update", evidence, env, fetchFn: fake.fetchFn })
const withPolicy = (policy, rest = {}) => fakeGitHub({ policy: { status: 200, body: policy }, ...rest })
const filesOf = (...names) => [{ status: 200, body: [{}, ...names.map((filename) => ({ filename }))] }]

test("a pull request that carries the label is delivered", async () => {
  const fake = fakeGitHub({ pr: { status: 200, body: { labels: [{ name: "released" }], merged_at: "x" } } })
  const answer = await run(fake)
  assert.deepEqual(answer, { status: "delivered", basis: "carries the `released` label" })
  assert.equal(fake.calls[0].url, "https://api.github.com/repos/ourostack/desk/pulls/200")
  assert.equal(fake.calls[1].url, `https://api.github.com/repos/ourostack/desk/contents/${POLICY_PATH}`, "no base branch given: the default branch's rules")
})

test("an unlabeled pull request that changes a ruled path is refused, naming the pull request and that no release carried it", async () => {
  await assert.rejects(run(fakeGitHub()), (error) => {
    assert.match(error.message, /^task_update: ourostack\/desk#200 is not delivered yet/u)
    assert.match(error.message, /must carry the `released` label, and it does not/u)
    assert.match(error.message, /The release has not carried it yet\./u)
    assert.doesNotMatch(error.message, /not merged/u)
    return true
  })
})

test("a pull request that is not merged is never delivered, whatever the rules, and a missing one is refused before the merge-only shortcut", async () => {
  const unmerged = { status: 200, body: { labels: [{ name: "released" }], merged_at: null } }
  await assert.rejects(run(fakeGitHub({ pr: unmerged })), /not delivered: the pull request is not merged/u)
  assert.deepEqual(await ask(withPolicy({ schema_version: 1, rules: [MERGE_RULE] }, { pr: unmerged })), { status: "undelivered", unmet: [{ need: "be merged" }], merged: false })
  assert.equal((await ask(fakeGitHub({ policy: { status: 404, body: "" }, pr: unmerged }))).status, "undelivered")
  assert.deepEqual(await ask(withPolicy({ schema_version: 1, rules: [MERGE_RULE] }, { pr: { status: 404, body: "" } })), { status: "not_found" })
})

test("the first matching rule wins for each file, and a pull request is delivered when every rule it matched is", async () => {
  // Crew files fall under the merge rule before the catch-all, and a Desk file under the label rule.
  const crewOnly = withPolicy({ schema_version: 1, rules: [LABEL_RULE, { paths: ["plugins/crew/**"], delivered_at: { kind: "merge" } }, { paths: ["**"], delivered_at: { kind: "github_label", name: "never" } }] }, { files: filesOf("plugins/crew/skills/a.md") })
  assert.equal((await ask(crewOnly)).status, "delivered")
  // A catch-all label rule still applies to a file nothing earlier matched.
  const stray = withPolicy({ schema_version: 1, rules: [LABEL_RULE, { paths: ["**"], delivered_at: { kind: "github_label", name: "never" } }] }, { files: filesOf("README.md") })
  assert.equal((await ask(stray)).status, "undelivered")
  const both = await ask(fakeGitHub({ files: filesOf("plugins/desk/changelog.d/x.md", "plugins/crew/a.md", "plugins/desk/b.md") }))
  assert.equal(both.status, "undelivered")
  assert.equal(both.unmet.length, 1, "one rule, however many of its files changed")
})

test("an unlabeled pull request that changes only merge-delivered paths is delivered by its merge", async () => {
  const answer = await ask(fakeGitHub({ files: filesOf("plugins/crew/skills/a.md", "tests/x.js") }))
  assert.deepEqual(answer, { status: "delivered", basis: "its changes deliver at merge" })
  assert.equal((await ask(fakeGitHub({ files: [{ status: 200, body: [] }] }))).status, "delivered")
})

test("a file that no rule matches is delivered at merge, and glob wildcards behave", async () => {
  const policy = { schema_version: 1, rules: [{ paths: ["docs/*.md", "a?c.txt", "x.y+z/**"], delivered_at: { kind: "github_label", name: "released" } }] }
  const delivered = async (...names) => (await ask(withPolicy(policy, { files: filesOf(...names) }))).status
  assert.equal(await delivered("other/file.js"), "delivered")
  assert.equal(await delivered("docs/a.md"), "undelivered")
  assert.equal(await delivered("docs/deep/a.md"), "delivered", "a single star stays inside one folder")
  assert.equal(await delivered("abc.txt"), "undelivered")
  assert.equal(await delivered("ab/c.txt"), "delivered", "a question mark is one character inside a folder")
  assert.equal(await delivered("x.y+z/a/b.js"), "undelivered", "dots and plus signs are literal and a double star crosses folders")
  assert.equal(await delivered("xay+z/a.js"), "delivered")
})

test("the files are read page by page, up to three pages", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ filename: `tests/${i}.js` }))
  const fake = fakeGitHub({ files: [{ status: 200, body: full }, { status: 200, body: full }, { status: 200, body: [{ filename: "plugins/desk/late.js" }] }] })
  assert.equal((await ask(fake)).status, "undelivered")
  assert.equal(fake.calls.filter((call) => call.url.includes("/files?")).length, 3)
  const endless = fakeGitHub({ files: [{ status: 200, body: full }] })
  assert.equal((await ask(endless)).status, "not_verified")
  assert.equal(endless.calls.filter((call) => call.url.includes("/files?")).length, 3)
})

test("a repo with no policy defaults to merge and says no delivery rule is declared; all-merge rules ask nothing more", async () => {
  const none = await run(fakeGitHub({ policy: { status: 404, body: "" } }))
  assert.equal(none.status, "delivered")
  assert.match(none.basis, /^no delivery rule declared in ourostack\/desk/u)
  const merge = withPolicy({ schema_version: 1, rules: [MERGE_RULE] })
  assert.deepEqual(await ask(merge), { status: "delivered", basis: "every rule delivers at merge" })
  assert.ok(!merge.calls.some((call) => call.url.includes("/files?")))
})

test("the process environment is the default", async () => {
  const fake = fakeGitHub()
  const answer = await prDelivery({ repo: "ourostack/desk", number: 200, fetchFn: fake.fetchFn })
  assert.equal(answer.status, "undelivered")
})

test("a 404 for the rules file is believed only when the repo itself is visible", async () => {
  const hidden = await ask(fakeGitHub({ policy: { status: 404, body: "" }, repo: { status: 404, body: "" } }))
  assert.equal(hidden.status, "not_verified")
  assert.match(hidden.reason, /not visible to GitHub requests from here \(HTTP 404\).*set GH_TOKEN/u)
  const down = await ask({ fetchFn: async (url) => { if (url.includes("/contents/")) return { status: 404, text: async () => "" }; throw new Error("down") } })
  assert.match(down.reason, /unreachable/u)
})

test("a file listing that stops at its page cap with a full last page is not_verified", async () => {
  const full = { status: 200, body: Array.from({ length: 100 }, (_, i) => ({ filename: `tests/${i}.js` })) }
  const answer = await ask(fakeGitHub({ files: [full] }))
  assert.equal(answer.status, "not_verified")
  assert.match(answer.reason, /more than 300 files/u)
})

test("evidence that is not a GitHub pull request is not checked", async () => {
  const never = fakeGitHub()
  assert.equal(await run(never, { kind: "commit", ref: "abc1234" }), null)
  assert.equal(await run(never, { kind: "pr", ref: "https://dev.azure.com/o/p/_git/r/pullrequest/1" }), null)
  assert.equal(never.calls.length, 0)
})

test("a pull request GitHub does not know is refused", async () => {
  await assert.rejects(run(fakeGitHub({ pr: { status: 404, body: "" } })), /does not exist on GitHub/u)
  assert.deepEqual(await ask(fakeGitHub({ pr: { status: 404, body: "" } })), { status: "not_found" })
})

test("every way GitHub cannot answer is not_verified, never refused", async () => {
  const reason = async (fake) => {
    const answer = await ask(fake)
    assert.equal(answer.status, "not_verified")
    return answer.reason
  }
  assert.match(await reason(fakeGitHub({ policy: { status: 403, body: "" } })), /delivery rules could not be read.*HTTP 403/u)
  assert.match(await reason(fakeGitHub({ policy: { status: 200, body: "not json" } })), /not a usable delivery policy/u)
  assert.match(await reason(fakeGitHub({ policy: { status: 200, body: { schema_version: 1 } } })), /not a usable/u)
  for (const rule of [null, { paths: [], delivered_at: { kind: "merge" } }, { paths: [1], delivered_at: { kind: "merge" } }, { paths: ["a"] }, { paths: ["a"], delivered_at: { kind: "carrier_pigeon" } }, { paths: ["a"], delivered_at: { kind: "github_label", name: "" } }, { paths: ["a"], delivered_at: { kind: "git_ref", pattern: "refs/tags/v*" } }]) {
    assert.match(await reason(withPolicy({ schema_version: 1, rules: [MERGE_RULE, rule] })), /not a usable/u, JSON.stringify(rule))
  }
  assert.match(await reason(fakeGitHub({ pr: { status: 502, body: "" } })), /ourostack\/desk#200 could not be read.*HTTP 502/u)
  assert.match(await reason(fakeGitHub({ pr: { status: 200, body: "{}" } })), /could not be read/u)
  assert.match(await reason(fakeGitHub({ pr: { status: 200, body: "null" } })), /could not be read/u)
  assert.match(await reason(fakeGitHub({ files: [{ status: 429, body: "" }] })), /files of ourostack\/desk#200 could not be read.*HTTP 429/u)
  assert.match(await reason(fakeGitHub({ files: [{ status: 200, body: "{}" }] })), /files of .* could not be read/u)
  const offline = { fetchFn: async () => { throw new Error("ENOTFOUND") }, calls: [] }
  assert.match(await reason(offline), /unreachable/u)
  const noPr = { fetchFn: async (url) => { if (url.includes("/contents/")) return { status: 200, text: async () => JSON.stringify(POLICY) }; throw new Error("down") } }
  assert.match(await reason(noPr), /pull request ourostack\/desk#200 could not be read.*unreachable/u)
  const noFiles = { fetchFn: async (url) => { if (url.includes("/files?")) throw new Error("down"); return { status: 200, text: async () => (url.includes("/contents/") ? JSON.stringify(POLICY) : JSON.stringify({ labels: [], merged_at: "x" })) } } }
  assert.match(await reason(noFiles), /files of .*unreachable/u)
})

test("a request that hangs is aborted at the budget and skipped", async () => {
  const hangs = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
  const result = await checkDelivery({ toolName: "task_update", evidence: PR, env: {}, fetchFn: hangs, budgetMs: 20 })
  assert.match(result.reason, /unreachable/u)
})

test("a token in the environment goes to api.github.com only; none means an anonymous request", async () => {
  const anon = fakeGitHub()
  await run(anon).catch(() => {})
  assert.equal(anon.calls[0].options.headers.Authorization, undefined)
  const withToken = fakeGitHub()
  await run(withToken, PR, { GH_TOKEN: " ", GITHUB_TOKEN: " tok " }).catch(() => {})
  assert.ok(withToken.calls.every((call) => call.url.startsWith("https://api.github.com/") && call.options.headers.Authorization === "Bearer tok"))
})

test("with no token in the environment, the token from gh is used for every request, asked once and kept in memory", async () => {
  const asked = []
  const ghRunner = async (args) => { asked.push(args); return "  from-gh\n" }
  const fake = fakeGitHub()
  await ask(fake, { ghRunner })
  assert.deepEqual(asked, [["auth", "token", "--hostname", "github.com"]])
  assert.ok(fake.calls.every((call) => call.options.headers.Authorization === "Bearer from-gh"))
  const later = fakeGitHub()
  await ask(later, { ghRunner })
  assert.equal(asked.length, 1, "remembered for the process")
  assert.equal(later.calls[0].options.headers.Authorization, "Bearer from-gh")
})

test("a token in the environment means gh is not asked", async () => {
  const ghRunner = async () => assert.fail("gh must not run")
  for (const env of [{ GH_TOKEN: "a" }, { GITHUB_TOKEN: "b" }]) {
    const fake = fakeGitHub()
    await ask(fake, { env, ghRunner })
    assert.equal(fake.calls[0].options.headers.Authorization, `Bearer ${Object.values(env)[0]}`)
  }
})

test("gh absent, signed out, failing or silent leaves the request anonymous", async () => {
  for (const ghRunner of [async () => { throw new Error("ENOENT") }, async () => "\n", async () => ""]) {
    const fake = fakeGitHub()
    await ask(fake, { ghRunner })
    assert.equal(fake.calls[0].options.headers.Authorization, undefined)
  }
})

test("a caller that injects its own fetch and no runner never runs gh", async () => {
  // Every other test here relies on this: a real gh would put the machine's token into a fake GitHub.
  const fake = fakeGitHub()
  await prDelivery({ repo: "ourostack/desk", number: 200, env: {}, fetchFn: fake.fetchFn })
  assert.equal(fake.calls[0].options.headers.Authorization, undefined)
})

test("checkDelivery passes the runner through", async () => {
  const fake = fakeGitHub()
  await checkDelivery({ toolName: "task_update", evidence: PR, env: {}, fetchFn: fake.fetchFn, ghRunner: async () => "viaCheck" }).catch(() => {})
  assert.equal(fake.calls[0].options.headers.Authorization, "Bearer viaCheck")
})

test("the rules are read from the branch the pull request merged into", async () => {
  const fake = fakeGitHub({ pr: { status: 200, body: { labels: [], merged_at: "x", base: { ref: "v2/alpha" } } } })
  await ask(fake)
  assert.equal(fake.calls[1].url, `https://api.github.com/repos/ourostack/desk/contents/${POLICY_PATH}?ref=v2%2Falpha`)
})

test("a pull request GitHub hides is not_verified, and one it shows as missing in a visible repo is not_found", async () => {
  const hidden = await ask(fakeGitHub({ pr: { status: 404, body: "" }, repo: { status: 404, body: "" } }))
  assert.equal(hidden.status, "not_verified")
  assert.match(hidden.reason, /not visible to GitHub requests from here.*set GH_TOKEN/u)
  assert.deepEqual(await ask(fakeGitHub({ pr: { status: 404, body: "" } })), { status: "not_found" })
})

test("a pull request GitHub cannot read (403, 429, 5xx, unreachable) is not_verified", async () => {
  for (const status of [403, 429, 500, 503, 0]) {
    const answer = await ask(fakeGitHub({ pr: { status, body: "" } }))
    assert.equal(answer.status, "not_verified", String(status))
    assert.match(answer.reason, /could not be read from GitHub/u)
  }
})

const MERGED = (ref) => ({ status: 200, body: { labels: [], merged_at: "x", base: { ref } } })

test("a base branch without a rules file falls back to the default branch's rules", async () => {
  const fake = fakeGitHub({ pr: MERGED("release/x"), repo: { status: 200, body: { default_branch: "main" } }, policyByRef: { "": { status: 200, body: JSON.stringify(POLICY) } } })
  assert.equal((await ask(fake)).status, "undelivered")
  const urls = fake.calls.map((call) => call.url)
  assert.ok(urls.some((url) => url.endsWith(`/contents/${POLICY_PATH}?ref=release%2Fx`)))
  assert.ok(urls.some((url) => url.endsWith(`/contents/${POLICY_PATH}`)))
})

test("a base branch with its own rules file does not read the default branch's", async () => {
  const merge = { status: 200, body: JSON.stringify({ schema_version: 1, rules: [MERGE_RULE] }) }
  const fake = fakeGitHub({ pr: MERGED("v2-alpha"), policyByRef: { "v2-alpha": merge, "": { status: 200, body: JSON.stringify(POLICY) } } })
  assert.deepEqual(await ask(fake), { status: "delivered", basis: "every rule delivers at merge" })
  assert.ok(!fake.calls.some((call) => call.url.endsWith(`/contents/${POLICY_PATH}`)))
})

test("with no rules on the base branch or the default branch, merge counts as delivery; on the default branch there is no second read", async () => {
  const none = fakeGitHub({ pr: MERGED("release/x"), repo: { status: 200, body: { default_branch: "main" } }, policyByRef: {} })
  assert.match((await ask(none)).basis, /^no delivery rule declared/u)
  assert.equal(none.calls.filter((call) => call.url.includes("/contents/")).length, 2)
  const onDefault = fakeGitHub({ pr: MERGED("main"), repo: { status: 200, body: { default_branch: "main" } }, policyByRef: {} })
  assert.match((await ask(onDefault)).basis, /^no delivery rule declared/u)
  assert.equal(onDefault.calls.filter((call) => call.url.includes("/contents/")).length, 1)
})

test("an unmerged pull request is undelivered before any rules are read, even when the rules are unreadable", async () => {
  const fake = fakeGitHub({ pr: { status: 200, body: { labels: [], merged_at: null, base: { ref: "main" } } }, policy: { status: 500, body: "" } })
  assert.deepEqual(await ask(fake), { status: "undelivered", unmet: [{ need: "be merged" }], merged: false })
  assert.ok(!fake.calls.some((call) => call.url.includes("/contents/")))
})

test("the real gh runner passes its arguments and time limit to execFile, and maps its result and error", async () => {
  const seen = []
  const ok = makeRunGh((file, args, options, done) => { seen.push({ file, args, options }); done(null, Buffer.from("tok\n")) })
  assert.equal(await ok(["auth", "token"]), "tok\n")
  assert.deepEqual(seen[0].file, "gh")
  assert.deepEqual(seen[0].args, ["auth", "token"])
  assert.equal(seen[0].options.timeout, 3000)
  const bad = makeRunGh((file, args, options, done) => done(new Error("ENOENT")))
  await assert.rejects(bad([]), /ENOENT/u)
})

test("concurrent gh lookups share one call", async () => {
  let asks = 0
  const slow = async () => { asks += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return "tok" }
  await Promise.all([ask(fakeGitHub(), { ghRunner: slow }), ask(fakeGitHub(), { ghRunner: slow })])
  assert.equal(asks, 1)
})

test("a failed gh lookup is remembered for 60 seconds, then asked again; a token is kept for the process", async () => {
  let clock = 1000
  const now = () => clock
  let asks = 0
  let answer = null
  const flaky = async () => { asks += 1; if (answer === null) throw new Error("timeout"); return answer }
  await ask(fakeGitHub(), { ghRunner: flaky, now })
  clock += 59000
  await ask(fakeGitHub(), { ghRunner: flaky, now })
  assert.equal(asks, 1, "within 60 seconds the failure is reused")
  clock += 2000
  answer = "late"
  const late = fakeGitHub()
  await ask(late, { ghRunner: flaky, now })
  assert.equal(asks, 2, "after 60 seconds it asks again")
  assert.equal(late.calls[0].options.headers.Authorization, "Bearer late")
  clock += 10 * 60000
  await ask(fakeGitHub(), { ghRunner: flaky, now })
  assert.equal(asks, 2, "a token does not expire")
})

// A GitHub that refuses one token with 401 and answers everything else as the plain fake does.
function refusing(bad) {
  const fake = fakeGitHub()
  const fetchFn = async (url, options) => {
    if (options.headers.Authorization === `Bearer ${bad}`) { fake.calls.push({ url, options }); return { status: 401, text: async () => "" } }
    return fake.fetchFn(url, options)
  }
  return { fetchFn, calls: fake.calls }
}

test("a 401 on a gh token drops it and repeats the request anonymously, for the rest of the call and the next minute", async () => {
  let clock = 0
  const now = () => clock
  let asks = 0
  const ghRunner = async () => { asks += 1; return "revoked" }
  const fake = refusing("revoked")
  const answer = await ask(fake, { ghRunner, now })
  assert.equal(answer.status, "undelivered", "the public answer, not not_verified")
  assert.equal(fake.calls[0].options.headers.Authorization, "Bearer revoked")
  assert.equal(fake.calls[1].options.headers.Authorization, undefined)
  assert.ok(fake.calls.slice(1).every((call) => call.options.headers.Authorization === undefined))
  clock += 1000
  await ask(fakeGitHub(), { ghRunner, now })
  assert.equal(asks, 1, "the refused token is not asked for again at once")
})

test("a 401 on a token from the environment is left alone", async () => {
  const fake = refusing("mine")
  const answer = await ask(fake, { env: { GH_TOKEN: "mine" }, ghRunner: async () => assert.fail("gh must not run") })
  assert.equal(answer.status, "not_verified")
  assert.equal(fake.calls.length, 1)
})

test("a node:test run with no fetch of its own makes no request", async () => {
  assert.equal(await checkDelivery({ toolName: "task_update", evidence: PR, env: { NODE_TEST_CONTEXT: "child" } }), null)
})

test("with no env given the process environment is used", async () => {
  assert.equal(await checkDelivery({ toolName: "task_update", evidence: PR }), null)
})

// ── this repo's own policy ──────────────────────────────────────────────────

test("this repo's delivery policy gates Desk's own path and nothing that ships at merge", async () => {
  const policy = JSON.parse(readFileSync(new URL("../../../../../.desk/delivery.json", import.meta.url), "utf8"))
  const gate = async (...names) => (await ask(withPolicy(policy, { files: filesOf(...names) }))).status
  assert.equal(await gate("plugins/desk/mcp/src/a.js"), "undelivered")
  assert.equal(await gate("plugins/desk/changelog.d/x.md", "plugins/crew/a.md"), "undelivered")
  // Crew, Superpowers and Plain Language bump their own version in the pull request (check-release-integrity.cjs), and Claude Code reads the marketplace from main: a merge delivers them.
  for (const names of [["plugins/crew/skills/a.md"], ["plugins/superpowers/a.md"], ["plugins/plain-language/a.md"], ["tests/desk/a.js", ".github/workflows/x.yml", "README.md"]]) {
    assert.equal(await gate(...names), "delivered", names.join())
  }
})

// ── through the tools ───────────────────────────────────────────────────────

async function deskWithTask(slug) {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug, title: "T" } })
  return root
}

test("task_update refuses done on an undelivered PR and leaves the card alone; the labeled PR closes it and says why", async () => {
  const root = await deskWithTask("gated")
  const file = path.join(root, "t", "gated", "task.md")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "gated", frontmatter: { status: "done" }, evidence: PR }, fetchFn: fakeGitHub().fetchFn }), /task_update: ourostack\/desk#200 is not delivered yet/u)
  assert.notEqual((await readFront(file)).data.status, "done")
  const released = fakeGitHub({ pr: { status: 200, body: { labels: [{ name: "released" }], merged_at: "x" } } })
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "gated", frontmatter: { status: "done" }, evidence: PR }, fetchFn: released.fetchFn })
  assert.equal((await readFront(file)).data.status, "done")
  assert.equal(result.delivery_check, "delivered: carries the `released` label")
})

test("task_update closes a task offline and says the delivery was not verified", async () => {
  const root = await deskWithTask("offline")
  const offline = { fetchFn: async () => { throw new Error("down") } }
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "offline", frontmatter: { status: "done" }, evidence: PR }, fetchFn: offline.fetchFn })
  assert.equal((await readFront(path.join(root, "t", "offline", "task.md"))).data.status, "done")
  assert.match(result.delivery_check, /^not verified: .*unreachable.*confirm it is delivered/u)
})

test("task_update on a repo with no rules says so", async () => {
  const root = await deskWithTask("norules")
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "norules", frontmatter: { status: "done" }, evidence: PR }, fetchFn: fakeGitHub({ policy: { status: 404, body: "" } }).fetchFn })
  assert.match(result.delivery_check, /^delivered: no delivery rule declared in ourostack\/desk/u)
})

test("task_archive refuses to bump an undelivered PR's task to done", async () => {
  const root = await deskWithTask("archived")
  await assert.rejects(task_archive({ deskRoot: root, input: { track: "t", slug: "archived", evidence: PR }, fetchFn: fakeGitHub().fetchFn }), /is not delivered yet/u)
})
