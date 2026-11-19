// The owned-tool filer never makes a real network call in tests: the runner is an in-memory gh model.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { MAX_PER_DAY, OWNED_TOOLS, fileToolIssue, toolIssueFingerprint } from "../../../../../plugins/desk/mcp/src/factory/tool-issue-file.js"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { readStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { osEnv } from "../_os_env.js"
import { mkTempRoot } from "../_temp_roots.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"

async function scratch(run) {
  const base = await mkTempRoot("tool-issue-file-")
  return run({ env: osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") }) })
}

function fakeGh({ repo, issues = [] }) {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args, input: options.input })
    if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: true\n  - Git operations protocol: https\n", stderr: "" }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: "token-ari\n", stderr: "" }
    if (args[0] === "api") {
      const route = args[7]
      if (route === `repos/${repo}`) return { code: 0, stdout: JSON.stringify({ full_name: repo, private: false, allow_forking: true, default_branch: "main", permissions: { push: true, pull: true } }), stderr: "" }
      if (route.startsWith(`repos/${repo}/issues?`)) return { code: 0, stdout: JSON.stringify(issues), stderr: "" }
      if (args[2] === "POST" && route === `repos/${repo}/issues`) return { code: 0, stdout: JSON.stringify({ number: 404, html_url: `https://github.com/${repo}/issues/404` }), stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected call\n" }
  }
  return { runner, calls }
}

const TITLE = "content fetch image refuses Teams channel posts"
const BODY = "`content fetch image` admits chats only; a channel post is refused with unsupported_target."
const created = (calls) => calls.filter((call) => call.args[2] === "POST")

test("every tool Ari's agents own routes to its ourostack repo", () => {
  assert.deepEqual(Object.keys(OWNED_TOOLS).sort(), ["desk", "hackamore", "housesitter", "m365crawl", "ouroboros", "shepherd"])
  for (const [tool, repo] of Object.entries(OWNED_TOOLS)) assert.equal(repo, `ourostack/${tool}`)
})

test("a failure of m365crawl becomes a real issue on ourostack/m365crawl, with the fingerprint marker and the evidence", () => scratch(async ({ env }) => {
  const { runner, calls } = fakeGh({ repo: "ourostack/m365crawl" })
  const result = await fileToolIssue(env, { tool: "m365crawl", title: TITLE, body: BODY, runner })
  assert.deepEqual(result, { result: "filed", repo: "ourostack/m365crawl", url: "https://github.com/ourostack/m365crawl/issues/404" })
  const [post] = created(calls)
  assert.equal(post.args[7], "repos/ourostack/m365crawl/issues")
  const sent = JSON.parse(post.input)
  assert.equal(sent.title, TITLE)
  assert.deepEqual(sent.labels, ["bug", "tool-friction"])
  assert.ok(sent.body.startsWith(BODY))
  assert.ok(sent.body.includes(`<!-- desk-tool-issue: ${toolIssueFingerprint("m365crawl", TITLE)} -->`))
  assert.equal((await readStatus(env)).tool_issue_filed["ourostack/m365crawl"].length, 1)
}))

test("the same failure again is known, open or closed, and files nothing new", () => scratch(async ({ env }) => {
  const marker = `<!-- desk-tool-issue: ${toolIssueFingerprint("shepherd", TITLE)} -->`
  const issues = [{ number: 7, html_url: "https://github.com/ourostack/shepherd/issues/7", title: "t", body: `x\n${marker}`, labels: [], state: "closed", pull_request: null }]
  const { runner, calls } = fakeGh({ repo: "ourostack/shepherd", issues })
  assert.deepEqual(await fileToolIssue(env, { tool: "shepherd", title: TITLE, body: BODY, runner }), { result: "known", repo: "ourostack/shepherd", url: "https://github.com/ourostack/shepherd/issues/7" })
  assert.equal(created(calls).length, 0)
}))

test("text with a home path is not filed and comes back paste-ready; an unowned tool and a past-cap day are refused", () => scratch(async ({ env }) => {
  const { runner, calls } = fakeGh({ repo: "ourostack/hackamore" })
  const leaky = await fileToolIssue(env, { tool: "hackamore", title: TITLE, body: "crashed at /home/ari/x", runner })
  assert.deepEqual([leaky.result, leaky.reason], ["not_filed", "not_generic"])
  assert.ok(leaky.body.includes("crashed at /home/ari/x"))
  assert.deepEqual(await fileToolIssue(env, { tool: "someone-elses", title: TITLE, body: BODY, runner }), { result: "not_filed", reason: "unknown_tool" })
  for (let n = 0; n < MAX_PER_DAY; n += 1) assert.equal((await fileToolIssue(env, { tool: "hackamore", title: `${TITLE} ${"abcdefghij"[n]}`, body: BODY, runner })).result, "filed")
  assert.equal((await fileToolIssue(env, { tool: "hackamore", title: `${TITLE} z`, body: BODY, runner })).result, "held_cap")
  assert.equal(created(calls).length, MAX_PER_DAY)
}))

test("friction_add with an owned tool as plugin files the issue, opens no Desk card, and keeps the issue link on the desk", async () => {
  const root = await mkTempDeskRoot()
  const seen = []
  const fileIssue = async (env, options) => { seen.push(options); return { result: "filed", repo: "ourostack/m365crawl", url: "https://github.com/ourostack/m365crawl/issues/404" } }
  const result = await friction_add({ deskRoot: root, input: { about: "system", plugin: "m365crawl", title: TITLE, body: BODY }, fileIssue })
  assert.deepEqual(seen, [{ tool: "m365crawl", title: TITLE, body: BODY }])
  assert.deepEqual(result, { status: "filed", path: "_meta/friction.md", url: "https://github.com/ourostack/m365crawl/issues/404", issue: "filed", repo: "ourostack/m365crawl" })
  assert.match(await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"), /Issue for ".*" on ourostack\/m365crawl: filed at https:\/\/github\.com\/ourostack\/m365crawl\/issues\/404/u)
})

test("friction_add keeps the paste-ready text on the desk when the issue could not be filed", async () => {
  const root = await mkTempDeskRoot()
  const fileIssue = async () => ({ result: "not_filed", reason: "no_suitable_account", repo: "ourostack/m365crawl", body: `${TITLE}\n\n${BODY}` })
  const result = await friction_add({ deskRoot: root, input: { about: "system", plugin: "m365crawl", title: TITLE, body: BODY }, fileIssue })
  assert.deepEqual(result, { status: "added", path: "_meta/friction.md", issue: "no_suitable_account", repo: "ourostack/m365crawl" })
  assert.match(await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"), /not filed \(no_suitable_account\)[\s\S]*admits chats only/u)
})

test("invalid titles and bodies are refused before any account is asked", () => scratch(async ({ env }) => {
  const never = async () => { throw new Error("no gh call expected") }
  const refused = (title, body) => fileToolIssue(env, { tool: "shepherd", title, body, runner: never, now: () => 0 })
  for (const title of [undefined, "  ", "two\nlines", "x".repeat(121)]) assert.deepEqual(await refused(title, BODY), { result: "not_filed", reason: "invalid_title", repo: "ourostack/shepherd" })
  for (const body of [undefined, "  ", "x".repeat(8001)]) assert.deepEqual(await refused(TITLE, body), { result: "not_filed", reason: "invalid_body", repo: "ourostack/shepherd" })
  assert.deepEqual(await fileToolIssue(env, { tool: "someone-elses", title: TITLE, body: BODY }), { result: "not_filed", reason: "unknown_tool" })
}))

test("no signed-in account, or an account with no token, is not filed and comes back paste-ready", () => scratch(async ({ env }) => {
  const signedOut = async (args) => (args[0] === "--version" ? { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" } : { code: 1, stdout: "", stderr: "not logged in\n" })
  const none = await fileToolIssue(env, { tool: "shepherd", title: TITLE, body: BODY, runner: signedOut })
  assert.deepEqual([none.result, none.reason], ["not_filed", "no_suitable_account"])
  const { runner } = fakeGh({ repo: "ourostack/shepherd" })
  const tokenless = (answer) => {
    let asked = 0
    return async (args, options) => (args[0] === "auth" && args[1] === "token" && (asked += 1) > 1 ? answer : runner(args, options))
  }
  for (const answer of [{ code: 1, stdout: "", stderr: "" }, { code: 0, stdout: undefined, stderr: "" }]) {
    const empty = await fileToolIssue(env, { tool: "shepherd", title: TITLE, body: BODY, runner: tokenless(answer) })
    assert.deepEqual([empty.result, empty.reason], ["not_filed", "no_suitable_account"])
    assert.ok(empty.body.includes(BODY))
  }
}))

test("a pull request carrying the marker is not the issue; stale or malformed filing records do not count toward the cap", () => scratch(async ({ env }) => {
  const marker = `<!-- desk-tool-issue: ${toolIssueFingerprint("shepherd", TITLE)} -->`
  const issues = [{ number: 8, html_url: "https://github.com/ourostack/shepherd/issues/8", title: "t", body: marker, labels: [], state: "open", pull_request: {} }]
  const { runner, calls } = fakeGh({ repo: "ourostack/shepherd", issues })
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const { writeStatus } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  await writeStatus(env, { tool_issue_filed: { "ourostack/shepherd": [old, 7, old] } })
  assert.equal((await fileToolIssue(env, { tool: "shepherd", title: TITLE, body: BODY, runner })).result, "filed")
  assert.equal(created(calls).length, 1)
  await writeStatus(env, { tool_issue_filed: { "ourostack/shepherd": "not a list" } })
  assert.equal((await fileToolIssue(env, { tool: "shepherd", title: `${TITLE} again`, body: BODY, runner })).result, "filed")
}))

test("a refused create comes back as its code with paste-ready text; an unexpected error still throws", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ repo: "ourostack/shepherd" })
  const refusing = async (args, options) => (args[2] === "POST" ? { code: 1, stdout: "", stderr: "HTTP 403: forbidden\n" } : runner(args, options))
  const refused = await fileToolIssue(env, { tool: "shepherd", title: TITLE, body: BODY, runner: refusing })
  assert.equal(refused.result, "not_filed")
  assert.equal(typeof refused.reason, "string")
  assert.ok(refused.body.includes(BODY))
  const broken = async (args, options) => { if (args[2] === "POST") throw new Error("boom"); return runner(args, options) }
  await assert.rejects(fileToolIssue(env, { tool: "shepherd", title: `${TITLE} two`, body: BODY, runner: broken }), /boom/u)
}))

test("friction_add names the reason, repo and text of a filing result however much of it is missing", async () => {
  const root = await mkTempDeskRoot()
  const run = (filed) => friction_add({ deskRoot: root, input: { about: "system", plugin: "m365crawl", title: TITLE, body: BODY }, fileIssue: async () => filed })
  assert.deepEqual(await run({ result: "held_cap" }), { status: "added", path: "_meta/friction.md", issue: "held_cap", repo: undefined })
  assert.match(await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"), /on m365crawl: not filed \(held_cap\)[\s\S]*admits chats only/u)
  assert.equal((await run({ result: "known", repo: "ourostack/m365crawl", url: "https://github.com/ourostack/m365crawl/issues/1" })).issue, "known")
})
