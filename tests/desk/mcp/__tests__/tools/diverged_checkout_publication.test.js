// #602: a card write from a shared checkout that has diverged from origin, with an unrelated unmerged index entry. The card's
// first write reaches origin/main; then another writer's unrelated commit lands on origin, the checkout gets its own unrelated
// commit and a conflict in a file the task does not own, and a later task_update edits the card. The update must reach origin/main
// or be reported with what is local and what is remote. Either way the unrelated work stays as it was and nothing is force-pushed.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { deliver } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { mkTempDeskRoot } from "./_helpers.js"
import { assertRoute } from "./_route_around.js"

const SCOPE = "a trip; not expenses"
const CARD = "trip/book-flights/task.md"
const EDIT = "Edited after the checkout diverged."

function git(cwd, args, input) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input })
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const onOrigin = (origin, args) => spawnSync("git", ["--git-dir", origin, ...args], { encoding: "utf8" })

// A bare origin on `main`, and the shared checkout pushed to it with the trip track already on origin.
async function sharedCheckout() {
  const root = await mkTempDeskRoot()
  const origin = `${root}-origin.git`
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" })
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await fs.writeFile(path.join(root, "README.md"), "seed\n", "utf8")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-q", "-m", "seed"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-q", "-u", "origin", "main"])
  await track_create({ deskRoot: root, input: { slug: "trip", title: "Trip", scope: SCOPE }, schedulePush: () => {} })
  git(root, ["push", "-q", "origin", "main"])
  return { root, origin }
}

// Another writer pushes an unrelated commit to origin/main, and the shared checkout commits its own unrelated edit. With
// `clashFile`, both sides edit that file, so the local commit cannot be replayed onto origin as it stands.
async function diverge({ root, origin, clashFile = null }) {
  const elsewhere = `${root}-elsewhere`
  spawnSync("git", ["clone", "-q", origin, elsewhere], { encoding: "utf8" })
  git(elsewhere, ["config", "user.email", "test@example.com"])
  git(elsewhere, ["config", "user.name", "Test"])
  const remoteFile = clashFile ?? "notes/remote.md"
  await fs.mkdir(path.dirname(path.join(elsewhere, remoteFile)), { recursive: true })
  await fs.writeFile(path.join(elsewhere, remoteFile), "remote edit\n", "utf8")
  git(elsewhere, ["add", "--", remoteFile])
  git(elsewhere, ["commit", "-q", "-m", "elsewhere: remote note", "--", remoteFile])
  git(elsewhere, ["push", "-q", "origin", "main"])

  const localFile = clashFile ?? "notes/local.md"
  await fs.mkdir(path.dirname(path.join(root, localFile)), { recursive: true })
  await fs.writeFile(path.join(root, localFile), "local edit\n", "utf8")
  git(root, ["add", "--", localFile])
  git(root, ["commit", "-q", "-m", "elsewhere: local note", "--", localFile])
}

// A real unmerged entry at notes/clash.md (stages 1-3), with the working file holding another writer's bytes.
async function unmergedClash(root) {
  const blob = (text) => git(root, ["hash-object", "-w", "--stdin"], text)
  const [base, ours, theirs] = [blob("base\n"), blob("ours\n"), blob("theirs\n")]
  git(root, ["update-index", "--index-info"], [`100644 ${base} 1\tnotes/clash.md`, `100644 ${ours} 2\tnotes/clash.md`, `100644 ${theirs} 3\tnotes/clash.md`, ""].join("\n"))
  await fs.mkdir(path.join(root, "notes"), { recursive: true })
  await fs.writeFile(path.join(root, "notes", "clash.md"), "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n", "utf8")
}

const snapshot = async (root) => ({
  index: git(root, ["ls-files", "-s", "--", "notes/clash.md"]),
  clash: await fs.readFile(path.join(root, "notes", "clash.md"), "utf8"),
  subjects: git(root, ["log", "--format=%s"]).split("\n"),
})

