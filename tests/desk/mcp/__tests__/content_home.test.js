import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { task_update } from "../../../../plugins/desk/mcp/src/tools/task.js"
import { desk_save } from "../../../../plugins/desk/mcp/src/tools/desk-save.js"

const POLICY = {
  schema_version: 1,
  mode: "declared-purpose",
  repository: "sample/context",
  context_purposes: ["coordination", "project-plan", "metadata", "source-context", "historical-evidence", "migration-pointer"],
  product_purposes: ["product-contract", "product-tool", "product-run-artifact"],
}
const CARD = "---\nschema_version: 1\ntitle: Existing work\nstatus: processing\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Existing work\n\n**Next step:** Keep the existing owner.\n\n## Historical source\n\nA frozen private execution brief and its original instructions stay here.\n"
const cardPath = "track/existing/task.md"
const digest = (value) => createHash("sha256").update(value).digest("hex")
const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}
async function fixture(t, policy = POLICY) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-content-home-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  await fs.mkdir(path.join(root, "track/existing"), { recursive: true })
  await fs.writeFile(path.join(root, cardPath), CARD)
  if (policy !== null) {
    await fs.mkdir(path.join(root, ".desk"))
    await fs.writeFile(path.join(root, ".desk/content-home.json"), JSON.stringify(policy))
  }
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "Published context"])
  git(root, ["remote", "add", "origin", "https://github.com/sample/context.git"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  git(root, ["config", "branch.main.remote", "origin"])
  git(root, ["config", "branch.main.merge", "refs/heads/main"])
  return root
}
const update = (root, input) => task_update({
  deskRoot: root, input: { track: "track", slug: "existing", ...input }, schedulePush() {},
})
const save = (root, input) => desk_save({ deskRoot: root, input: { message: "Save context", ...input }, schedulePush() {} })
const context = (purpose = "coordination", lifecycle = "current") => ({ purpose, lifecycle })
const product = (purpose = "product-contract") => ({ purpose, lifecycle: "current", product_repository: "sample/product" })
const snapshot = async (root) => ({
  head: git(root, ["rev-parse", "HEAD"]),
  index: git(root, ["ls-files", "--stage"]),
  status: git(root, ["status", "--porcelain"]),
  card: await fs.readFile(path.join(root, cardPath), "utf8"),
})

test("task_update requires a purpose before changing an opted-in published card", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  await assert.rejects(update(root, { note: "Owner and status only." }), /content_home_required/u)
  assert.deepEqual(await snapshot(root), before)
})

for (const purpose of POLICY.product_purposes) {
  test(`task_update refuses declared current ${purpose} before writing or committing`, async (t) => {
    const root = await fixture(t)
    const before = await snapshot(root)
    await assert.rejects(update(root, {
      body_append: "Implementation ordering, runner entrypoints, or release acceptance.",
      content_home: product(purpose),
    }), /content_home_wrong_repository/u)
    assert.deepEqual(await snapshot(root), before)
  })
}

test("task_update accepts coordination and preserves existing historical text and next step", async (t) => {
  const root = await fixture(t)
  const result = await update(root, { note: "Existing owner continues; product details remain linked upstream.", content_home: context() })
  assert.equal(result.status, "updated")
  const after = await fs.readFile(path.join(root, cardPath), "utf8")
  assert.ok(after.includes("**Next step:** Keep the existing owner."))
  assert.ok(after.includes("A frozen private execution brief and its original instructions stay here."))
  assert.ok(after.includes("Existing owner continues; product details remain linked upstream."))
  assert.equal(result.content_admission.policy_commit, git(root, ["rev-parse", "origin/main"]))
  assert.equal(result.content_admission.subjects.note.sha256, digest("Existing owner continues; product details remain linked upstream."))
})

test("desk_save refuses an entire mixed file batch before writing its accepted first file", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  await assert.rejects(save(root, {
    files: [{ path: "context.md", content: "CIT status." }, { path: "planning.md", content: "Current product implementation contract." }],
    content_home: {
      purpose: "mixed",
      sections: [
        { subject: "files/0/content", ...context() },
        { subject: "files/1/content", ...product() },
      ],
    },
  }), /content_home_wrong_repository/u)
  await assert.rejects(fs.access(path.join(root, "context.md")))
  await assert.rejects(fs.access(path.join(root, "planning.md")))
  assert.deepEqual(await snapshot(root), before)
})

