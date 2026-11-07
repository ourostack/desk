import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { readSyncStatus, runPushWorker, syncStatusPath, updateSyncStatus } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"

async function fixture(t) {
  const root = await mkTempRoot("desk-sync-status-safety-")
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state") }
  const file = syncStatusPath({ root, env })
  mkdirSync(path.dirname(file), { recursive: true })
  t.diagnostic(`Owned fixture: ${root}; status: ${file}; removed by fixture teardown`)
  return { root, env, file }
}

for (const age of [0, 60_000]) {
  test(`an authoritative status lock held for ${age}ms refuses writes without replacing its owner`, async (t) => {
    const { root, env, file } = await fixture(t)
    const original = '{"last_pull":{"state":"unresolved","effects":{"pull":"unknown"}}}\n'
    writeFileSync(file, original)
    writeFileSync(`${file}.lock`, "retained owner\n")
    const at = new Date(Date.now() - age)
    utimesSync(`${file}.lock`, at, at)

    assert.ok(updateSyncStatus(root, env, { blocked: false }, file, { waitMs: 0 }) === null)
    assert.equal(readFileSync(file, "utf8"), original)
    assert.equal(readFileSync(`${file}.lock`, "utf8"), "retained owner\n")
  })
}

const deadPid = () => {
  const child = spawnSync(process.execPath, ["-e", ""], { windowsHide: true })
  assert.equal(child.status, 0)
  return child.pid
}

for (const [name, owner, age, takenOver] of [
  ["an old lock whose owner on this host has exited is taken over", () => ({ pid: deadPid(), host: os.hostname() }), 60_000, true],
  ["a fresh lock whose owner has exited is kept", () => ({ pid: deadPid(), host: os.hostname() }), 0, false],
  ["an old lock whose owner is still running is kept", () => ({ pid: process.ppid, host: os.hostname() }), 60_000, false],
  ["an old lock whose owner ran on another host is kept", () => ({ pid: deadPid(), host: `${os.hostname()}-elsewhere` }), 60_000, false],
  ["an old lock this process names as its own is kept", () => ({ pid: process.pid, host: os.hostname() }), 60_000, false],
]) {
  test(`authoritative status: ${name}`, async (t) => {
    const { root, env, file } = await fixture(t)
    const original = '{"blocked":true}\n'
    writeFileSync(file, original)
    const lock = `${JSON.stringify(owner())}\n`
    writeFileSync(`${file}.lock`, lock)
    const at = new Date(Date.now() - age)
    utimesSync(`${file}.lock`, at, at)

    const result = updateSyncStatus(root, env, { blocked: false }, file, { waitMs: takenOver ? 1000 : 0 })
    if (takenOver) {
      assert.deepEqual(result, { blocked: false })
      assert.equal(existsSync(`${file}.lock`), false, "the writer releases the lock it took over")
    } else {
      assert.equal(result, null)
      assert.equal(readFileSync(file, "utf8"), original)
      assert.equal(readFileSync(`${file}.lock`, "utf8"), lock)
    }
  })
}

for (const original of ["{torn", "null\n", "[]\n", `${JSON.stringify({ retained: "x".repeat(1_048_576) })}\n`]) {
  test(`an invalid existing authoritative record is preserved (${original.length} bytes)`, async (t) => {
    const { root, env, file } = await fixture(t)
    writeFileSync(file, original)
    assert.equal(updateSyncStatus(root, env, { blocked: false }, file, { waitMs: 0 }), null)
    assert.equal(readFileSync(file, "utf8"), original)
  })
}

test("a valid authoritative update preserves the other direction's fields", async (t) => {
  const { root, env, file } = await fixture(t)
  writeFileSync(file, '{"last_pull":{"state":"unresolved","reason":"retained"},"delivered":["commit"]}\n')
  const result = updateSyncStatus(root, env, { blocked: false }, file, { waitMs: 0 })
  assert.deepEqual(result, { last_pull: { state: "unresolved", reason: "retained" }, delivered: ["commit"], blocked: false })
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), result)
})

test("an oversized next authoritative record does not replace the readable predecessor", async (t) => {
  const { root, env, file } = await fixture(t)
  const original = '{"blocked":true}\n'
  writeFileSync(file, original)
  assert.ok(updateSyncStatus(root, env, { retained: "x".repeat(1_048_576) }, file, { waitMs: 0 }) === null)
  assert.equal(readFileSync(file, "utf8"), original)
})

test("successful native delivery preserves a newer incoming outcome recorded during push", async (t) => {
  const { root, env, file } = await fixture(t)
  const origin = path.join(root, "origin.git")
  const desk = path.join(root, "desk")
  const git = (...args) => {
    const result = spawnSync("git", args, { env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init", "--bare", "-q", origin)
  git("clone", "-q", origin, desk)
  git("-C", desk, "checkout", "-q", "-b", "main")
  git("-C", desk, "config", "user.name", "Desk Test")
  git("-C", desk, "config", "user.email", "desk-test@example.invalid")
  writeFileSync(path.join(desk, "seed.md"), "seed\n")
  git("-C", desk, "add", "seed.md")
  git("-C", desk, "commit", "-q", "-m", "seed")
  git("-C", desk, "push", "-q", "-u", "origin", "main")
  writeFileSync(path.join(desk, "outgoing.md"), "outgoing\n")
  git("-C", desk, "add", "outgoing.md")
  git("-C", desk, "commit", "-q", "-m", "outgoing")
  const expectedTip = git("-C", desk, "rev-parse", "HEAD")
  const incoming = { state: "unresolved", reason: "retained-newer-pull", effects: { pull: "unknown" } }
  let dispatched = false
  const result = await runPushWorker({
    root: desk, env, debounceMs: 0, clock: { sleep: async () => {} },
    fileProblem: () => assert.fail("ordinary native push must not file a problem"),
    spawnGit: (command, args, options) => {
      const outcome = spawnSync(command, args, options)
      if (args.includes("push")) {
        dispatched = true
        assert.equal(outcome.status, 0, outcome.stderr)
        updateSyncStatus(desk, env, { last_pull: incoming })
      }
      return outcome
    },
  })
  assert.ok(dispatched)
  assert.equal(result.result, "ok")
  assert.equal(git("--git-dir", origin, "rev-parse", "main"), expectedTip)
  assert.deepEqual(readSyncStatus({ root: desk, env }).last_pull, incoming)
  assert.equal(readSyncStatus({ root: desk, env }).blocked, false)
  assert.ok(readSyncStatus({ root: desk, env }).last_push_at)
  t.diagnostic(`Native remote: ${origin}; desk: ${desk}; unused parent status path: ${file}`)
})
