import { test } from "node:test"
import assert from "node:assert/strict"

import { PLUGIN_REPOS, githubReader, parsePrUrl, shippedVersion } from "../../../../../plugins/desk/mcp/src/factory/release-version.js"
import { FILE, MERGE_SHA, REPO, TOKEN, fakeReleaseGitHub, httpError, pluginJson, sha } from "./_fake_release_github.js"

const PR = `https://github.com/${REPO}/pull/42`
const lookup = (fake, overrides = {}) =>
  shippedVersion({ plugin: "desk", countermeasure: PR, client: githubReader({ runner: fake.runner, token: TOKEN }), ...overrides })

test("the plugin map names Desk's repository and version file", () => {
  assert.deepEqual(PLUGIN_REPOS, { desk: { repo: "ourostack/desk", file: "plugins/desk/plugin.json" } })
})

test("parsePrUrl reads owner/repo and number, and nothing else", () => {
  assert.deepEqual(parsePrUrl("https://github.com/ourostack/desk/pull/42"), { repo: "ourostack/desk", number: 42 })
  for (const bad of ["https://github.com/ourostack/desk/issues/42", "http://github.com/o/r/pull/1", "https://github.com/o/r/pull/0", "https://github.com/o/r/pull/1/files", "https://example.com/o/r/pull/1", "", null, 7]) {
    assert.equal(parsePrUrl(bad), null, String(bad))
  }
})

test("a merged PR followed by two release commits returns the first one that carries it", async () => {
  const fake = fakeReleaseGitHub({
    releases: [
      { sha: sha(2), relation: "ahead", content: pluginJson("1.5.0") },
      { sha: sha(1), relation: "ahead", content: pluginJson("1.4.1") },
    ],
  })
  assert.deepEqual(await lookup(fake), { state: "version", version: "1.4.1" })
  assert.deepEqual(fake.routes(), [
    `repos/${REPO}/pulls/42`,
    `repos/${REPO}/commits?path=${encodeURIComponent(FILE)}&since=2026-10-01T00%3A00%3A00Z&per_page=20`,
    `repos/${REPO}/compare/${MERGE_SHA}...${sha(1)}`,
    `repos/${REPO}/contents/${FILE}?ref=${sha(1)}`,
  ])
  assert.ok(fake.calls.every((call) => call.token === TOKEN))
})

test("a release commit identical to the merge commit counts", async () => {
  const fake = fakeReleaseGitHub({ releases: [{ sha: sha(1), relation: "identical", content: pluginJson("2.0.0") }] })
  assert.deepEqual(await lookup(fake), { state: "version", version: "2.0.0" })
})

test("a candidate that is behind or diverged is skipped", async () => {
  const fake = fakeReleaseGitHub({
    releases: [
      { sha: sha(3), relation: "ahead", content: pluginJson("3.0.0") },
      { sha: sha(2), relation: "diverged", content: pluginJson("2.0.0") },
      { sha: sha(1), relation: "behind", content: pluginJson("1.0.0") },
    ],
  })
  assert.deepEqual(await lookup(fake), { state: "version", version: "3.0.0" })
  assert.ok(!fake.routes().some((route) => route.includes("contents") && route.includes(sha(1))))
})

test("an unmerged PR is not_merged and makes no further call", async () => {
  const fake = fakeReleaseGitHub({ merged: false })
  assert.deepEqual(await lookup(fake), { state: "not_merged" })
  assert.equal(fake.calls.length, 1)
})

test("a merged PR with no later release commit is not_released_yet", async () => {
  assert.deepEqual(await lookup(fakeReleaseGitHub({ releases: [] })), { state: "not_released_yet" })
  const behind = fakeReleaseGitHub({ releases: [{ sha: sha(1), relation: "behind", content: pluginJson("1.0.0") }] })
  assert.deepEqual(await lookup(behind), { state: "not_released_yet" })
})

test("an unmapped plugin, a PR in another repository or a bad URL is unavailable", async () => {
  const fake = fakeReleaseGitHub()
  assert.deepEqual(await lookup(fake, { plugin: "other" }), { state: "unavailable", reason: "plugin_unmapped" })
  assert.deepEqual(await lookup(fake, { plugin: "constructor" }), { state: "unavailable", reason: "plugin_unmapped" })
  assert.deepEqual(await lookup(fake, { countermeasure: "https://github.com/ourostack/factory/pull/9" }), { state: "unavailable", reason: "plugin_unmapped" })
  assert.deepEqual(await lookup(fake, { countermeasure: "not a url" }), { state: "unavailable", reason: "countermeasure_unparsed" })
  assert.deepEqual(await lookup(fake, { countermeasure: null }), { state: "unavailable", reason: "countermeasure_unparsed" })
  assert.equal(fake.calls.length, 0)
})

test("a malformed or versionless plugin.json is version_unreadable", async () => {
  for (const content of ["{not json", JSON.stringify({ name: "desk" }), JSON.stringify({ version: 3 }), JSON.stringify({ version: "" }), "null", JSON.stringify([])]) {
    const fake = fakeReleaseGitHub({ releases: [{ sha: sha(1), relation: "ahead", content }] })
    assert.deepEqual(await lookup(fake), { state: "unavailable", reason: "version_unreadable" }, content)
  }
})

