import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { withWorkspaceClaim } from "../../src/runtime/workspace-claim.js"
import { dispositionRecord, mergeTidyEvidence, acknowledgeTidyEvidence } from "../../src/runtime/workspace-evidence.js"
import { normalizeDeliveryEndpoint, inspectWorkspace } from "../../src/runtime/workspace-tidy.js"
import { readInspectionGit } from "../../src/runtime/git-inspection.js"
import { pathToFileURL } from "node:url"

async function resource() {
  const root = await mkTempRoot("desk-resource-claim-")
  const repository = path.join(root, "repo.git")
  await fs.mkdir(repository)
  return { repository, worktree: path.join(root, "worktree"), branch: "refs/heads/topic", owner: "task/attempt" }
}

test("R2 both exact identities are claimed and contention never removes another owner's locks", async () => {
  const r = await resource()
  await withWorkspaceClaim(r, async (held) => {
    await held()
    for (const other of [r, { ...r, worktree: `${r.worktree}-other` }, { ...r, branch: "refs/heads/other" }]) {
      await assert.rejects(withWorkspaceClaim(other, async () => assert.fail("must not acquire")), /claimed/)
      await held()
    }
    assert.equal((await fs.readdir(path.join(r.repository, "desk-resource-claims"))).length, 2)
  })
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
})

test("R2 incomplete identities and symlinked claim authority refuse mutation", async () => {
  const r = await resource()
  for (const patch of [{ repository: "relative" }, { worktree: "relative" }, { branch: "topic" }, { owner: "" }]) {
    await assert.rejects(withWorkspaceClaim({ ...r, ...patch }, async () => {}), /requires/)
  }
  const alias = `${r.repository}-alias`
  await fs.symlink(r.repository, alias, "dir")
  await assert.rejects(withWorkspaceClaim({ ...r, repository: alias }, async () => {}), /canonical/)
  const outsider = `${r.repository}-other`
  await fs.mkdir(outsider)
  await fs.symlink(outsider, path.join(r.repository, "desk-resource-claims"), "dir")
  await assert.rejects(withWorkspaceClaim(r, async () => {}), /unsafe/)
  assert.deepEqual(await fs.readdir(outsider), [])
})

test("R2 thrown operations release only their exact unchanged claims", async () => {
  const r = await resource()
  await assert.rejects(withWorkspaceClaim(r, async () => { throw new Error("action failed") }), /action failed/)
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
  await assert.rejects(withWorkspaceClaim(r, async () => {
    const files = await fs.readdir(path.join(r.repository, "desk-resource-claims"))
    await fs.writeFile(path.join(r.repository, "desk-resource-claims", files[0]), "different owner")
  }), /claim changed/)
  assert.equal((await fs.readdir(path.join(r.repository, "desk-resource-claims"))).length, 2)
})

test("R2 inability to create a claim is a reported refusal", async (t) => {
  const r = await resource()
  const open = fs.open.bind(fs)
  const mock = t.mock.method(fs, "open", (file, ...args) => String(file).endsWith(".lock")
    ? Promise.reject(Object.assign(new Error("claim access denied"), { code: "EACCES" })) : open(file, ...args))
  await assert.rejects(withWorkspaceClaim(r, async () => {}), /access denied/)
  mock.mock.restore()
})

