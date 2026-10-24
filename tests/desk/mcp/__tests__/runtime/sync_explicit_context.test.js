import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import {
  hasRemoteConfigured, aheadBehindCounts, hasRemoteConfiguredAsync, aheadBehindCountsAsync, stashCount, runPushWorker, finalUnpushedCheck,
} from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

async function fixture() {
  const base = await mkTempRoot("sync-explicit-")
  const root = path.join(base, "desk")
  const outside = path.join(base, "outside")
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(root, "escape"), "junction")
  return { base, root, outside }
}

async function ambient(privateMode, root, run) {
  const saved = { DESK: process.env.DESK, DESK_ISOLATED_HOSTED: process.env.DESK_ISOLATED_HOSTED, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND }
  try {
    process.env.DESK = root
    if (privateMode) process.env.DESK_ISOLATED_HOSTED = "1"
    else delete process.env.DESK_ISOLATED_HOSTED
    process.env.GIT_SSH_COMMAND = "ambient-ssh"
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

for (const privateMode of [true, false]) {
  test(`explicit ${privateMode ? "private" : "legacy"} sync env, not opposite ambient env, governs every Git child`, async () => {
    const { base, root, outside } = await fixture()
    const env = { ...process.env, DESK: root, XDG_STATE_HOME: path.join(base, "state"), GIT_SSH_COMMAND: "supplied-ssh", SUPPLIED_SYNC_CONTEXT: "yes" }
    if (privateMode) env.DESK_ISOLATED_HOSTED = "1"
    else delete env.DESK_ISOLATED_HOSTED
    await ambient(!privateMode, outside, async () => {
      let ahead = 1
      const calls = []
      const spawnGit = (command, args, options) => {
        calls.push(args)
        assert.equal(command, "git")
        assert.equal(options.env.SUPPLIED_SYNC_CONTEXT, "yes")
        assert.equal(options.env.DESK_ISOLATED_HOSTED, env.DESK_ISOLATED_HOSTED)
        assert.equal(options.env.GIT_TERMINAL_PROMPT, "0")
        assert.equal(options.env.GIT_SSH_COMMAND, "supplied-ssh -o BatchMode=yes")
        assert.equal(options.cwd, privateMode ? root : undefined)
        if (privateMode) assert.ok(!args.includes("-C") && !args.includes(root))
        else assert.deepEqual(args.slice(0, 2), ["-C", root])
        const subcommand = args[privateMode ? 0 : 2]
        if (subcommand === "push") ahead = 0
        const stdout = subcommand === "remote" ? "origin\n" : subcommand === "rev-list" ? `0 ${ahead}\n` : ""
        return { status: 0, stdout, stderr: "" }
      }
      assert.equal(hasRemoteConfigured(root, spawnGit, env), true)
      assert.deepEqual(aheadBehindCounts({ root, spawnGit, env }), { ahead: 1, behind: 0 })
      assert.equal(stashCount(root, spawnGit, env), 0)
      assert.equal((await syncWorkspace({ root, env, spawnGit })).state, "synced")
      assert.equal((await runPushWorker({ root, env, spawnGit, debounceMs: 0, clock: { sleep: async () => {} } })).result, "ok")
      assert.equal(finalUnpushedCheck({ root, env, spawnGit }).state, "clean")
      assert.ok(calls.some((args) => args.includes("pull")))
      assert.ok(calls.some((args) => args.includes("push")))
    })
  })
}

test("explicit private sync roots refuse outside and symlink escapes before any spawn with unmarked ambient", async () => {
  const { base, root, outside } = await fixture()
  const env = { ...process.env, DESK: root, DESK_ISOLATED_HOSTED: "1", XDG_STATE_HOME: path.join(base, "state") }
  const spawnGit = () => assert.fail("refused root reached the Git spawn seam")
  const refusal = (error) => {
    assert.equal(error.code, "DESK_GIT_CONTEXT_REFUSED")
    assert.ok(!error.message.includes(base))
    return true
  }
  await ambient(false, outside, async () => {
    for (const target of [outside, path.join(root, "escape")]) {
      assert.throws(() => hasRemoteConfigured(target, spawnGit, env), refusal)
      assert.throws(() => aheadBehindCounts({ root: target, spawnGit, env }), refusal)
      await assert.rejects(syncWorkspace({ root: target, env, spawnGit }), refusal)
      await assert.rejects(runPushWorker({ root: target, env, spawnGit, debounceMs: 0 }), refusal)
    }
  })

})

test("async remote/ahead consumers send explicit context into actual Git children, independently of ambient mode", async () => {
    const { base, root, outside } = await fixture()
    for (const args of [["init", "-q"], ["remote", "add", "origin", "https://synthetic.invalid/desk"]]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
    }
    for (const privateMode of [true, false]) {
      const trace = path.join(base, `git-trace-${privateMode}.jsonl`)
      const env = { ...process.env, DESK: root, SUPPLIED_SYNC_CONTEXT: "actual-child", GIT_TRACE2_EVENT: trace, GIT_TRACE2_ENV_VARS: "DESK_ISOLATED_HOSTED,SUPPLIED_SYNC_CONTEXT" }
      if (privateMode) env.DESK_ISOLATED_HOSTED = "1"
      else delete env.DESK_ISOLATED_HOSTED
      await ambient(!privateMode, outside, async () => {
        assert.equal(await hasRemoteConfiguredAsync(root, { env }), true)
        assert.equal(await aheadBehindCountsAsync({ root, env }), null)
      })
      const events = (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse)
      const starts = events.filter((event) => event.event === "start")
      assert.equal(starts.length, 2)
      for (const event of starts) {
        assert.equal(event.argv.includes("-C"), !privateMode)
        assert.equal(event.argv.includes(root), !privateMode)
      }
      assert.ok(events.some((event) => event.param === "SUPPLIED_SYNC_CONTEXT" && event.value === "actual-child"))
      assert.equal(events.some((event) => event.param === "DESK_ISOLATED_HOSTED" && event.value === "1"), privateMode)
    }
})