for (const [name, purpose, lifecycle] of [
  ["planning.md", "project-plan", "current"],
  ["source-contract.json", "historical-evidence", "historical"],
  ["private-receipt.log", "source-context", "historical"],
  ["lookbook.md", "source-context", "current"],
]) {
  test(`desk_save preserves ${name} by declared purpose, not extension or embedded recipes`, async (t) => {
    const root = await fixture(t)
    const content = "# Preserved source\n\nputDraft/tx ordering; npm run harness; original relative ./mockup.png.\n"
    const held = "Unique uncommitted evidence must remain byte-identical.\n"
    await fs.writeFile(path.join(root, "held-original.log"), held)
    const result = await save(root, {
      files: [{ path: name, content }],
      content_home: { ...context(purpose, lifecycle), source_reference: "Original private brief; not cleared for public copying." },
    })
    assert.equal(result.status, "committed")
    assert.equal(await fs.readFile(path.join(root, name), "utf8"), content)
    assert.equal(await fs.readFile(path.join(root, "held-original.log"), "utf8"), held)
    assert.equal(git(root, ["show", "--format=", "--name-only", "HEAD"]), name)
  })
}

test("mixed sections must cover the exact new text without a gap or overlap", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  for (const sections of [
    [{ subject: "note", start: 0, end: 3, ...context() }],
    [{ subject: "note", start: 0, end: 4, ...context() }, { subject: "note", start: 3, end: 5, ...context() }],
  ]) {
    await assert.rejects(update(root, { note: "abcde", content_home: { purpose: "mixed", sections } }), /content_home_unresolved/u)
    assert.deepEqual(await snapshot(root), before)
  }
})

test("mixed metadata and historical source sections are accepted without creating product authority", async (t) => {
  const root = await fixture(t)
  const result = await update(root, {
    body_append: "Status.Original private plan.",
    content_home: {
      purpose: "mixed",
      sections: [
        { subject: "body_append", start: 0, end: 7, ...context("metadata") },
        { subject: "body_append", start: 7, end: 29, ...context("historical-evidence", "historical"), source_reference: "Frozen original" },
      ],
    },
  })
  assert.equal(result.status, "updated")
})

test("an unresolved purpose is surfaced without rewriting historical bytes", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  await assert.rejects(update(root, { note: "Ambiguous material.", content_home: { purpose: "unknown", lifecycle: "current" } }), /content_home_unresolved/u)
  assert.deepEqual(await snapshot(root), before)
})

test("a candidate cannot weaken the published purpose policy", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, ".desk/content-home.json"), JSON.stringify({ ...POLICY, context_purposes: ["product-contract"] }))
  const before = await snapshot(root)
  await assert.rejects(update(root, { note: "Product authority.", content_home: product() }), /content_home_wrong_repository/u)
  assert.deepEqual(await snapshot(root), before)
})

test("opted-in task_update refuses to adopt a dirty target card", async (t) => {
  const root = await fixture(t)
  await fs.appendFile(path.join(root, cardPath), "\nHeld draft; do not adopt or publish.\n")
  const before = await snapshot(root)
  await assert.rejects(update(root, { note: "Metadata.", content_home: context() }), /content_home_dirty_target/u)
  assert.deepEqual(await snapshot(root), before)
})

test("an unpublished base is refused without replaying its commits or held bytes", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "held.md"), "Unpublished source.\n")
  git(root, ["add", "held.md"])
  git(root, ["commit", "-qm", "Held source"])
  const before = await snapshot(root)
  await assert.rejects(update(root, { note: "Metadata.", content_home: context() }), /content_home_unpublished_base/u)
  assert.deepEqual(await snapshot(root), before)
  assert.equal(await fs.readFile(path.join(root, "held.md"), "utf8"), "Unpublished source.\n")
})