test("R3 pending and legacy receipts persist, and stale or empty acknowledgements do not drain them", () => {
  const receipt = { repository: "/repo/.git", worktree: "/work/topic", branch: "refs/heads/topic", head: "abc", owner: "task/attempt" }
  const pending = dispositionRecord(receipt, "cleanup_pending")
  const initial = mergeTidyEvidence({}, {}, pending)
  assert.match(initial.left[0].reason, /cleanup pending/)
  assert.equal(mergeTidyEvidence(initial).resources[0].digest, pending.digest)
  const removed = dispositionRecord(receipt, "removed", true)
  const done = mergeTidyEvidence(initial, {}, removed)
  assert.equal(done.resources.length, 1)
  assert.equal(done.removed.length, 1)
  assert.equal(done.left.length, 0)
  assert.throws(() => acknowledgeTidyEvidence(done, { id: pending.id, digest: pending.digest, canonicalEvidence: "task.md" }), /changed/)
  assert.throws(() => acknowledgeTidyEvidence(done, { id: removed.id, digest: removed.digest, canonicalEvidence: "" }), /canonical/)
  assert.throws(() => acknowledgeTidyEvidence({}, { id: "missing", digest: "", canonicalEvidence: "task.md" }), /missing/)
  const ack = acknowledgeTidyEvidence(done, { id: removed.id, digest: removed.digest, canonicalEvidence: "task.md#resources" })
  assert.equal(ack.resources.length, 0)
  assert.equal(ack.acknowledgements[0].canonicalEvidence, "task.md#resources")
  assert.equal(acknowledgeTidyEvidence({ resources: [removed] }, { id: removed.id, digest: removed.digest, canonicalEvidence: "task.md" }).acknowledgements.length, 1)
  const legacy = { removed: [{ path: "/old/worktree" }], left: [{ path: "/old/branch", reason: "retained" }] }
  const first = mergeTidyEvidence(legacy)
  const second = mergeTidyEvidence(first)
  assert.deepEqual(second.removed, legacy.removed)
  assert.deepEqual(second.left, legacy.left)
  assert.deepEqual(mergeTidyEvidence().resources, [])
})

test("R3 acknowledging one resource never erases other unresolved observations", () => {
  const receipt = { repository: "/repo/.git", worktree: "/work/topic", branch: "refs/heads/topic", head: "abc", owner: "task" }
  const removed = dispositionRecord(receipt, "removed", true)
  const other = { path: "/work/other", reason: "unknown ownership" }
  const first = mergeTidyEvidence({}, { left: [other] }, removed)
  const repeated = mergeTidyEvidence(first, {})
  assert.deepEqual(repeated.left, [other])
  const ack = acknowledgeTidyEvidence(repeated, { id: removed.id, digest: removed.digest, canonicalEvidence: "task.md#resources" })
  assert.deepEqual(ack.left, [other])
  assert.equal(ack.resources.length, 1)
})

test("R7 endpoint normalization is exact, supports Git push spellings and excludes credential-bearing URLs", async () => {
  const r = await resource()
  assert.equal(await normalizeDeliveryEndpoint(r.repository, r.worktree), pathToFileURL(r.repository).href)
  assert.equal(await normalizeDeliveryEndpoint(pathToFileURL(r.repository).href, r.worktree), pathToFileURL(r.repository).href)
  assert.equal(await normalizeDeliveryEndpoint("./repo.git", path.dirname(r.repository)), pathToFileURL(r.repository).href)
  assert.equal(await normalizeDeliveryEndpoint("git@GitHub.com:owner/repo.git", r.worktree), "ssh://git@github.com/owner/repo.git")
  assert.equal(await normalizeDeliveryEndpoint("GitHub.com:owner/repo.git", r.worktree), "ssh://github.com/owner/repo.git")
  assert.equal(await normalizeDeliveryEndpoint("https://GitHub.com/owner/repo.git/", r.worktree), "https://github.com/owner/repo.git")
  for (const endpoint of ["", "bad endpoint", "http://host/repo", "https://token@host/repo", "ssh://user:password@host/repo", "https://host/repo?key=secret", "https://host/repo#fragment"]) {
    await assert.rejects(normalizeDeliveryEndpoint(endpoint, r.worktree), /endpoint/)
  }
})

test("R5 an already-cancelled Git inspection spawns no continuing process", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readInspectionGit(process.cwd(), ["status"], {}, { signal: controller.signal }), /abort/i)
  const result = await inspectWorkspace({ deskRoot: process.cwd(), signal: controller.signal })
  assert.equal(result.complete, false)
  assert.match(result.issues[0], /budget/)
})
