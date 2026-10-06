// task_update on a card that says its work is on another machine: `repos` cannot drop or rename the repo the clone guard matches, so the only way past the guard stays the operator's word, recorded as `next_step`
// (boot acceptance round AL, Copilot `elsewhere-clone` run 1: the agent rewrote `repos` after the clone was denied).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { elsewhereCloneDenial } from "../../../../../plugins/desk/mcp/src/runtime/elsewhere-clone.js"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot } from "./_helpers.js"

const REPO = "ari-fixture/relay-config"
const CLONE = `git clone https://github.com/${REPO}.git`
const ELSEWHERE_STEP = "**Next step:** push `relay-heartbeat-15s` from my other laptop, then review the branch here."
const HERE_STEP = "The operator pushed `relay-heartbeat-15s` to the fork; review the branch."

async function card({ repos = [{ name: REPO, local_path: "", mode: "remote" }], body = `## Current work\n\nThe branch is only on my other laptop.\n\n${ELSEWHERE_STEP}\n` } = {}) {
  const root = await mkTempDeskRoot()
  await writeMarkdown(path.join(root, "t", "relay", "task.md"), { schema_version: 1, title: "relay", status: "processing", created: "2026-09-29T09:00:00Z", repos }, body)
  const load = async () => activeTasks(root).tracks.flatMap((track) => track.tasks)
  const update = (input) => task_update({ deskRoot: root, input: { track: "t", slug: "relay", ...input }, schedulePush: () => {} })
  const denied = async () => (await elsewhereCloneDenial({ command: CLONE, cwd: root, env: {}, load })).deny
  return { update, denied }
}

const REFUSAL = /task_update: record the operator's word with `next_step`; `repos` cannot drop a repo from a card marked elsewhere\./u

test("a refusal names the fix in its first sentence, within 120 characters", async () => {
  const { update } = await card()
  await assert.rejects(() => update({ frontmatter: { repos: [] } }), (error) => {
    assert.match(error.message, REFUSAL)
    assert.ok(error.message.split(". ")[0].length <= 120, error.message.split(". ")[0])
    return true
  })
})

test("every repos edit that drops or renames the matched repo is refused, and the guard still denies the clone", async () => {
  const edits = [
    [{ name: "other-owner/other", local_path: "", mode: "remote" }],
    [{ name: "relay-config", local_path: "", mode: "remote" }],
    [{ name: "", local_path: "", mode: "remote" }],
    [null],
    [{ name: "x/y", local_path: "", mode: "remote" }],
    [],
  ]
  for (const repos of edits) {
    const { update, denied } = await card()
    await assert.rejects(() => update({ frontmatter: { repos } }), REFUSAL, JSON.stringify(repos))
    assert.equal(await denied(), true, JSON.stringify(repos))
  }
  const { update, denied } = await card()
  await assert.rejects(() => update({ frontmatter: { repos: [] }, repos_removed_reason: "not code" }), REFUSAL)
  await assert.rejects(() => update({ frontmatter: { repos: [] }, status: "cancelled" }), REFUSAL)
  assert.equal(await denied(), true)
})

test("a repos edit with a next step that still says the work is elsewhere is refused too", async () => {
  const { update, denied } = await card()
  await assert.rejects(() => update({ frontmatter: { repos: [] }, next_step: "Push it from my other laptop." }), REFUSAL)
  assert.equal(await denied(), true)
})

test("edits that keep the repo (mode, local_path, case, extra repos) are allowed and do not clear the denial", async () => {
  const { update, denied } = await card()
  for (const repos of [
    [{ name: REPO, local_path: "", mode: "local" }],
    [{ name: REPO, local_path: "~/code/relay-config", mode: "local" }],
    [{ name: REPO.toUpperCase(), local_path: "", mode: "remote" }],
    [{ name: REPO, local_path: "", mode: "remote" }, { name: "ari-fixture/other", local_path: "", mode: "remote" }],
  ]) {
    assert.equal((await update({ frontmatter: { repos } })).status, "updated")
    assert.equal(await denied(), true, "repos edits cannot clear the denial")
  }
})

test("the operator's word, recorded as next_step, clears the denial, and may edit repos in the same call", async () => {
  const { update, denied } = await card()
  assert.equal((await update({ next_step: HERE_STEP, frontmatter: { repos: [{ name: "ari-fixture/renamed", local_path: "", mode: "remote" }] } })).status, "updated")
  assert.equal(await denied(), false)
})

test("a blocker that says the work is elsewhere also protects the repos", async () => {
  const { update } = await card({ body: "## Current work\n\nWaiting.\n\n**Next step:** review the branch.\n\n**Blocker:** the branch is only on my other laptop.\n" })
  await assert.rejects(() => update({ frontmatter: { repos: [] } }), REFUSAL)
  // A new next step does not clear a blocker that still says it.
  await assert.rejects(() => update({ next_step: HERE_STEP, frontmatter: { repos: [] } }), REFUSAL)
})

test("cards with no elsewhere marking are unaffected: repos may be renamed, removed or emptied", async () => {
  const body = "## Current work\n\nWork.\n\n**Next step:** run the tests.\n"
  const { update } = await card({ body })
  assert.equal((await update({ frontmatter: { repos: [{ name: "a/b", local_path: "", mode: "remote" }] } })).status, "updated")
  assert.equal((await update({ frontmatter: { repos: [{ name: "c/d", local_path: "", mode: "remote" }] } })).status, "updated")
  assert.equal((await update({ frontmatter: { repos: [] }, repos_removed_reason: "not code" })).status, "updated")
  // A card that said elsewhere and no longer does is free too.
  const { update: later } = await card()
  await later({ next_step: HERE_STEP })
  assert.equal((await later({ frontmatter: { repos: [] }, repos_removed_reason: "not code" })).status, "updated")
})

test("a card with no repos and an elsewhere marking can still gain repos", async () => {
  const { update } = await card({ repos: [] })
  assert.equal((await update({ frontmatter: { repos: [{ name: "a/b", local_path: "", mode: "remote" }] } })).status, "updated")
})
