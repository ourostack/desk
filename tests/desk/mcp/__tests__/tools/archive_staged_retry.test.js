import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { archiveFixture, git, retry } from "./_archive_state_helpers.js"

const trackBefore = "| Slug | State | Doing doc |\n|---|---|---|\n| `mode-proof` | done | [notes](mode-proof/notes.md) |\n"
const trackAfter = "| Slug | State | Doing doc |\n|---|---|---|\n| `mode-proof` | done | [notes](_archive/mode-proof/notes.md) |\n"

async function timedOutArchive({ track = true, trackContent = trackBefore, committed = false, ...policy } = {}) {
  const f = await archiveFixture(policy)
  if (track) {
    await fs.writeFile(path.join(f.root, "t/track.md"), trackContent)
    git(f.root, "add", "--", "t/track.md")
    git(f.root, "commit", "-q", "-m", "owned track baseline")
  }
  await fs.writeFile(path.join(f.root, "unrelated.txt"), "outside staged work\n")
  git(f.root, "add", "--", "unrelated.txt")
  f.unrelated = git(f.root, "ls-files", "-s", "--", "unrelated.txt")
  f.head = git(f.root, "rev-parse", "HEAD")
  const result = await retry(f, {
    spawnGit(command, args, options) {
      if (args[2] !== "commit") return spawnSync(command, args, options)
      if (committed) {
        const answer = spawnSync(command, args, options)
        assert.equal(answer.status, 0, answer.stderr)
      }
      return { status: null, signal: "SIGTERM", stdout: "", stderr: "",
        error: Object.assign(new Error("owned commit timeout"), { code: "ETIMEDOUT" }) }
    },
  })
  if (committed) {
    // A commit that timed out after it landed is read back as committed (#561, #556): archived at once, no pending answer.
    assert.equal(result.status, "archived")
    assert.equal(result.commit, undefined)
  } else {
    assert.equal(result.status, "archive_pending")
    assert.equal(result.commit.reason, "timeout")
    assert.equal(result.publication.status, "pending")
    assert.ok(result.route_around, "an archive that is not published carries route_around")
  }
  f.index = git(f.root, "ls-files", "-s")
  return f
}

for (const cycle of [1, 2]) test(`staged archive timeout recovery publishes only its exact relocation (cycle ${cycle})`, async () => {
  const f = await timedOutArchive()
  assert.equal(git(f.root, "ls-files", "--", "t/mode-proof"), "")
  assert.equal(await fs.readFile(path.join(f.root, "t/track.md"), "utf8"), trackAfter)
  const result = await retry(f)
  assert.equal(result.status, "archived")
  assert.equal(result.commit, undefined)
  assert.notEqual(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.deepEqual(git(f.root, "show", "--format=", "--name-only", "--no-renames", "HEAD").split("\n").sort(),
    ["t/_archive/mode-proof/companion.txt", "t/_archive/mode-proof/task.md", "t/mode-proof/companion.txt", "t/mode-proof/task.md", "t/track.md"].sort())
  assert.equal(git(f.root, "ls-files", "-s", "--", "unrelated.txt"), f.unrelated)
  assert.equal(git(f.root, "diff", "--cached", "--name-only"), "unrelated.txt")
  assert.equal(git(f.root, "diff", "--name-only"), "")
  assert.equal((await retry(f)).status, "already_archived")
})

for (const [name, mutate] of [
  ["changed archive index", async f => {
    await fs.appendFile(path.join(f.destination, "companion.txt"), "\nFOREIGN\n")
    git(f.root, "add", "--", "t/_archive/mode-proof/companion.txt")
  }],
  ["unstaged archive edit", f => fs.appendFile(path.join(f.destination, "task.md"), "\nFOREIGN\n")],
  ["extra archive entry", async f => {
    await fs.writeFile(path.join(f.destination, "foreign.txt"), "FOREIGN\n")
    git(f.root, "add", "--", "t/_archive/mode-proof/foreign.txt")
  }],
  ["partial source deletion", f => git(f.root, "restore", "--staged", "--", "t/mode-proof/task.md")],
  ["outside staged track edit", async f => {
    await fs.appendFile(path.join(f.root, "t/track.md"), "\nFOREIGN\n")
    git(f.root, "add", "--", "t/track.md")
  }],
  ["outside unstaged track edit", f => fs.appendFile(path.join(f.root, "t/track.md"), "\nFOREIGN\n")],
]) test(`staged archive retry preserves ${name} without committing`, async () => {
  const f = await timedOutArchive()
  await mutate(f)
  const index = git(f.root, "ls-files", "-s")
  const status = git(f.root, "status", "--porcelain")
  const result = await retry(f)
  assert.equal(result.status, "archive_pending")
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), index)
  assert.equal(git(f.root, "status", "--porcelain"), status)
})

