// The delivery gate: a pull request is delivered when its repo's own delivery rules say so (merge, a label, a ref).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { readFileSync } from "node:fs"
import { checkDelivery, prDelivery, POLICY_PATH } from "../../../../../plugins/desk/mcp/src/tools/delivery-gate.js"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const PR = { kind: "pr", ref: "https://github.com/ourostack/desk/pull/200" }
const LABEL_RULE = { paths: ["plugins/desk/**"], delivered_at: { kind: "github_label", name: "released" } }
const MERGE_RULE = { paths: ["**"], delivered_at: { kind: "merge" } }
const POLICY = { schema_version: 1, rules: [LABEL_RULE, MERGE_RULE] }
const TAG_RULE = { paths: ["src/**"], delivered_at: { kind: "git_ref", pattern: "refs/tags/v*" } }

// A fake GitHub: routes by path, records every request.
function fakeGitHub({
  policy = { status: 200, body: JSON.stringify(POLICY) },
  pr = { status: 200, body: { labels: [], merged_at: "2026-10-06T00:00:00Z", merge_commit_sha: "abc123" } },
  files = [{ status: 200, body: [{ filename: "plugins/desk/mcp/src/x.js" }] }],
  refs = { status: 200, body: [] },
  compare = () => ({ status: 200, body: { status: "behind" } }),
} = {}) {
  const calls = []
  const answer = ({ status, body }) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) })
  const fetchFn = async (url, options) => {
    calls.push({ url, options })
    if (url.includes("/contents/")) return answer(policy)
    if (url.includes("/files?")) return answer(files[Math.min(Number(/&page=(\d+)/u.exec(url)[1]) - 1, files.length - 1)])
    if (url.includes("/matching-refs/")) return answer(refs)
    if (url.includes("/compare/")) return answer(compare(url))
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
  assert.equal(fake.calls[0].url, `https://api.github.com/repos/ourostack/desk/contents/${POLICY_PATH}`)
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

test("an unmerged pull request says so", async () => {
  await assert.rejects(run(fakeGitHub({ pr: { status: 200, body: { labels: [], merged_at: null } } })), /\(the pull request is not merged\)/u)
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
  assert.equal((await ask(endless)).status, "delivered")
  assert.equal(endless.calls.filter((call) => call.url.includes("/files?")).length, 3)
})

test("a repo with no policy defaults to merge and says no delivery rule is declared; all-merge rules ask nothing more", async () => {
  const none = await run(fakeGitHub({ policy: { status: 404, body: "" } }))
  assert.equal(none.status, "delivered")
  assert.match(none.basis, /^no delivery rule declared in ourostack\/desk/u)
  const merge = withPolicy({ schema_version: 1, rules: [MERGE_RULE] })
  assert.deepEqual(await ask(merge), { status: "delivered", basis: "every rule delivers at merge" })
  assert.equal(merge.calls.length, 1)
})

test("the process environment is the default", async () => {
  const fake = fakeGitHub()
  const answer = await prDelivery({ repo: "ourostack/desk", number: 200, fetchFn: fake.fetchFn })
  assert.equal(answer.status, "undelivered")
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
  for (const rule of [null, { paths: [], delivered_at: { kind: "merge" } }, { paths: [1], delivered_at: { kind: "merge" } }, { paths: ["a"] }, { paths: ["a"], delivered_at: { kind: "carrier_pigeon" } }, { paths: ["a"], delivered_at: { kind: "github_label", name: "" } }, { paths: ["a"], delivered_at: { kind: "git_ref", pattern: "tags/v*" } }, { paths: ["a"], delivered_at: { kind: "git_ref" } }]) {
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
  const noFiles = { fetchFn: async (url) => { if (url.includes("/files?")) throw new Error("down"); return { status: 200, text: async () => (url.includes("/contents/") ? JSON.stringify(POLICY) : JSON.stringify({ labels: [] })) } } }
  assert.match(await reason(noFiles), /files of .*unreachable/u)
})

test("a git_ref rule is delivered when the merge commit is an ancestor of a matching ref, newest-listed first", async () => {
  const policy = { schema_version: 1, rules: [TAG_RULE, MERGE_RULE] }
  const refs = { status: 200, body: [{ ref: "refs/tags/v1", object: { sha: "s1" } }, { ref: "refs/tags/v2", object: { sha: "s2" } }, { ref: "refs/tags/vnext/x", object: { sha: "s3" } }, { ref: "refs/tags/other", object: { sha: "s4" } }] }
  const reached = withPolicy(policy, { files: filesOf("src/a.js"), refs, compare: (url) => ({ status: 200, body: { status: url.includes("...s1") ? "ahead" : "behind" } }) })
  assert.deepEqual(await ask(reached), { status: "delivered", basis: "its merge commit is in refs/tags/v1" })
  assert.ok(reached.calls.some((call) => call.url.includes("/matching-refs/tags/v?per_page=100")))
  assert.ok(reached.calls.some((call) => call.url.includes("/compare/abc123...s1?per_page=1")))
  const identical = withPolicy(policy, { files: filesOf("src/a.js"), refs, compare: () => ({ status: 200, body: { status: "identical" } }) })
  assert.equal((await ask(identical)).status, "delivered")
  const not = withPolicy(policy, { files: filesOf("src/a.js"), refs })
  const answer = await ask(not)
  assert.equal(answer.status, "undelivered")
  assert.match(answer.unmet[0].need, /^reach a ref matching `refs\/tags\/v\*`$/u)
  assert.equal(not.calls.filter((call) => call.url.includes("/compare/")).length, 2, "a tag in another folder and a tag the pattern does not match are never compared")
  // A change outside the rule needs no ref at all.
  assert.equal((await ask(withPolicy(policy, { files: filesOf("README.md"), refs }))).status, "delivered")
  // An unmerged pull request has no merge commit to find.
  const unmerged = await ask(withPolicy(policy, { files: filesOf("src/a.js"), pr: { status: 200, body: { labels: [], merged_at: null } } }))
  assert.equal(unmerged.status, "undelivered")
  assert.match(unmerged.unmet[0].need, /^be merged and reach /u)
  // A pattern with no wildcard names one ref.
  const exact = withPolicy({ schema_version: 1, rules: [{ paths: ["src/**"], delivered_at: { kind: "git_ref", pattern: "refs/heads/release" } }] }, { files: filesOf("src/a.js"), refs: { status: 200, body: [{ ref: "refs/heads/release", object: { sha: "r" } }] }, compare: () => ({ status: 200, body: { status: "ahead" } }) })
  assert.equal((await ask(exact)).status, "delivered")
})

test("a git_ref rule that GitHub cannot answer is not_verified", async () => {
  const policy = { schema_version: 1, rules: [TAG_RULE] }
  const refs = { status: 200, body: [{ ref: "refs/tags/v1", object: { sha: "s1" } }] }
  const rest = { files: filesOf("src/a.js") }
  assert.match((await ask(withPolicy(policy, { ...rest, refs: { status: 500, body: "" } }))).reason, /refs matching refs\/tags\/v\* could not be read.*HTTP 500/u)
  assert.match((await ask(withPolicy(policy, { ...rest, refs: { status: 200, body: "{}" } }))).reason, /could not be read/u)
  assert.match((await ask(withPolicy(policy, { ...rest, refs, compare: () => ({ status: 404, body: "" }) }))).reason, /refs\/tags\/v1 could not be compared.*HTTP 404/u)
  assert.match((await ask(withPolicy(policy, { ...rest, refs: { status: 200, body: [null, { ref: "refs/tags/v2" }] }, compare: () => ({ status: 200, body: "null" }) }))).reason, /could not be compared/u)
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
  const released = fakeGitHub({ pr: { status: 200, body: { labels: [{ name: "released" }] } } })
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
