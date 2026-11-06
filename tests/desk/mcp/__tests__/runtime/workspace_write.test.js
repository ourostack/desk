import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fork, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { withWorkspaceClaim } from "../../../../../plugins/desk/mcp/src/runtime/workspace-claim.js"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { createDeskSession } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"

const actor = fileURLToPath(new URL("./_workspace_write_actor.mjs", import.meta.url))
function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
async function fixture(t, initialize = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "desk-producer-396-"))
  console.log(`owned producer fixture created: ${base}`)
  const cleanup = []
  t.after(async () => { for (const close of cleanup) await close(); await fs.rm(base, { recursive: true, force: true }) })
  const root = path.join(base, "source")
  await fs.mkdir(root)
  if (!initialize) return { root, base, cleanup }
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.name", "Test"])
  git(root, ["config", "user.email", "test@example.com"])
  await fs.writeFile(path.join(root, "kept.md"), "original\n")
  git(root, ["add", "kept.md"])
  git(root, ["commit", "-qm", "initial"])
  const repository = await fs.realpath(git(root, ["rev-parse", "--absolute-git-dir"]))
  return { root: await fs.realpath(root), base, repository, branch: "refs/heads/main", owner: "fixture-owner", cleanup }
}
function start(t, mode, resource) {
  const child = fork(actor, [mode, resource.root, resource.repository, resource.branch], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
  console.log(`owned producer process created: ${child.pid}; root: ${resource.root}`)
  const messages = [], waiters = []
  let errors = ""
  child.stderr.on("data", data => { errors += data })
  child.on("message", message => { messages.push(message); waiters.shift()?.() })
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`actor ${code}/${signal}: ${errors}`)))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed.catch(() => {})
  })
  return { child, closed, async next() {
    if (!messages.length) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`actor response deadline: ${errors}`)), 10000)
      waiters.push(() => { clearTimeout(timer); resolve() })
    })
    return messages.shift()
  } }
}
const save = (root, input, extra = {}) => desk_save({ deskRoot: root, input, schedulePush() {}, ...extra })

for (const mode of ["save", "server"]) {
  for (const variant of ["files", "paths", "tidy"]) {
    test(`${mode} ${variant} refuses a separate process claim before source/index/HEAD mutation`, { timeout: 20000 }, async t => {
      const r = await fixture(t)
      await fs.writeFile(path.join(r.root, "pending.md"), "pending\n")
      const input = variant === "files"
        ? { files: [{ path: "new/folder/result.md", content: "must not arrive\n" }], message: "blocked" }
        : { paths: ["pending.md"], message: "blocked", ...(variant === "tidy" ? { tidy: true } : {}) }
      await fs.writeFile(`${r.root}.input.json`, JSON.stringify(input))
      const head = git(r.root, ["rev-parse", "HEAD"])
      const index = await fs.readFile(path.join(r.repository, "index"))
      const holder = start(t, "hold", r)
      assert.deepEqual(await holder.next(), { status: "held" })
      try {
        const writer = start(t, mode, r)
        const response = await writer.next()
        await writer.closed
        const error = response.error ?? (response.result?.isError ? JSON.parse(response.result.content[0].text).message : null)
        assert.match(error ?? "", /resource already claimed/u)
        await assert.rejects(fs.stat(path.join(r.root, "new")), { code: "ENOENT" })
        assert.equal(git(r.root, ["rev-parse", "HEAD"]), head)
        assert.deepEqual(await fs.readFile(path.join(r.repository, "index")), index)
        assert.equal(await fs.readFile(path.join(r.root, "pending.md"), "utf8"), "pending\n")
      } finally {
        holder.child.send("release")
        assert.deepEqual(await holder.next(), { status: "released" })
        await holder.closed
      }
    })
  }
}

test("nested exact owner capability reuses claim without releasing it and expires afterward", async t => {
  const r = await fixture(t), resource = { ...r, worktree: r.root }
  let reuse
  await withWorkspaceClaim(resource, async (assertHeld, capability) => {
    assert.equal(typeof capability?.run, "function")
    reuse = capability
    await withWorkspaceClaim({ ...resource, reuse }, async inner => {
      await inner()
      assert.equal((await fs.readdir(path.join(r.repository, "desk-resource-claims"))).length, 2)
    })
    await assertHeld()
    await assert.rejects(withWorkspaceClaim({ ...resource, owner: "other", reuse }, async () => {}), /owner|resource/u)
    await assert.rejects(withWorkspaceClaim({ ...resource, branch: "refs/heads/other", reuse }, async () => {}), /owner|resource/u)
    await assert.rejects(withWorkspaceClaim({ ...resource, reuse: JSON.parse(JSON.stringify(reuse)) }, async () => {}), /capability/u)
  })
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
  await assert.rejects(withWorkspaceClaim({ ...resource, reuse }, async () => {}), /expired/u)
})