// The card's first write, published by Desk's push worker (run here as `deliver`), reaches origin/main before the divergence.
async function createdCard(root, origin) {
  const created = await task_create({ deskRoot: root, input: { track: "trip", slug: "book-flights", title: "Book the flights" }, schedulePush: () => {} })
  assert.equal(created.status, "created")
  assert.equal(deliver({ root }).state, "delivered")
  assert.match(onOrigin(origin, ["show", `main:${CARD}`]).stdout, /Book the flights/u, "origin/main holds the created card")
}

// The unrelated index entry and file bytes are as they were, the unrelated local commit is still in HEAD, and origin's unrelated commit is still on main.
async function assertUnrelatedWorkUntouched(root, origin, before, unrelatedRemote) {
  const after = await snapshot(root)
  assert.equal(after.index, before.index, "the unrelated unmerged entry is as it was")
  assert.equal(after.clash, before.clash, "the unrelated file's bytes are as they were")
  assert.ok(after.subjects.includes("elsewhere: local note"), "the unrelated local commit is still in HEAD")
  assert.equal(onOrigin(origin, ["merge-base", "--is-ancestor", unrelatedRemote, "main"]).status, 0, "origin's unrelated commit is still on main, so nothing was force-pushed")
}

// Either the update is on origin/main, or the result says it is not, with the route that finishes it. It never claims nothing reached the remote.
function assertUpdateReported(updated, onRemote) {
  if (onRemote.includes(EDIT)) return
  assert.ok(updated.commit, "the update is neither on origin/main nor reported as a failed commit")
  assertRoute(updated.commit.route_around)
  assert.doesNotMatch(JSON.stringify(updated), /nothing (reached|was pushed|reached the remote)/u, "the result never claims nothing reached the remote")
}

async function updateDiverged(root, origin, { clashFile = null } = {}) {
  await createdCard(root, origin)
  await diverge({ root, origin, clashFile })
  await unmergedClash(root)
  const before = await snapshot(root)
  const unrelatedRemote = onOrigin(origin, ["rev-parse", "main"]).stdout.trim()
  const updated = await task_update({ deskRoot: root, input: { track: "trip", slug: "book-flights", note: EDIT }, schedulePush: () => {} })
  assert.equal(updated.status, "updated")
  await assertUnrelatedWorkUntouched(root, origin, before, unrelatedRemote)
  return { updated, before, unrelatedRemote }
}

test("a later task_update reaches origin/main when the shared checkout is diverged with an unrelated unmerged path", async () => {
  const { root, origin } = await sharedCheckout()
  const { updated, before, unrelatedRemote } = await updateDiverged(root, origin)

  // Desk's push worker runs next: it delivers the card's commit.
  deliver({ root })
  await assertUnrelatedWorkUntouched(root, origin, before, unrelatedRemote)
  assertUpdateReported(updated, onOrigin(origin, ["show", `main:${CARD}`]).stdout)
})

test("the update still reaches origin/main when the unrelated local commit conflicts on a file Desk can merge", async () => {
  const { root, origin } = await sharedCheckout()
  const { updated } = await updateDiverged(root, origin, { clashFile: "README.md" })

  deliver({ root })
  assertUpdateReported(updated, onOrigin(origin, ["show", `main:${CARD}`]).stdout)
})

test("the update reaches origin/main while the unrelated local commit that conflicts on a file Desk cannot merge stays off the remote", async () => {
  const { root, origin } = await sharedCheckout()
  const { updated } = await updateDiverged(root, origin, { clashFile: "notes/data.json" })

  deliver({ root })
  assertUpdateReported(updated, onOrigin(origin, ["show", `main:${CARD}`]).stdout)
  assert.equal(onOrigin(origin, ["show", "main:notes/data.json"]).stdout, "remote edit\n", "origin holds only its own version of the conflicting file")
})