test("malformed published policy fails closed before desk_save writes", async (t) => {
  const root = await fixture(t, { schema_version: 999 })
  const before = await snapshot(root)
  await assert.rejects(save(root, { files: [{ path: "new.md", content: "Context." }], content_home: context() }), /content_home_policy_invalid/u)
  assert.deepEqual(await snapshot(root), before)
  await assert.rejects(fs.access(path.join(root, "new.md")))
})

test("desks without an opted-in policy keep existing mutation behavior", async (t) => {
  const root = await fixture(t, null)
  assert.equal((await update(root, { note: "Ordinary unchanged Desk behavior." })).status, "updated")
})

test("desk_save paths refuses wrong-home bytes without staging the selected draft", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "implementation.md"), "Current source/test ordering and acceptance contract.\n")
  const before = await snapshot(root)
  await assert.rejects(save(root, { paths: ["implementation.md"], content_home: product() }), /content_home_wrong_repository/u)
  assert.deepEqual(await snapshot(root), before)
})

test("desk_save paths binds preserved binary evidence to its actual input bytes", async (t) => {
  const root = await fixture(t)
  const bytes = Buffer.from([0, 255, 13, 10, 128, 42])
  await fs.writeFile(path.join(root, "original.bin"), bytes)
  const result = await save(root, { paths: ["original.bin"], content_home: context("historical-evidence", "historical") })
  assert.equal(result.status, "committed")
  assert.deepEqual(result.content_admission.subjects["paths/0"], { sha256: digest(bytes), bytes: bytes.length })
  assert.deepEqual(await fs.readFile(path.join(root, "original.bin")), bytes)
})