test("broken Git metadata refuses desk_save before truncating a source file", async t => {
  const { root } = await fixture(t, false)
  await fs.writeFile(path.join(root, ".git"), "gitdir: missing-admin\n")
  await fs.writeFile(path.join(root, "notes.md"), "kept\n")
  await assert.rejects(save(root, { files: [{ path: "notes.md", content: "lost\n" }], message: "refused" }), /Git|git/u)
  assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "kept\n")
})

test("positive non-Git desk still writes supplied files even with an explicit branch policy", async t => {
  const { root } = await fixture(t, false)
  const result = await save(root, { files: [{ path: "notes.md", content: "saved\n" }], message: "save" }, { writeContext: { stateBranch: "configured" } })
  assert.equal(result.status, "nothing_to_commit")
  assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "saved\n")
})

async function sessionFor(r, verifyAuthority, stateBranch = null) {
  const policy = { lexical: "required", semantic: "unsupported", write_authority: "workspace", authority_provider: null, root: "workspace" }
  const session = createDeskSession({
    args: { person: null },
    deskStateDir: path.join(r.base, "state"),
    readinessStateHome: path.join(r.base, "readiness"),
    stderr: { write() {} },
    resolveInputs: async () => ({ root: { root: r.root, source: "explicit-root" }, activation: { activationStatus: null, readinessPolicy: policy, stateBranch } }),
    loadRuntime: async () => ({
      runtimeServer: { callTool, verifyAuthority, createSearchEngine: () => ({ warm() {}, async close() {} }) },
      runtimeStatus: { state: "ready" },
    }),
  })
  r.cleanup.push(() => session.dispose())
  assert.equal((await session.admission.refresh()).state, "ready")
  return session
}

test("admitted desk_save rechecks revoked authority under the actual held claim before first byte", async t => {
  const r = await fixture(t)
  let claimedCheck = false
  const session = await sessionFor(r, async () => {
    const locks = await fs.readdir(path.join(r.repository, "desk-resource-claims")).catch(error => {
      if (error.code === "ENOENT") return []
      throw error
    })
    if (locks.length) {
      claimedCheck = true
      throw new Error("fixture authority revoked")
    }
    return { mode: "workspace" }
  })
  const result = await session.callTool({ name: "desk_save", input: { files: [{ path: "not-created/note.md", content: "no\n" }], message: "no" } })
  assert.equal(result.isError, true)
  assert.equal(claimedCheck, true)
  await assert.rejects(fs.stat(path.join(r.root, "not-created")), { code: "ENOENT" })
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
})

test("branch changed during under-claim authority recheck refuses before any write", async t => {
  const r = await fixture(t)
  let moved = false
  const session = await sessionFor(r, async () => {
    const locks = await fs.readdir(path.join(r.repository, "desk-resource-claims")).catch(() => [])
    if (locks.length && !moved) { git(r.root, ["switch", "-qc", "external"]); moved = true }
    return { mode: "workspace" }
  })
  const result = await session.callTool({ name: "desk_save", input: { files: [{ path: "forbidden.md", content: "no\n" }], message: "no" } })
  assert.equal(result.isError, true)
  assert.equal(moved, true)
  await assert.rejects(fs.stat(path.join(r.root, "forbidden.md")), { code: "ENOENT" })
})

test("normal claimed write commits only supplied paths and preserves unrelated pending work", async t => {
  const r = await fixture(t)
  await fs.writeFile(path.join(r.root, "staged.md"), "staged\n")
  git(r.root, ["add", "staged.md"])
  await fs.writeFile(path.join(r.root, "kept.md"), "working\n")
  await fs.writeFile(path.join(r.root, "binary"), Buffer.from([0, 255, 1, 2]))
  const index = git(r.root, ["ls-files", "-s", "--", "staged.md"])
  const result = await save(r.root, { files: [{ path: "notes.md", content: "owned\n" }], message: "owned" })
  assert.equal(result.status, "committed")
  assert.equal(git(r.root, ["show", "HEAD:notes.md"]), "owned")
  assert.equal(git(r.root, ["ls-files", "-s", "--", "staged.md"]), index)
  assert.equal(git(r.root, ["diff", "--cached", "--name-only"]), "staged.md")
  assert.equal(await fs.readFile(path.join(r.root, "kept.md"), "utf8"), "working\n")
  assert.deepEqual(await fs.readFile(path.join(r.root, "binary")), Buffer.from([0, 255, 1, 2]))
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
})

