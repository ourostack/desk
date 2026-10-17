import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { withDeskMutation } from "../../../../../plugins/desk/mcp/src/util/desk-mutation.js"
import { callTool, TOOL_IMPLS } from "../../../../../plugins/desk/mcp/src/server.js"
import { TOOL_ANNOTATIONS } from "../../../../../plugins/desk/mcp/src/runtime/hosted.js"
import { track_create, track_update } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { task_move, track_rename } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { taskSignoff } from "../../../../../plugins/desk/mcp/src/tools/task-signoff.js"
import { runPushWorker } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

test("canonical dispatch uses registry write annotations, not another tool vocabulary", async () => {
  const root = await mkTempDeskRoot()
  for (const [name, annotation] of Object.entries(TOOL_ANNOTATIONS)) {
    const original = TOOL_IMPLS[name]
    TOOL_IMPLS[name] = async () => ({ held: await exists(path.join(root, ".desk-mutation.lock")) })
    try {
      const result = await callTool({ deskRoot: root, name, input: name === "desk_doctor" ? { repair: "switch_state_branch" } : {} })
      assert.equal(JSON.parse(result.content[0].text).held, !annotation.readOnlyHint, name)
    } finally {
      TOOL_IMPLS[name] = original
    }
    assert.equal(await exists(path.join(root, ".desk-mutation.lock")), false)
  }
})

test("a direct track writer cannot enter another canonical mutation; nested calls can reenter", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "t"))
  await fs.writeFile(path.join(root, "t/track.md"), "---\ntitle: t\n---\nBody")
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  try {
    await assert.rejects(track_update({ deskRoot: root, input: { slug: "t", body_append: "foreign" } }), { code: "desk_mutation_busy" })
  } finally {
    release()
    await held
  }
  await withDeskMutation(root, () => track_update({ deskRoot: root, input: { slug: "t", body_append: "nested" } }))
  assert.match(await fs.readFile(path.join(root, "t/track.md"), "utf8"), /nested/)
  assert.doesNotMatch(await fs.readFile(path.join(root, "t/track.md"), "utf8"), /foreign/)
})

test("every intersecting direct entry point and a second process use the same desk claim, including people", async () => {
  const root = await mkTempDeskRoot()
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  try {
    for (const tool of [task_create, task_update, task_archive, task_move, track_create, track_update, track_rename, taskSignoff]) {
      await assert.rejects(tool({ deskRoot: root, person: "someone-else", input: {} }), { code: "desk_mutation_busy" })
    }
    const module = pathToFileURL(path.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/src/util/desk-mutation.js"))
    const script = `import {withDeskMutation} from ${JSON.stringify(String(module))};try{await withDeskMutation(${JSON.stringify(root)},()=>console.log("entered"))}catch(e){console.log(e.code)}`
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.trim(), "desk_mutation_busy")
  } finally {
    release()
    await held
  }
  assert.deepEqual(await fs.readdir(root), [])
})

test("normal sync cannot push or rebase while a canonical writer owns the claim", async () => {
  const root = await mkTempDeskRoot()
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  const calls = []
  const spawnGit = (_command, args) => {
    calls.push(args[2])
    if (["push", "pull"].includes(args[2])) throw new Error("canonical mutation escaped the claim")
    return { status: 0, stdout: args[2] === "remote" ? "origin\n" : args[2] === "rev-list" ? "0\t1\n" : "", stderr: "" }
  }
  try {
    const result = await runPushWorker({
      root, env: { ...process.env, XDG_STATE_HOME: path.join(root, "owned-state") },
      spawnGit, clock: { sleep: async () => {} }, debounceMs: 0, mutationWaitMs: 0,
    })
    assert.equal(result.result, "pending")
    assert.equal(result.reason, "canonical_mutation_busy")
    assert.equal(calls.includes("push"), false)
    assert.equal(calls.includes("pull"), false)
    const startup = await syncWorkspace({
      root, env: { ...process.env, XDG_STATE_HOME: path.join(root, "owned-state") },
      spawnGit, fileProblem: () => { throw new Error("busy is not a problem-filing authority") },
    })
    assert.equal(startup.state, "unresolved")
    assert.equal(startup.reason, "canonical_mutation_busy")
    assert.equal(calls.includes("pull"), false)
  } finally {
    release()
    await held
  }
})

test("unknown/stale claims are not taken over and a replaced owner token is never deleted", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(root, ".desk-mutation.lock")
  await fs.writeFile(file, "unreadable former owner")
  await assert.rejects(withDeskMutation(root, () => {}), { code: "desk_mutation_busy" })
  assert.equal(await fs.readFile(file, "utf8"), "unreadable former owner")
  const fresh = await mkTempDeskRoot()
  const replaced = path.join(fresh, ".desk-mutation.lock")
  await assert.rejects(withDeskMutation(fresh, () => fs.writeFile(replaced, "replacement owner")), /owner claim changed/)
  assert.equal(await fs.readFile(replaced, "utf8"), "replacement owner")
})

test("two bound roots inside one Git worktree cannot partition the shared Git mutation claim", async () => {
  const root = await mkTempDeskRoot()
  const initialized = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" })
  assert.equal(initialized.status, 0, initialized.stderr)
  const childRoot = path.join(root, "desks/alice")
  await fs.mkdir(childRoot, { recursive: true })
  let entered, release
  const ready = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const held = withDeskMutation(root, async () => { entered(); await wait })
  await ready
  try {
    await assert.rejects(withDeskMutation(childRoot, () => {}), { code: "desk_mutation_busy" })
  } finally {
    release()
    await held
  }
})