test("opted-in task status changes cannot adopt a staged track-card draft", async (t) => {
  const root = await fixture(t)
  const track = "# Track\n\n| Slug | State | Repos | Tracker link | Doing doc |\n|---|---|---|---|---|\n| existing | processing | | | |\n"
  await fs.writeFile(path.join(root, "track/track.md"), track)
  git(root, ["add", "track/track.md"])
  git(root, ["commit", "-qm", "Published track"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  const held = `${track}\nHeld product contract; not this update's payload.\n`
  await fs.writeFile(path.join(root, "track/track.md"), held)
  git(root, ["add", "track/track.md"])
  const before = await snapshot(root)
  await assert.rejects(update(root, { status: "paused", content_home: context() }), /content_home_dirty_target/u)
  assert.deepEqual(await snapshot(root), before)
  assert.equal(await fs.readFile(path.join(root, "track/track.md"), "utf8"), held)
})

test("desk_save files cannot overwrite a held target while accepting new context", async (t) => {
  const root = await fixture(t)
  const held = "Unique held original.\n"
  await fs.writeFile(path.join(root, "held-original.md"), held)
  const before = await snapshot(root)
  await assert.rejects(save(root, {
    files: [{ path: "held-original.md", content: "Replacement context.\n" }],
    content_home: context(),
  }), /content_home_dirty_target/u)
  assert.deepEqual(await snapshot(root), before)
  assert.equal(await fs.readFile(path.join(root, "held-original.md"), "utf8"), held)
})

test("misspelled section declarations refuse instead of silently classifying a whole payload", async (t) => {
  const root = await fixture(t)
  const before = await snapshot(root)
  await assert.rejects(update(root, {
    note: "Mixed source whose section declaration is misspelled.",
    content_home: { ...context(), section: [{ purpose: "product-contract" }] },
  }), /content_home_unresolved/u)
  assert.deepEqual(await snapshot(root), before)
})

test("published policy receipt hashes the exact published bytes, not reserialized JSON", async (t) => {
  const root = await fixture(t)
  const raw = `${JSON.stringify(POLICY, null, 2)}\n`
  await fs.writeFile(path.join(root, ".desk/content-home.json"), raw)
  git(root, ["add", ".desk/content-home.json"])
  git(root, ["commit", "-qm", "Published readable policy"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  const result = await update(root, { note: "Metadata.", content_home: context() })
  assert.equal(result.content_admission.policy_sha256, digest(raw))
})

test("desk_save refuses pathspec expansion before unclassified matching files can be staged", async (t) => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, "docs"))
  await fs.writeFile(path.join(root, "docs/actual.md"), "Current product implementation contract.\n")
  const before = await snapshot(root)
  await assert.rejects(save(root, {
    paths: ["docs/*.md"],
    content_home: { purpose: "mixed", sections: [{ subject: "paths/0", start: 0, end: 0, ...context() }] },
  }), /content_home_unresolved/u)
  assert.deepEqual(await snapshot(root), before)
})

for (const tool of ["task_update", "desk_save"]) {
  test(`${tool} cannot miss a repository-root policy when bound to a nested desk`, async (t) => {
    const root = await fixture(t)
    const nested = path.join(root, "member")
    await fs.mkdir(path.join(nested, "track/existing"), { recursive: true })
    await fs.writeFile(path.join(nested, cardPath), CARD)
    git(root, ["add", "member"])
    git(root, ["commit", "-qm", "Published nested desk"])
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
    const before = await snapshot(root)
    const nestedBefore = await fs.readFile(path.join(nested, cardPath), "utf8")
    const mutate = tool === "task_update"
      ? () => update(nested, { note: "No declaration." })
      : () => save(nested, { files: [{ path: "context.md", content: "No declaration." }] })
    await assert.rejects(mutate(), /content_home_required/u)
    assert.deepEqual(await snapshot(root), before)
    assert.equal(await fs.readFile(path.join(nested, cardPath), "utf8"), nestedBefore)
    await assert.rejects(fs.access(path.join(nested, "context.md")))
  })
}

test("archived resource metadata keeps its frozen frontmatter and accepts the declaration field", async (t) => {
  const root = await fixture(t)
  const original = `${CARD}\n## Resources\n\n| Exact resource / generation identity | Owning task / attempt / generation | Active writers / consumers | Intended disposition | Evidence pointer | Terminal disposition details |\n|---|---|---|---|---|---|\n| branch:sample/product#work | task track/existing | none | retain | original | |\n`
  await fs.writeFile(path.join(root, cardPath), original)
  await fs.mkdir(path.join(root, "track/_archive"), { recursive: true })
  git(root, ["add", cardPath])
  git(root, ["mv", "track/existing", "track/_archive/existing"])
  git(root, ["commit", "-qm", "Published archived source"])
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"])
  const result = await update(root, {
    resource: { identity: "branch:sample/product#work", disposition: "retained-with-trigger", details: "Keep original; owner unchanged." },
    content_home: context("metadata"),
  })
  assert.equal(result.status, "updated")
  assert.equal(result.content_admission.policy_commit, git(root, ["rev-parse", "origin/main"]))
  const after = await fs.readFile(path.join(root, "track/_archive/existing/task.md"), "utf8")
  assert.equal(after.slice(0, after.indexOf("\n# Existing")), original.slice(0, original.indexOf("\n# Existing")))
  assert.ok(after.includes("retained-with-trigger: Keep original; owner unchanged."))
})

test("opted-in tidy preserves frozen card bytes and unrelated staged source", async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, "held-original.json"), "Unique private evidence; not cleared for public copying.\n")
  git(root, ["add", "held-original.json"])
  const held = git(root, ["ls-files", "--stage", "--", "held-original.json"])
  git(root, ["mv", "track/existing", "track/renamed"])
  const result = await save(root, {
    paths: [cardPath, "track/renamed/task.md"],
    tidy: true,
    content_home: context("historical-evidence", "historical"),
  })
  assert.equal(result.status, "committed")
  assert.equal(result.content_admission.subjects["paths/0"].bytes, 0)
  assert.equal(result.content_admission.subjects["paths/1"].sha256, digest(CARD))
  assert.equal(git(root, ["show", "HEAD:track/renamed/task.md"]), CARD.trim())
  assert.equal(git(root, ["ls-files", "--stage", "--", "held-original.json"]), held)
  assert.equal(git(root, ["status", "--porcelain", "--", "held-original.json"]), "A  held-original.json")
  assert.deepEqual(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").sort(), [cardPath, "track/renamed/task.md"].sort())
})