test("a timeout after the commit took effect is read back as archived, without a duplicate commit", async () => {
  const f = await timedOutArchive({ committed: true })
  const head = git(f.root, "rev-parse", "HEAD")
  assert.notEqual(head, f.head)
  assert.equal((await retry(f)).status, "already_archived")
  assert.equal(git(f.root, "rev-parse", "HEAD"), head)
  assert.equal(git(f.root, "ls-files", "-s", "--", "unrelated.txt"), f.unrelated)
})

// R5 (0972 on #625): a commit Desk cannot classify stays unknown in every field and word of the answer; it is never reported as a
// commit that failed or a publication that is merely pending. Here the archive's commit lands, then another commit changes the track
// before the read-back, so the archive happened but is not what HEAD holds now (R4).
test("an archive commit that landed but HEAD no longer holds is unknown in the commit and the publication, never failed or pending", async () => {
  const f = await archiveFixture()
  await fs.writeFile(path.join(f.root, "t/track.md"), trackBefore)
  git(f.root, "add", "--", "t/track.md")
  git(f.root, "commit", "-q", "-m", "owned track baseline")
  const result = await retry(f, {
    spawnGit(command, args, options) {
      if (args[2] !== "commit") return spawnSync(command, args, options)
      const answer = spawnSync(command, args, options)
      assert.equal(answer.status, 0, answer.stderr)
      const other = spawnSync("git", ["-C", f.root, "rm", "-q", "--cached", "--", "t/track.md"], { encoding: "utf8" })
      assert.equal(other.status, 0, other.stderr)
      const theirs = spawnSync("git", ["-C", f.root, "commit", "-q", "-m", "someone else"], { encoding: "utf8" })
      assert.equal(theirs.status, 0, theirs.stderr)
      return { status: null, signal: "SIGTERM", stdout: "", stderr: "",
        error: Object.assign(new Error("owned commit timeout"), { code: "ETIMEDOUT" }) }
    },
  })
  assert.equal(result.status, "archive_pending")
  assert.equal(result.commit.status, "unknown")
  assert.equal(result.publication.status, "unknown")
  assert.ok(result.commit.landed?.commit, "the answer says the archive's commit happened, separately from what HEAD holds now")
  assert.ok(result.route_around, "an unknown archive carries route_around")
  assert.doesNotMatch(JSON.stringify(result.route_around.summary), /did not land/u)
})

test("staged retry without a track card publishes the relocation", async () => {
  const f = await timedOutArchive({ track: false })
  assert.equal((await retry(f)).status, "archived")
  assert.equal(git(f.root, "diff", "--cached", "--name-only"), "unrelated.txt")
})

test("staged retry leaves a track with no archive links unchanged", async () => {
  const trackContent = "| Slug | State |\n|---|---|\n| `mode-proof` | done |\n"
  const f = await timedOutArchive({ trackContent })
  assert.equal((await retry(f)).status, "archived")
  assert.equal(await fs.readFile(path.join(f.root, "t/track.md"), "utf8"), trackContent)
  assert.equal(git(f.root, "show", "--format=", "--name-only", "HEAD").includes("t/track.md"), false)
  assert.equal(git(f.root, "diff", "--cached", "--name-only"), "unrelated.txt")
})

test("an archive already occupied in HEAD cannot be adopted as a staged retry", async () => {
  const f = await timedOutArchive({ track: false })
  git(f.root, "commit", "-q", "-m", "owned occupied destination", "--", "t/_archive/mode-proof/companion.txt")
  const head = git(f.root, "rev-parse", "HEAD"), index = git(f.root, "ls-files", "-s")
  assert.equal((await retry(f)).status, "archive_pending")
  assert.equal(git(f.root, "rev-parse", "HEAD"), head)
  assert.equal(git(f.root, "ls-files", "-s"), index)
})

for (const policy of [
  { filemode: false, mode: "100755" },
  { symlinks: false, mode: "120000" },
]) test(`staged recovery preserves Git companion metadata ${JSON.stringify(policy)}`, async () => {
  const f = await timedOutArchive({ track: false, ...policy })
  assert.equal((await retry(f)).status, "archived")
  assert.match(git(f.root, "ls-tree", "HEAD", "t/_archive/mode-proof/companion.txt"),
    new RegExp(`^${policy.mode} blob ${f.sha}\\t`))
})