test("desk_save reuses an outer owner through a nested capability without early release", async t => {
  const r = await fixture(t), resource = { ...r, worktree: r.root }
  await withWorkspaceClaim(resource, async (assertHeld, reuse) => {
    const result = await save(r.root, { files: [{ path: "nested.md", content: "nested\n" }], message: "nested" }, { writeContext: { owner: r.owner, reuse } })
    assert.equal(result.status, "committed")
    await assertHeld()
    assert.equal((await fs.readdir(path.join(r.repository, "desk-resource-claims"))).length, 2)
  })

  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
})

test("a real producer holds custody before file creation and excludes another process through readback", { timeout: 20000 }, async t => {
  const r = await fixture(t)
  await fs.writeFile(`${r.root}.input.json`, JSON.stringify({ files: [{ path: "created/note.md", content: "owner\n" }], message: "owner" }))
  const owner = start(t, "hold-save", r)
  assert.deepEqual(await owner.next(), { status: "held" })
  try {
    await assert.rejects(fs.stat(path.join(r.root, "created")), { code: "ENOENT" })
    const contender = start(t, "server", r)
    const denied = await contender.next()
    await contender.closed
    assert.equal(denied.result.isError, true)
    assert.match(JSON.parse(denied.result.content[0].text).message, /resource already claimed/u)
    await assert.rejects(fs.stat(path.join(r.root, "created")), { code: "ENOENT" })
  } finally { owner.child.send("release") }
  const response = await owner.next()
  await owner.closed
  assert.equal(response.result.status, "committed")
  assert.equal(git(r.root, ["show", "HEAD:created/note.md"]), "owner")
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
})

test("a changed claim refuses before mkdir and expires its captured capability despite release failure", async t => {
  const r = await fixture(t), resource = { ...r, worktree: r.root }
  let reuse, entered = false
  await assert.rejects(withWorkspaceClaim(resource, async (_assertHeld, capability) => {
    reuse = capability
    const files = await fs.readdir(path.join(r.repository, "desk-resource-claims"))
    await fs.writeFile(path.join(r.repository, "desk-resource-claims", files[0]), "replacement\n")
    await save(r.root, { files: [{ path: "no/note.md", content: "no\n" }], message: "no" }, {
      writeContext: { owner: r.owner, reuse, validate() { entered = true } },
    })
  }), /claim changed/u)
  assert.equal(entered, false)
  await assert.rejects(fs.stat(path.join(r.root, "no")), { code: "ENOENT" })
  await assert.rejects(withWorkspaceClaim({ ...resource, reuse }, async () => { entered = true }), /expired/u)
  assert.equal((await fs.readdir(path.join(r.repository, "desk-resource-claims"))).length, 2)
})

test("a commit-hook refusal retains supplied and unrelated bytes, releases the claim, and allows a later retry", async t => {
  const r = await fixture(t)
  const hooks = path.join(r.repository, "hooks")
  await fs.writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  await fs.writeFile(path.join(r.root, "kept.md"), "pending\n")
  const head = git(r.root, ["rev-parse", "HEAD"])
  const result = await save(r.root, { files: [{ path: "note.md", content: "retained\n" }], message: "blocked by hook" })
  assert.equal(result.commit.status, "failed")
  assert.equal(git(r.root, ["rev-parse", "HEAD"]), head)
  assert.equal(await fs.readFile(path.join(r.root, "note.md"), "utf8"), "retained\n")
  assert.equal(await fs.readFile(path.join(r.root, "kept.md"), "utf8"), "pending\n")
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
  await fs.unlink(path.join(hooks, "pre-commit"))
  assert.equal((await save(r.root, { paths: ["note.md"], message: "retry retained bytes" })).status, "committed")
})

test("claim replacement between mkdir and open cannot truncate existing bytes", async t => {
  const r = await fixture(t)
  const before = git(r.root, ["rev-parse", "HEAD"])
  const original = fs.mkdir
  let replaced = false
  fs.mkdir = async (target, options) => {
    const result = await original(target, options)
    if (target === r.root && !replaced) {
      replaced = true
      const locks = await fs.readdir(path.join(r.repository, "desk-resource-claims"))
      await fs.writeFile(path.join(r.repository, "desk-resource-claims", locks[0]), "replacement\n")
    }
    return result
  }
  try {
    await assert.rejects(save(r.root, { files: [{ path: "kept.md", content: "would truncate\n" }], message: "no" }), /claim changed/u)
  } finally { fs.mkdir = original }
  assert.equal(replaced, true)
  assert.equal(await fs.readFile(path.join(r.root, "kept.md"), "utf8"), "original\n")
  assert.equal(git(r.root, ["rev-parse", "HEAD"]), before)
})