test("every failure is unavailable with a stable code, never not_released_yet", async () => {
  const cases = [
    [{ intercept: (route) => (/pulls/u.test(route) ? httpError(404) : undefined) }, "http_404"],
    [{ intercept: (route) => (/pulls/u.test(route) ? httpError(403) : undefined) }, "http_403"],
    [{ intercept: (route) => (/pulls/u.test(route) ? { code: 1, stdout: "", stderr: "boom" } : undefined) }, "gh_failed"],
    [{ intercept: (route) => (/pulls/u.test(route) ? { code: 127, stdout: "", stderr: "", spawnError: "ENOENT" } : undefined) }, "gh_missing"],
    [{ intercept: (route) => (/pulls/u.test(route) ? { code: 1, stdout: "", stderr: "", timedOut: true } : undefined) }, "timeout"],
    [{ intercept: (route) => (/pulls/u.test(route) ? { code: 0, stdout: "not json", stderr: "" } : undefined) }, "unexpected_answer"],
    [{ intercept: (route) => (/pulls/u.test(route) ? { code: 0, stdout: "", stderr: "" } : undefined) }, "unexpected_answer"],
    [{ pull: { code: 0, stdout: JSON.stringify({ merged_at: "2026-10-01T00:00:00Z" }), stderr: "" } }, "unexpected_answer"],
    [{ pull: { code: 0, stdout: JSON.stringify([]), stderr: "" } }, "unexpected_answer"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/commits\?/u.test(route) ? httpError(500) : undefined) }, "http_500"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/commits\?/u.test(route) ? { code: 0, stdout: JSON.stringify({}), stderr: "" } : undefined) }, "unexpected_answer"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/commits\?/u.test(route) ? { code: 0, stdout: JSON.stringify([{ nope: 1 }]), stderr: "" } : undefined) }, "unexpected_answer"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/compare/u.test(route) ? httpError(502) : undefined) }, "http_502"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/compare/u.test(route) ? { code: 0, stdout: JSON.stringify({ status: 5 }), stderr: "" } : undefined) }, "unexpected_answer"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: null }] }, "http_404"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/contents/u.test(route) ? { code: 0, stdout: JSON.stringify({ encoding: "none", content: "x" }), stderr: "" } : undefined) }, "unexpected_answer"],
    [{ releases: [{ sha: sha(1), relation: "ahead", content: pluginJson("1.0.0") }], intercept: (route) => (/contents/u.test(route) ? { code: 0, stdout: JSON.stringify({ encoding: "base64", content: 3 }), stderr: "" } : undefined) }, "unexpected_answer"],
  ]
  for (const [options, reason] of cases) {
    assert.deepEqual(await lookup(fakeReleaseGitHub(options)), { state: "unavailable", reason }, reason)
  }
})

test("a reader that throws something without a code is still unavailable", async () => {
  const client = { get: async () => { throw new Error("odd") } }
  assert.deepEqual(await shippedVersion({ plugin: "desk", countermeasure: PR, client }), { state: "unavailable", reason: "lookup_failed" })
})

const behindReleases = (count) => Array.from({ length: count }, (_, index) => ({ sha: sha(index + 1), relation: "behind", content: pluginJson("1.0.0") }))

test("a full page of release commits may be truncated, so it is unavailable and never a version", async () => {
  // 25 release commits, newest first; only the 5 oldest carry the merge. The true first is sha(1).
  const releases = Array.from({ length: 25 }, (_, index) => ({ sha: sha(25 - index), relation: 25 - index <= 5 ? "ahead" : "behind", content: pluginJson(`1.0.${25 - index}`) }))
  const fake = fakeReleaseGitHub({ releases })
  assert.deepEqual(await lookup(fake), { state: "unavailable", reason: "too_many_releases" })
  assert.equal(fake.calls.length, 2)
  const exactly = fakeReleaseGitHub({ releases: behindReleases(20) })
  assert.deepEqual(await lookup(exactly), { state: "unavailable", reason: "too_many_releases" })
})

test("19 release commits is a complete list, and the call count stays under 25", async () => {
  const fake = fakeReleaseGitHub({ releases: behindReleases(19) })
  assert.deepEqual(await lookup(fake), { state: "not_released_yet" })
  assert.equal(fake.calls.length, 21)
  const last = fakeReleaseGitHub({ releases: [...behindReleases(18).map((release) => ({ ...release, sha: sha(Number.parseInt(release.sha, 16) + 1) })), { sha: sha(1), relation: "ahead", content: pluginJson("9.9.9") }] })
  assert.deepEqual(await lookup(last), { state: "version", version: "9.9.9" })
  assert.ok(last.calls.length <= 25)
})

test("the call budget is per lookup, so one reader serves many cards", async () => {
  const fake = fakeReleaseGitHub({ releases: behindReleases(19) })
  const client = githubReader({ runner: fake.runner, token: TOKEN })
  for (let card = 0; card < 3; card += 1) {
    assert.deepEqual(await shippedVersion({ plugin: "desk", countermeasure: PR, client }), { state: "not_released_yet" })
  }
  assert.equal(fake.calls.length, 63)
})

test("the call budget stops a lookup as unavailable", async () => {
  const fake = fakeReleaseGitHub({ releases: behindReleases(5) })
  assert.deepEqual(await lookup(fake, { maxCalls: 4 }), { state: "unavailable", reason: "call_budget" })
  assert.equal(fake.calls.length, 4)
})

test("githubReader refuses a bad runner or token", () => {
  assert.throws(() => githubReader({ runner: null, token: TOKEN }), TypeError)
  assert.throws(() => githubReader({ runner: async () => ({}), token: "" }), TypeError)
})