test("staged recovery refuses an outside executable-mode change to the track", async t => {
  if (process.platform === "win32") return t.skip("POSIX executable bit fixture")
  const f = await timedOutArchive()
  await fs.chmod(path.join(f.root, "t/track.md"), 0o755)
  const index = git(f.root, "ls-files", "-s")
  assert.equal((await retry(f)).status, "archive_pending")
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), index)
  assert.equal((await fs.stat(path.join(f.root, "t/track.md"))).mode & 0o777, 0o755)
})

for (const target of ["t/_archive/mode-proof/companion.txt", "t/track.md"])
  test(`staged recovery preserves late index edits to ${target}`, async () => {
    const f = await timedOutArchive()
    let injected = false, index
    await assert.rejects(retry(f, {
      search: {
        noteChange(changed) {
          if (changed !== "t/_archive/mode-proof" || injected) return
          const sha = git(f.root, "hash-object", "unrelated.txt")
          git(f.root, "update-index", "--cacheinfo", `100644,${sha},${target}`)
          index = git(f.root, "ls-files", "-s")
          injected = true
        },
      },
    }), /index changed after preflight/u)
    assert.equal(injected, true)
    assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
    assert.equal(git(f.root, "ls-files", "-s"), index)
  })

test("staged recovery preserves a track index edit between qualification reads", async () => {
  const f = await timedOutArchive()
  let reads = 0, index
  const result = await retry(f, {
    spawnGit(command, args, options) {
      if (args[2] === "ls-files" && args.includes("-s") && args.at(-1) === "t/track.md" && ++reads === 2) {
        const sha = git(f.root, "hash-object", "unrelated.txt")
        git(f.root, "update-index", "--cacheinfo", `100644,${sha},t/track.md`)
        index = git(f.root, "ls-files", "-s")
      }
      return spawnSync(command, args, options)
    },
  })
  assert.ok(index, "outside stage edit must land between the track's qualification reads")
  assert.equal(result.status, "archive_pending")
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head)
  assert.equal(git(f.root, "ls-files", "-s"), index)
})

for (const phase of ["pre-commit", "post-commit"]) test(`native ${phase} timeout retains its actual commit effect for retry`, async t => {
  if (process.platform === "win32") return t.skip("POSIX executable hook fixture; Windows recovery uses the portable cases above")
  const f = await archiveFixture()
  const hook = path.join(f.root, ".git", "hooks", phase)
  const entered = path.join(f.root, "owned-hook-pid")
  const trace = path.join(f.root, "owned-commit-trace.jsonl")
  await fs.writeFile(hook, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`, { mode: 0o755 })
  let result, hookPid
  try {
    result = await retry(f, {
      spawnGit(command, args, options) {
        return spawnSync(command, args, args[2] === "commit"
          ? { ...options, timeout: 1500, env: { ...options.env, GIT_TRACE2_EVENT: trace } } : options)
      },
    })
  } finally {
    try {
      hookPid = Number(await fs.readFile(entered, "utf8"))
      assert.ok(Number.isInteger(hookPid) && hookPid > 0)
      try { process.kill(hookPid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
    } catch (error) { if (error.code !== "ENOENT") throw error }
    await fs.unlink(hook)
  }
  // The post-commit hook runs after the commit landed, so the read-back finds it committed (#561, #556); a pre-commit timeout left nothing.
  assert.equal(result.status, phase === "pre-commit" ? "archive_pending" : "archived")
  if (phase === "pre-commit") assert.equal(result.commit.reason, "timeout")
  else assert.equal(result.commit, undefined)
  const events = (await fs.readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.ok(events.some(event => event.event === "child_start" && event.hook_name === phase),
    "native trace must identify the hook phase reached before timeout")
  const head = git(f.root, "rev-parse", "HEAD")
  assert.equal(head === f.head, phase === "pre-commit")
  const statusStarted = performance.now()
  git(f.root, "status", "--porcelain")
  t.diagnostic(`Synthetic ${phase} timeout: HEAD ${head === f.head ? "unchanged" : "advanced"}; status completed in ${Math.round(performance.now() - statusStarted)} ms. This does not identify issue #556's timeout cause.`)
  assert.equal((await retry(f)).status, phase === "pre-commit" ? "archived" : "already_archived")
  assert.equal(git(f.root, "status", "--porcelain"), "?? owned-commit-trace.jsonl\n?? owned-hook-pid")
  let absent = false
  try { process.kill(hookPid, 0) } catch (error) {
    if (error.code !== "ESRCH") throw error
    absent = true
  }
  if (!absent && process.platform === "linux") {
    // Git's killed parent cannot reap the hook; Linux may retain its terminated zombie.
    let stat
    try { stat = await fs.readFile(`/proc/${hookPid}/stat`, "utf8") } catch (error) {
      if (error.code !== "ENOENT") throw error
      assert.throws(() => process.kill(hookPid, 0), { code: "ESRCH" },
        "missing procfs cannot establish owned hook termination")
      absent = true
    }
    if (!absent) {
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
      assert.equal(state, "Z", `owned hook ${hookPid} must be terminated, not runnable: ${stat}`)
      t.diagnostic(`Owned hook ${hookPid} is terminated but unreaped (Linux state Z); PID absence is not established.`)
    }
  } else {
    assert.ok(absent, "owned hook process must retire before fixture cleanup")
  }
})

// R3 (0972 on #625): the archive's admitted entries travel with its route, with their modes. With core.symlinks=false a link is
// a placeholder file holding its target; a route that committed the path from disk would make it a regular file (100644).
const runArgv = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: "utf8" })
const companion = "t/_archive/mode-proof/companion.txt"