test("retargeted desk alias refuses before writing through a different checkout", async t => {
  const first = await fixture(t), second = await fixture(t)
  const alias = path.join(first.base, "alias")
  await fs.symlink(first.root, alias, "junction")
  await assert.rejects(save(alias, { files: [{ path: "kept.md", content: "wrong owner\n" }], message: "no" }, {
    writeContext: { async validate() {
      await fs.unlink(alias)
      await fs.symlink(second.root, alias, "junction")
    } },
  }), /destination.*changed/u)
  assert.equal(await fs.readFile(path.join(first.root, "kept.md"), "utf8"), "original\n")
  assert.equal(await fs.readFile(path.join(second.root, "kept.md"), "utf8"), "original\n")
})

test("inherited Git location overrides cannot redirect a claimed commit to another repository", async t => {
  const first = await fixture(t), second = await fixture(t)
  const head = git(second.root, ["rev-parse", "HEAD"])
  const original = process.env.GIT_DIR
  process.env.GIT_DIR = second.repository
  try {
    await assert.rejects(save(first.root, { files: [{ path: "kept.md", content: "redirected\n" }], message: "no" }), /Git.*environment|GIT_DIR/u)
  } finally {
    if (original === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = original
  }
  assert.equal(git(second.root, ["rev-parse", "HEAD"]), head)
  assert.equal(await fs.readFile(path.join(first.root, "kept.md"), "utf8"), "original\n")
})

test("ordinary inherited Git configuration does not block a claimed write", async t => {
  const r = await fixture(t)
  const original = process.env.GIT_CONFIG_PARAMETERS
  process.env.GIT_CONFIG_PARAMETERS = "'core.quotePath'='true'"
  try {
    assert.equal((await save(r.root, { files: [{ path: "configured.md", content: "saved\n" }], message: "configured" })).status, "committed")
  } finally {
    if (original === undefined) delete process.env.GIT_CONFIG_PARAMETERS
    else process.env.GIT_CONFIG_PARAMETERS = original
  }
})

test("a configured worktree outside the requested source refuses before file writes", async t => {
  const first = await fixture(t), second = await fixture(t)
  git(first.root, ["config", "core.worktree", second.root])
  assert.equal(git(first.root, ["rev-parse", "--show-toplevel"]), second.root, "fixture configuration must redirect actual Git")
  await assert.rejects(save(first.root, { files: [{ path: "kept.md", content: "wrong\n" }], message: "wrong" }), /outside.*worktree/u)
  assert.equal(await fs.readFile(path.join(first.root, "kept.md"), "utf8"), "original\n")
  assert.equal(await fs.readFile(path.join(second.root, "kept.md"), "utf8"), "original\n")
})

test("an unsettled nested owner retains both claims and cannot reuse them after outer settlement", async t => {
  const r = await fixture(t), resource = { ...r, worktree: r.root }
  let release, pending
  const gate = new Promise(resolve => { release = resolve })
  await assert.rejects(withWorkspaceClaim(resource, async (_assertHeld, reuse) => {
    pending = withWorkspaceClaim({ ...resource, reuse }, async assertHeld => {
      await gate
      await assertHeld()
    })
    pending.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
  }), /unsettled nested owner/u)
  assert.equal((await fs.readdir(path.join(r.repository, "desk-resource-claims"))).length, 2)
  release()
  await assert.rejects(pending, /expired/u)
  await assert.rejects(withWorkspaceClaim(resource, async () => {}), /resource already claimed/u)
})

test("stalled Git configuration stays within the inspection budget and never writes source bytes", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const r = await fixture(t)
  const config = path.join(r.repository, "config")
  await fs.unlink(config)
  const made = spawnSync("mkfifo", [config], { encoding: "utf8" })
  assert.equal(made.status, 0, made.stderr)
  const started = Date.now()
  await assert.rejects(save(r.root, { files: [{ path: "no/note.md", content: "no\n" }], message: "no" }), /Git could not verify/u)
  assert.ok(Date.now() - started < 5000, "source inspection must not use the 15-second admission Git timeout")
  await assert.rejects(fs.stat(path.join(r.root, "no")), { code: "ENOENT" })
})

test("explicit branch restriction refuses supplied bytes before mkdir", async t => {
  const r = await fixture(t)
  await assert.rejects(save(r.root, { files: [{ path: "no/file.md", content: "no\n" }], message: "no" }, {
    writeContext: { stateBranch: "configured-other" },
  }), /branch.*match/u)
  await assert.rejects(fs.stat(path.join(r.root, "no")), { code: "ENOENT" })
  assert.deepEqual(await fs.readdir(path.join(r.repository, "desk-resource-claims")), [])
})
