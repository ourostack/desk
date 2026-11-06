import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { desk_save } from "../../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { mkTempDeskRoot } from "./_helpers.js"

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

async function fixture() {
  const root = await mkTempDeskRoot()
  git(root, "init", "-q")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  await fs.writeFile(path.join(root, "notes.md"), "before\n", { mode: 0o755 })
  git(root, "add", "--", "notes.md")
  git(root, "commit", "-qm", "seed")
  await fs.writeFile(path.join(root, "unrelated.md"), "outside staged bytes\n")
  git(root, "add", "--", "unrelated.md")
  return { root, head: git(root, "rev-parse", "HEAD"), index: git(root, "ls-files", "-s") }
}

for (const cycle of [1, 2]) {
  test(`failed staged observation is not an unchanged save (cycle ${cycle})`, async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.root, "notes.md"), "pending\n")
    git(f.root, "add", "--", "notes.md")
    const index = git(f.root, "ls-files", "-s")
    let mutations = 0
    const result = await desk_save({
      deskRoot: f.root, input: { paths: ["notes.md"], message: "save" },
      schedulePush: () => assert.fail("failed inspection must not schedule delivery"),
      spawnGit(command, args, options) {
        if (["add", "commit"].includes(args[2])) mutations++
        return args.includes("--cached")
          ? { status: 128, stdout: "", stderr: "owned staged observation failure" }
          : spawnSync(command, args, options)
      },
    })
    assert.equal(result.status, "failed")
    assert.equal(result.commit.status, "failed")
    assert.match(result.commit.reason, /staged/u)
    assert.equal(mutations, 0)
    assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
    assert.equal(git(f.root, "ls-files", "-s"), index)
    assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "pending\n")
  })

  test(`failed repository observation is not a non-Git save (cycle ${cycle})`, async () => {
    const f = await fixture()
    const result = await desk_save({
      deskRoot: f.root, input: { paths: ["notes.md"], message: "save" },
      spawnGit: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }),
      schedulePush: () => assert.fail("must not push"),
    })
    assert.equal(result.status, "failed")
    assert.match(result.commit.reason, /ETIMEDOUT|timeout/u)
    assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
    assert.equal(git(f.root, "ls-files", "-s"), f.index)
  })
}

test("a later file failure reports the completed and uncertain writes without rollback", async t => {
  const f = await fixture()
  const open = fs.open
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file === path.join(f.root, "later.md")) throw Object.assign(new Error("owned later open failure"), { code: "EIO" })
    return open(file, ...args)
  })
  await assert.rejects(desk_save({
    deskRoot: f.root,
    input: { files: [{ path: "notes.md", content: "applied\n" }, { path: "later.md", content: "later\n" }], message: "save" },
    schedulePush: () => assert.fail("must not push"),
  }), error => {
    assert.equal(error.mutation?.status, "partial")
    assert.deepEqual(error.mutation.applied_paths, ["notes.md"])
    assert.deepEqual(error.mutation.uncertain_paths, ["later.md"])
    assert.equal(error.mutation.readback_required, true)
    return true
  })
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "applied\n")
  assert.equal((await fs.stat(path.join(f.root, "notes.md"))).mode & 0o777, 0o755)
  await assert.rejects(fs.stat(path.join(f.root, "later.md")), { code: "ENOENT" })
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), f.index)
})

test("failed unstaged observation does not authorize staging or commit", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.root, "notes.md"), "pending\n")
  let mutations = 0
  const result = await desk_save({
    deskRoot: f.root, input: { paths: ["notes.md"], message: "save" },
    schedulePush: () => assert.fail("must not push"),
    spawnGit(command, args, options) {
      if (["add", "commit"].includes(args[2])) mutations++
      return args[2] === "diff" && !args.includes("--cached")
        ? { status: 128, stdout: "", stderr: "owned unstaged observation failure" }
        : spawnSync(command, args, options)
    },
  })
  assert.equal(result.status, "failed")
  assert.match(result.commit.reason, /unstaged/u)
  assert.equal(mutations, 0)
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), f.index)
})

test("failed Git inspection after successful files writes reports applied bytes separately", async () => {
  const f = await fixture()
  const result = await desk_save({
    deskRoot: f.root, input: { files: [{ path: "notes.md", content: "written\n" }], message: "save" },
    schedulePush: () => assert.fail("must not push"),
    spawnGit: () => ({ status: null, stdout: "", stderr: "owned repository observation failure" }),
  })
  assert.equal(result.status, "failed")
  assert.equal(result.effects?.status, "partial")
  assert.deepEqual(result.effects.applied_paths, ["notes.md"])
  assert.equal(result.effects.readback_required, true)
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "written\n")
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), f.index)
})

for (const phase of ["pre-commit", "post-commit"]) {
  for (const cycle of [1, 2]) test(`native ${phase} timeout requires readback before resend (cycle ${cycle})`, async t => {
    if (process.platform === "win32") return t.skip("POSIX executable hook fixture")
    const f = await fixture()
    const hook = path.join(f.root, ".git/hooks", phase)
    const pidFile = path.join(f.root, "owned-hook-pid")
    await fs.writeFile(hook, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nrequire("node:fs").closeSync(1);\nrequire("node:fs").closeSync(2);\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n`, { mode: 0o755 })
    let result, pid
    try {
      result = await desk_save({
        deskRoot: f.root, input: { files: [{ path: "notes.md", content: "after\n" }], message: "save" },
        schedulePush: () => assert.fail("unknown commit must not schedule push"),
        spawnGit: (command, args, options) => spawnSync(command, args, args[2] === "commit" ? { ...options, timeout: 6000 } : options),
      })
    } finally {
      try {
        pid = Number(await fs.readFile(pidFile, "utf8"))
        assert.ok(Number.isInteger(pid) && pid > 0)
        try { process.kill(pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
      } finally {
        await fs.unlink(hook)
      }
    }
    assert.equal(result.status, "failed")
    assert.equal(result.commit.reason, "timeout")
    assert.equal(result.commit.effects.status, "unknown")
    assert.equal(result.commit.effects.readback_required, true)
    const after = git(f.root, "rev-parse", "HEAD").trim()
    assert.equal(after === f.head.trim(), phase === "pre-commit")
    assert.equal(result.commit.effects.readback.head_before, f.head.trim())
    assert.equal(result.commit.effects.readback.head_after, after)
    t.diagnostic(JSON.stringify({ phase, cycle, result }))
    assert.equal(git(f.root, "ls-files", "-s", "--", "unrelated.md"), f.index.split("\n").find(line => line.endsWith("\tunrelated.md")) + "\n")
    assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "after\n")
    assert.equal((await fs.stat(path.join(f.root, "notes.md"))).mode & 0o777, 0o755)
    if (phase === "post-commit") {
      assert.equal(git(f.root, "show", "HEAD:notes.md"), "after\n")
      assert.equal(git(f.root, "show", "--format=", "--name-only", "HEAD"), "notes.md\n")
    }
    const recovered = await desk_save({ deskRoot: f.root, input: { paths: ["notes.md"], message: "save" }, schedulePush: () => {} })
    assert.equal(recovered.status, phase === "pre-commit" ? "committed" : "nothing_to_commit")
    assert.equal(git(f.root, "rev-list", "--count", "HEAD").trim(), "2")
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  })
}