test("an archive commit that timed out before landing is finished by its route with the admitted link entry, once", async () => {
  const f = await archiveFixture({ symlinks: false, mode: "120000" })
  const result = await retry(f, { spawnGit(command, args, options) {
    if (args[2] === "commit") return { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }
    return spawnSync(command, args, options)
  } })
  assert.equal(result.status, "archive_pending")
  const [check, finish] = result.route_around.steps.map((step) => step.argv)
  assert.ok(check.includes(`120000 ${f.sha}\t${companion}`), "the route carries the admitted link entry")
  assert.equal(runArgv(check).status, 3, "ready")
  const done = runArgv(finish)
  assert.equal(done.status, 0, done.stdout)
  assert.match(git(f.root, "ls-tree", "HEAD", "--", companion), new RegExp(`^120000 blob ${f.sha}\\t`), "a link kept a link")
  assert.equal(git(f.root, "rev-parse", "HEAD~1"), f.head, "exactly one commit")
  assert.equal(git(f.root, "diff", "--cached", "--name-only"), "", "the shared index agrees with HEAD")
  assert.equal(runArgv(check).status, 0, "read back: committed")
})

test("an archive whose link metadata could not be staged carries the admitted entries in a route that is held and changes nothing", async () => {
  const f = await archiveFixture({ symlinks: false, mode: "120000" })
  const result = await retry(f, { spawnGit(command, args, options) {
    if (args[2] === "update-index" && args.includes("--index-info") && !options?.env?.GIT_INDEX_FILE) return { status: 1, stdout: "", stderr: "update-index failed" }
    return spawnSync(command, args, options)
  } })
  assert.equal(result.status, "archive_pending")
  const route = result.route_around
  const check = route.steps[0].argv
  assert.ok(String(check[1]).endsWith("finish-commit.js") && !check.includes("--commit"), "step 1 reads where the admitted change stands")
  assert.ok(check.includes(`120000 ${f.sha}\t${companion}`), "the route carries the admitted link entry, never the placeholder's 100644")
  assert.equal(route.steps.some((step) => step.tool === "desk_save"), false, "never a save of what disk holds")
  const head = git(f.root, "rev-parse", "HEAD"), index = git(f.root, "ls-files", "-s"), status = git(f.root, "status", "--porcelain")
  const read = runArgv(check)
  assert.equal(read.status, 4, `held while the shared index holds the placeholder: ${read.stdout}`)
  assert.equal(runArgv([...check, "--commit"]).status, 4, "held with --commit too: nothing is committed")
  assert.deepEqual([git(f.root, "rev-parse", "HEAD"), git(f.root, "ls-files", "-s"), git(f.root, "status", "--porcelain")], [head, index, status])
})

test("an archive whose metadata could not be staged, on a checkout Git no longer puts on a branch, carries no capture: its route only reads", async () => {
  const f = await archiveFixture({ symlinks: false, mode: "120000" })
  let failed = false
  const result = await retry(f, { spawnGit(command, args, options) {
    if (args[2] === "update-index" && args.includes("--index-info") && !options?.env?.GIT_INDEX_FILE) {
      failed = true
      return { status: 1, stdout: "", stderr: "update-index failed" }
    }
    if (failed && args[2] === "symbolic-ref") return { status: 1, stdout: "", stderr: "" }
    return spawnSync(command, args, options)
  } })
  assert.equal(result.status, "archive_pending")
  const route = result.route_around
  assert.equal(route.held, true, "no capture, so the route is held")
  assert.deepEqual(route.steps[0].argv.map((argv) => argv.slice(3, 5)), [["diff", "HEAD"], ["log", "-1"]], "it reads the paths and stops")
  assert.equal(JSON.stringify(route).includes("finish-commit"), false, "no finish step without a capture")
})
