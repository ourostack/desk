import { test } from "node:test"
import assert from "node:assert/strict"

import { issuesClient } from "../../src/factory/store-issues.js"

const TOKEN = "ghs_SENTINEL"
const ok = (json) => ({ code: 0, stdout: json === undefined ? "" : JSON.stringify(json), stderr: "" })

function recorder(answers) {
  const calls = []
  const runner = async (args, options) => {
    calls.push({ args, ...options })
    const answer = typeof answers === "function" ? answers(args, options) : answers.shift()
    return answer
  }
  return { calls, runner }
}

const route = (call) => call.args[call.args.indexOf("X-GitHub-Api-Version: 2022-11-28") + 1]
const method = (call) => call.args[call.args.indexOf("--method") + 1]

test("issuesClient refuses a bad runner, repository or token", () => {
  assert.throws(() => issuesClient({ runner: null, repo: "o/r", token: TOKEN }), /runner/u)
  assert.throws(() => issuesClient({ runner: () => {}, repo: "not a repo", token: TOKEN }), /repo/u)
  assert.throws(() => issuesClient({ runner: () => {}, repo: "o/r", token: "" }), /token/u)
})

test("listIssues pages through the store's issues and keeps only the fields the steps use", async () => {
  const full = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: "t", body: null, labels: [{ name: "kaizen" }], state: "open", user: { login: "someone" } }))
  const { calls, runner } = recorder([ok(full), ok([{ number: 101, body: "b", labels: ["kaizen", 7], state: "closed", pull_request: {}, user: null }])])
  const client = issuesClient({ runner, repo: "ourostack/factory", token: TOKEN })
  const issues = await client.listIssues({ label: "kaizen", state: "all" })
  assert.equal(issues.length, 101)
  assert.deepEqual(issues[0], { number: 1, title: "t", body: "", labels: ["kaizen"], state: "open", author: "someone", pull_request: false })
  assert.deepEqual(issues[100], { number: 101, title: "", body: "b", labels: ["kaizen"], state: "closed", author: null, pull_request: true })
  assert.deepEqual(calls.map(route), [
    "repos/ourostack/factory/issues?state=all&labels=kaizen&per_page=100&page=1",
    "repos/ourostack/factory/issues?state=all&labels=kaizen&per_page=100&page=2",
  ])
  for (const call of calls) {
    assert.equal(call.token, TOKEN)
    assert.equal(call.args.includes(TOKEN), false, "the token is never an argument")
    assert.equal(call.input, undefined)
  }
  await assert.rejects(client.listIssues({ label: "kaizen", state: "some" }), /label and state/u)
})

test("listComments pages and reduces each comment to its id, author and body", async () => {
  const { calls, runner } = recorder([ok([{ id: 5, user: { login: "github-actions[bot]" }, body: "hi" }, { id: 6, body: null }])])
  const client = issuesClient({ runner, repo: "o/r", token: TOKEN })
  assert.deepEqual(await client.listComments(3), [{ id: 5, author: "github-actions[bot]", body: "hi" }, { id: 6, author: null, body: "" }])
  assert.equal(route(calls[0]), "repos/o/r/issues/3/comments?per_page=100&page=1")
})

test("the write calls send exact routes and JSON bodies on standard input", async () => {
  const { calls, runner } = recorder((args) => (args.includes("repos/o/r/issues") ? ok({ number: 9, html_url: "https://github.com/o/r/issues/9" }) : ok()))
  const client = issuesClient({ runner, repo: "o/r", token: TOKEN, timeoutMs: 5 })
  await client.createComment(3, "body")
  await client.updateComment(77, "new")
  await client.addLabels(3, ["confirmed"])
  await client.removeLabel(3, "not-confirmed")
  assert.deepEqual(await client.createIssue({ title: "T", body: "B", labels: ["andon"] }), { number: 9, url: "https://github.com/o/r/issues/9" })
  await client.updateIssue(9, { state: "closed" })
  assert.deepEqual(calls.map((call) => [method(call), route(call), call.input === undefined ? null : JSON.parse(call.input)]), [
    ["POST", "repos/o/r/issues/3/comments", { body: "body" }],
    ["PATCH", "repos/o/r/issues/comments/77", { body: "new" }],
    ["POST", "repos/o/r/issues/3/labels", { labels: ["confirmed"] }],
    ["DELETE", "repos/o/r/issues/3/labels/not-confirmed", null],
    ["POST", "repos/o/r/issues", { title: "T", body: "B", labels: ["andon"] }],
    ["PATCH", "repos/o/r/issues/9", { state: "closed" }],
  ])
  assert.equal(calls[0].timeoutMs, 5)
  assert.ok(calls.filter((call) => call.input !== undefined).every((call) => call.args.slice(-2).join(" ") === "--input -"))
})

test("failures become one stable code", async () => {
  const cases = [
    [{ code: null, stdout: "", stderr: "", spawnError: "ENOENT" }, "gh_missing"],
    [{ code: null, stdout: "", stderr: "", timedOut: true }, "timeout"],
    [{ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }, "http_404"],
    [{ code: 1, stdout: "", stderr: "something else" }, "gh_failed"],
    [{ code: 1 }, "gh_failed"],
    [{ code: 0, stdout: "not json", stderr: "" }, "unexpected_answer"],
    [ok({ not: "a list" }), "unexpected_answer"],
    [ok([{ number: "x" }]), "unexpected_answer"],
  ]
  for (const [answer, code] of cases) {
    const client = issuesClient({ runner: async () => answer, repo: "o/r", token: TOKEN })
    await assert.rejects(client.listIssues({ label: "kaizen", state: "open" }), (error) => error.code === code, code)
  }
  const comments = issuesClient({ runner: async () => ok([{ id: "x" }]), repo: "o/r", token: TOKEN })
  await assert.rejects(comments.listComments(1), (error) => error.code === "unexpected_answer")
  const created = issuesClient({ runner: async () => ok({ number: 1 }), repo: "o/r", token: TOKEN })
  await assert.rejects(created.createIssue({ title: "T", body: "B", labels: [] }), (error) => error.code === "unexpected_answer")
  const silent = issuesClient({ runner: async () => ({ code: 0 }), repo: "o/r", token: TOKEN })
  await silent.createComment(1, "body")
  const empty = issuesClient({ runner: async () => ok(), repo: "o/r", token: TOKEN })
  await assert.rejects(empty.createIssue({ title: "T", body: "B", labels: [] }), (error) => error.code === "unexpected_answer")
  const endless = issuesClient({ runner: async () => ok(Array.from({ length: 100 }, (_, index) => ({ id: index }))), repo: "o/r", token: TOKEN })
  await assert.rejects(endless.listComments(1), (error) => error.code === "too_many_comments")
  const endlessIssues = issuesClient({ runner: async () => ok(Array.from({ length: 100 }, (_, index) => ({ number: index + 1, labels: [] }))), repo: "o/r", token: TOKEN })
  await assert.rejects(endlessIssues.listIssues({ label: "andon", state: "all" }), (error) => error.code === "too_many_issues")
})
