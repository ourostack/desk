import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { fork, spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { deliver } from "../../../../../plugins/desk/mcp/src/runtime/deliver.js"
import { runPushWorker, readSyncStatus, updateSyncStatus, deskPushNote } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { syncSummary } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { syncWorkspace } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { syncDegradation } from "../../../../../plugins/desk/mcp/src/runtime/health.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}
async function fixture({ card = false, remoteChange = true } = {}) {
  const base = await mkTempRoot("desk-delivery-residual-")
  console.log(`owned delivery fixture created: ${base}`)
  const space = await fs.statfs(base)
  assert.ok(space.bavail * space.bsize > 2 * 1024 ** 3, "allocation paused below the shared-disk reserve")
  const seed = path.join(base, "seed"), root = path.join(base, "source"), peer = path.join(base, "peer"), origin = path.join(base, "origin.git")
  await fs.mkdir(seed)
  git(seed, ["init", "-q", "-b", "main"])
  git(seed, ["config", "user.name", "Test"]); git(seed, ["config", "user.email", "test@example.invalid"])
  await fs.writeFile(path.join(seed, "base.md"), card ? "---\nstatus: processing\nupdated: 2026-01-01\n---\n\nbase\n" : "base\n")
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"])
  git(seed, ["clone", "-q", "--bare", seed, origin])
  git(seed, ["clone", "-q", origin, root]); git(seed, ["clone", "-q", origin, peer])
  for (const checkout of [root, peer]) {
    git(checkout, ["config", "user.name", "Test"]); git(checkout, ["config", "user.email", "test@example.invalid"])
  }
  await fs.writeFile(path.join(root, "local.md"), "local\n")
  git(root, ["add", "."]); git(root, ["commit", "-qm", "local"])
  if (remoteChange) {
    await fs.writeFile(path.join(peer, "collision.md"), "incoming\n")
    git(peer, ["add", "."]); git(peer, ["commit", "-qm", "incoming"])
    git(peer, ["push", "-q", "origin", "main"])
  }
  return { base, seed, root, peer, origin, local: git(root, ["rev-parse", "HEAD"]), remote: git(peer, ["rev-parse", "HEAD"]),
    remoteTip: target => git(base, ["--git-dir", target ?? origin, "rev-parse", "main"]) }
}
function rawWriter(file, bytes) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(bytes)})`], { encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
  console.log(`owned delivery writer closed: ${child.pid}; file: ${file}; code: ${child.status}`)
}

async function httpFixture(t, f, mode = "") {
  const global = path.join(f.base, "empty-global")
  await fs.writeFile(global, "")
  const env = { PATH: "/usr/bin:/bin", HOME: f.base, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
  const server = fork(new URL("./_delivery_http.mjs", import.meta.url), [f.base, mode], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
  console.log(`owned delivery HTTP server created: ${server.pid}; root: ${f.base}`)
  const events = []
  server.stdout.resume(); server.stderr.resume()
  server.on("message", message => {
    events.push(message)
    if (message.type === "backend") console.log(`owned delivery HTTP backend created: ${message.pid}; root: ${f.base}`)
    if (message.type === "backend_closed") console.log(`owned delivery HTTP backend closed: ${message.pid}; code: ${message.code}; signal: ${message.signal}; root: ${f.base}`)
    if (message.type === "accepted_then_dropped") console.log(`owned delivery accepted before response drop: ${JSON.stringify(message)}; root: ${f.base}`)
  })
  const closed = new Promise(resolve => server.on("close", code => resolve(code)))
  t.after(async () => {
    if (server.connected) server.send("stop")
    assert.equal(await closed, 0)
    console.log(`owned delivery HTTP server closed: ${server.pid}; code: 0; root: ${f.base}`)
    assert.deepEqual(events.filter(event => event.type === "backend_closed").map(event => event.pid).sort(),
      events.filter(event => event.type === "backend").map(event => event.pid).sort())
  })
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned HTTP server did not start")), 5000)
    server.on("message", message => { if (message.type === "ready") { clearTimeout(timer); resolve(message.endpoint) } })
  })
  return { server, env, events, endpoint }
}

async function withHttpGit(env, run) {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_/u.test(key)))
  const oldPath = process.env.PATH, oldHome = process.env.HOME
  for (const key of Object.keys(saved)) delete process.env[key]
  Object.assign(process.env, env, { PATH: `/usr/bin:/bin:${oldPath}` })
  try { return await run() } finally {
    for (const key of Object.keys(process.env)) if (/^GIT_/u.test(key)) delete process.env[key]
    Object.assign(process.env, saved)
    process.env.PATH = oldPath
    process.env.HOME = oldHome
  }
}

test("delivery preserves a writer arriving after an identical-untracked hash", async () => {
  const f = await fixture(), file = path.join(f.root, "collision.md")
  await fs.writeFile(file, "incoming\n")
  const index = await fs.readFile(path.join(f.root, ".git/index"))
  let pushed = false, wrote = false
  const result = deliver({ root: f.root, spawnGit(command, args, options) {
    const answer = spawnSync(command, args, options)
    if (args.includes("push") && answer.status === 0) pushed = true
    if (pushed && !wrote && (args.includes("hash-object") && args.at(-1) === file || args.includes("ls-remote"))) {
      rawWriter(file, "new bytes after the hash\n")
      wrote = true
    }
    return answer
  } })
  assert.equal(wrote, true)
  assert.equal(result.state, "delivered")
  assert.equal(await fs.readFile(file, "utf8"), "new bytes after the hash\n")
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index)
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), f.local)
  assert.deepEqual(result.checkout, { state: "behind", reason: "source_follow_deferred" })
  assert.match(git(f.base, ["--git-dir", f.origin, "show", "main:local.md"]), /local/u)
})

test("delivery cannot advance another branch switched to the same original tip", async () => {
  const f = await fixture()
  let pushed = false, switched = false
  const result = deliver({ root: f.root, spawnGit(command, args, options) {
    if (!switched && pushed && (args.includes("desk: catch up with delivered commits") || args.includes("ls-remote"))) {
      git(f.root, ["switch", "-qc", "external"])
      switched = true
    }
    const answer = spawnSync(command, args, options)
    if (args.includes("push") && answer.status === 0) pushed = true
    return answer
  } })
  assert.equal(switched, true)
  assert.equal(git(f.root, ["rev-parse", "main"]), f.local)
  assert.equal(git(f.root, ["rev-parse", "external"]), f.local)
  assert.notEqual(result.checkout?.state, "caught_up")
  assert.equal(result.contextChanged, true)
})

test("mutable origin cannot redirect a push or mark the new origin delivered", async () => {
  const f = await fixture(), alternate = path.join(f.base, "alternate.git")
  git(f.base, ["clone", "-q", "--bare", f.origin, alternate])
  const tracking = git(f.root, ["rev-parse", "origin/main"])
  let changed = false
  const result = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
    if (!changed && args.includes("push")) {
      git(f.root, ["remote", "set-url", "origin", alternate])
      changed = true
    }
    return spawnSync(command, args, options)
  } })
  assert.equal(changed, true)
  assert.equal(f.remoteTip(alternate), f.remote)
  assert.notEqual(f.remoteTip(), f.remote)
  assert.equal(git(f.root, ["rev-parse", "origin/main"]), tracking)
  assert.equal(result.result, "blocked")
  assert.equal(result.reason, "delivery_context_changed")
  const status = readSyncStatus({ root: f.root })
  assert.equal(status.delivered?.includes(f.local) ?? false, false)
  assert.equal(status.last_push_at ?? null, null)
  assert.equal(status.pinnedDelivery?.tip, f.remoteTip())
})

test("delivery accepts an explicit pushurl naming the same canonical repository", async () => {
  const f = await fixture()
  git(f.root, ["config", "remote.origin.pushurl", pathToFileURL(f.origin).href])
  const result = deliver({ root: f.root })
  assert.equal(result.state, "delivered")
  assert.equal(f.remoteTip(), result.snapshot.tip)
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), f.local)
})

for (const kind of ["split-pushurl", "multiple-pushurls", "rewrite", "push-rewrite", "remote-policy", "empty-remote-proxy"]) {
  test(`delivery explicitly blocks unqualified ${kind} without changing policy or destinations`, async () => {
    const f = await fixture(), alternate = path.join(f.base, "alternate.git")
    git(f.base, ["clone", "-q", "--bare", f.origin, alternate])
    if (kind === "split-pushurl") git(f.root, ["config", "remote.origin.pushurl", alternate])
    if (kind === "multiple-pushurls") {
      git(f.root, ["config", "--add", "remote.origin.pushurl", f.origin])
      git(f.root, ["config", "--add", "remote.origin.pushurl", alternate])
    }
    if (kind === "rewrite" || kind === "push-rewrite") {
      git(f.root, ["config", `url.${f.origin}.${kind === "rewrite" ? "insteadOf" : "pushInsteadOf"}`, "fixture:"])
    }
    if (kind === "remote-policy") git(f.root, ["config", "remote.origin.receivepack", "fixture-required-policy"])
    if (kind === "empty-remote-proxy") git(f.root, ["config", "remote.origin.proxy", ""])
    const config = await fs.readFile(path.join(f.root, ".git/config"))
    const result = deliver({ root: f.root })
    assert.equal(result.state, "failed")
    assert.equal(result.reason, "unsupported_delivery_route")
    assert.equal(f.remoteTip(), f.remote)
    assert.equal(f.remoteTip(alternate), f.remote)
    assert.deepEqual(await fs.readFile(path.join(f.root, ".git/config")), config)
  })
}

test("captured destination survives origin mutation at fetch without updating its tracking alias", async () => {
  const f = await fixture(), alternate = path.join(f.base, "alternate.git")
  git(f.base, ["clone", "-q", "--bare", f.origin, alternate])
  const tracking = git(f.root, ["rev-parse", "origin/main"])
  let changed = false
  const result = deliver({ root: f.root, spawnGit(command, args, options) {
    if (!changed && args.includes("fetch")) {
      git(f.root, ["remote", "set-url", "origin", alternate])
      changed = true
    }
    return spawnSync(command, args, options)
  } })
  assert.equal(result.reason, "delivery_context_changed")
  assert.equal(f.remoteTip(), f.remote)
  assert.equal(f.remoteTip(alternate), f.remote)
  assert.equal(git(f.root, ["rev-parse", "origin/main"]), tracking)
})

test("a commit arriving after the captured tip is not acknowledged until its own push", async () => {
  const f = await fixture({ remoteChange: false })
  let arrived = false
  const result = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
    const answer = spawnSync(command, args, options)
    if (!arrived && args.includes("fetch") && answer.status === 0) {
      writeFileSync(path.join(f.root, "late.md"), "late\n")
      git(f.root, ["add", "late.md"]); git(f.root, ["commit", "-qm", "late"])
      arrived = true
    }
    return answer
  } })
  assert.equal(arrived, true)
  assert.equal(result.result, "ok")
  assert.equal(f.remoteTip(), git(f.root, ["rev-parse", "HEAD"]))
  assert.equal(git(f.base, ["--git-dir", f.origin, "show", "main:late.md"]), "late")
})

test("an acknowledged push needs pinned-destination readback before receipt success", async () => {
  const f = await fixture()
  const result = deliver({ root: f.root, spawnGit(command, args, options) {
    if (args.includes("ls-remote")) return { status: 128, stdout: "", stderr: "owned readback unavailable\n" }
    return spawnSync(command, args, options)
  } })
  assert.equal(result.state, "failed")
  assert.equal(result.reason, "push_outcome_unverified")
  assert.notEqual(f.remoteTip(), f.remote)
  assert.equal(result.pinnedDelivery?.tip, f.remoteTip())
  assert.equal(result.pinnedDelivery?.confirmed, false)
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), f.local)
})

for (const [kind, status, stderr] of [["authentication", 128, "Authentication failed during readback"], ["timeout", null, "owned readback deadline"]]) {
  test(`a post-push ${kind} readback failure remains an unknown delivery outcome`, async () => {
    const f = await fixture()
    const result = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
      if (args.includes("ls-remote")) return { status, stdout: "", stderr }
      return spawnSync(command, args, options)
    } })
    assert.equal(result.reason, "push_outcome_unverified")
    assert.notEqual(f.remoteTip(), f.remote)
    const recorded = readSyncStatus({ root: f.root })
    assert.equal(recorded.pinnedDelivery?.tip, f.remoteTip())
    assert.equal(recorded.pinnedDelivery?.confirmed, false)
    const note = deskPushNote({ root: f.root }).desk_note
    assert.doesNotMatch(note, /only on this machine/u)
    assert.match(note, /not verified/u)
  })
}

test("credential-provider environment changes invalidate the current delivery context", async () => {
  const f = await fixture(), saved = process.env.GH_TOKEN
  process.env.GH_TOKEN = "fixture-account-before"
  let changed = false, result
  try {
    result = deliver({ root: f.root, spawnGit(command, args, options) {
      if (!changed && args.includes("push")) { process.env.GH_TOKEN = "fixture-account-after"; changed = true }
      return spawnSync(command, args, options)
    } })
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved
  }
  assert.equal(changed, true)
  assert.equal(result.contextChanged, true)
  assert.equal(result.reason, "delivery_context_changed")
  assert.equal(JSON.stringify(result).includes("fixture-account"), false)
})

test("private delivery blocks an unqualified named-remote pre-push guard without bypassing policy", async () => {
  const f = await fixture(), marker = path.join(f.base, "pre-push-ran")
  const hooks = path.join(f.base, "policy-hooks"), hook = path.join(hooks, "pre-push")
  await fs.mkdir(hooks)
  git(f.root, ["config", "core.hooksPath", hooks])
  await fs.writeFile(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\nif [ "$1" = origin ]; then exit 1; fi\nexit 0\n`, { mode: 0o700 })
  git(f.root, ["config", "credential.useHttpPath", "true"])
  const config = await fs.readFile(path.join(f.root, ".git/config"))
  let network = false
  const result = deliver({ root: f.root, spawnGit(command, args, options) {
    if (args.some(arg => ["fetch", "push", "ls-remote"].includes(arg))) network = true
    return spawnSync(command, args, options)
  } })
  assert.equal(result.state, "failed")
  assert.equal(result.reason, "unsupported_delivery_route")
  assert.match(result.error, /pre-push hook/u)
  assert.equal(network, false)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.equal(f.remoteTip(), f.remote)
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/config")), config)
})

for (const kind of ["absent", "nonexecutable"]) {
  test(`a configured hooks directory with ${kind} pre-push policy does not block delivery`, { skip: kind === "nonexecutable" && process.platform === "win32" }, async () => {
    const f = await fixture(), hooks = path.join(f.base, "policy-hooks"), marker = path.join(f.base, "must-not-run")
    await fs.mkdir(hooks)
    git(f.root, ["config", "core.hooksPath", hooks])
    if (kind === "nonexecutable") await fs.writeFile(path.join(hooks, "pre-push"), `#!/bin/sh\nprintf ran >> '${marker}'\nexit 1\n`, { mode: 0o600 })
    const config = await fs.readFile(path.join(f.root, ".git/config"))
    const result = deliver({ root: f.root })
    assert.equal(result.state, "delivered")
    assert.equal(f.remoteTip(), result.snapshot.tip)
    await assert.rejects(fs.stat(marker), { code: "ENOENT" })
    assert.deepEqual(await fs.readFile(path.join(f.root, ".git/config")), config)
  })
}

for (const status of [null, 128]) test(`a lost successful-push reply at status ${status} does not duplicate its commit when inspected again`, async () => {
  const f = await fixture({ card: true })
  const local = "---\nstatus: done\nupdated: 2026-10-30\n---\n\nbase\nlocal progress\n"
  await fs.writeFile(path.join(f.root, "base.md"), local)
  git(f.root, ["add", "base.md"]); git(f.root, ["commit", "-qm", "local card"])
  await fs.writeFile(path.join(f.peer, "base.md"), "---\nstatus: cancelled\nupdated: 2026-10-29\n---\n\nbase\nremote progress\n")
  git(f.peer, ["add", "base.md"]); git(f.peer, ["commit", "-qm", "remote card"]); git(f.peer, ["push", "-q", "origin", "main"])
  const localHead = git(f.root, ["rev-parse", "HEAD"])
  await fs.writeFile(path.join(f.root, "pending.md"), "staged\n")
  git(f.root, ["add", "pending.md"])
  await fs.writeFile(path.join(f.root, "pending.md"), "working after staged\n")
  await fs.writeFile(path.join(f.root, "intent.md"), "intent\n")
  git(f.root, ["add", "-N", "intent.md"])
  git(f.root, ["update-index", "--skip-worktree", "base.md"])
  git(f.root, ["update-index", "--assume-unchanged", "local.md"])
  const index = await fs.readFile(path.join(f.root, ".git/index"))
  let lost = false
  const first = deliver({ root: f.root, spawnGit(command, args, options) {
    const answer = spawnSync(command, args, options)
    if (!lost && args.includes("push") && answer.status === 0) {
      lost = true
      return { status, stdout: answer.stdout, stderr: status === null ? "owned lost reply\n" : "fatal: connection reset by peer\n",
        ...(status === null ? { signal: "SIGTERM", error: { code: "ETIMEDOUT" } } : {}) }
    }
    return answer
  } })
  assert.equal(first.state, "failed")
  assert.equal(first.reason, "push_outcome_unverified")
  const accepted = f.remoteTip()
  assert.equal(first.pinnedDelivery?.tip, accepted)
  assert.equal(first.pinnedDelivery?.confirmed, false)
  const again = deliver({ root: f.root })
  assert.notEqual(again.state, "failed")
  assert.equal(f.remoteTip(), accepted)
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), localHead)
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index)
  assert.equal(await fs.readFile(path.join(f.root, "pending.md"), "utf8"), "working after staged\n")
  assert.equal(await fs.readFile(path.join(f.root, "base.md"), "utf8"), local)
  const remoteCard = git(f.base, ["--git-dir", f.origin, "show", "main:base.md"])
  assert.equal((remoteCard.match(/local progress/gu) ?? []).length, 1)
  assert.match(remoteCard, /remote progress/u)
})

test("a previous target's scoped receipt cannot approve stale tracking data for a new target", async () => {
  const f = await fixture({ remoteChange: false }), alternate = path.join(f.base, "alternate.git")
  git(f.base, ["clone", "-q", "--bare", f.origin, alternate])
  assert.equal((await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {} })).result, "ok")
  git(f.root, ["update-ref", "refs/remotes/origin/main", f.local])
  git(f.root, ["remote", "set-url", "origin", alternate])
  let network = false
  const result = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
    if (args.some(arg => ["fetch", "push", "ls-remote"].includes(arg))) network = true
    return spawnSync(command, args, options)
  } })
  assert.equal(result.result, "blocked")
  assert.equal(result.reason, "delivery_ledger_unverified")
  assert.equal(network, false)
  assert.equal(f.remoteTip(alternate), f.remote)
  assert.match(deskPushNote({ root: f.root }).desk_note, /not verified/u)
})

test("an unscoped legacy resolved-delivery ledger cannot authorize a different target", async () => {
  const f = await fixture()
  for (const deliverySnapshot of [undefined, {}]) {
    updateSyncStatus(f.root, process.env, { delivered: [f.local], deliverySnapshot })
    let fetched = false
    const result = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
      if (args.includes("fetch") || args.includes("push")) fetched = true
      return spawnSync(command, args, options)
    } })
    assert.equal(result.reason, "delivery_ledger_unverified")
    assert.equal(fetched, false)
    assert.deepEqual(readSyncStatus({ root: f.root }).delivered, [f.local])
  }
  const words = deskPushNote({ root: f.root, note: "healthy" })
  assert.match(words.desk_note, /not verified/u)
  assert.doesNotMatch(words.desk_note, /only on this machine/u)
})

test("acknowledgement capacity refuses before fetching instead of forgetting delivered commits", async () => {
  const f = await fixture()
  const pending = Array.from({ length: 5001 }, (_, index) => (index + 1).toString(16).padStart(40, "0")).join("\n") + "\n"
  let fetched = false
  const result = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
    if (args.includes("--cherry-pick")) return { status: 0, stdout: pending, stderr: "" }
    if (args.includes("fetch")) { fetched = true; return { status: 1, stdout: "", stderr: "fixture fetch forbidden\n" } }
    return spawnSync(command, args, options)
  } })
  assert.equal(result.reason, "delivery_evidence_capacity")
  assert.equal(fetched, false)
  assert.equal(f.remoteTip(), f.remote)
})

test("a rewritten unrelated remote is not replayed as routine divergence", async () => {
  const f = await fixture()
  git(f.peer, ["switch", "--orphan", "rewritten"])
  git(f.peer, ["commit", "--allow-empty", "-qm", "unrelated generation"])
  const rewritten = git(f.peer, ["rev-parse", "HEAD"])
  git(f.peer, ["push", "-q", f.origin, `${rewritten}:refs/heads/rewritten`])
  git(f.base, ["--git-dir", f.origin, "update-ref", "refs/heads/main", rewritten, f.remote])
  const result = deliver({ root: f.root })
  assert.equal(result.reason, "source_history_changed")
  assert.equal(f.remoteTip(), rewritten)
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), f.local)
})

test("compact status distinguishes source-follow policy from remote delivery", () => {
  const result = compactStatus({ status: "ok", state: "ready", sync: {
    blocked: false, ahead: 1, behind: 0, unpushed: 0, checkout: { state: "behind", reason: "source_follow_deferred" },
  } })
  assert.match(result.sync, /source follow deferred/u)
  assert.doesNotMatch(result.sync, /not pushed/u)
})

test("an unknown pinned push is not rendered as proof the commits only exist locally", () => {
  const result = compactStatus({ status: "ok", state: "ready", sync: {
    blocked: true, reason: "push_outcome_unverified", unpushed: 1, delivery_unverified: true,
  } })
  assert.match(result.sync, /unverified/u)
  assert.doesNotMatch(JSON.stringify(result.notes), /only on this machine|not on the remote/u)
  const summary = syncSummary({ sync: { state: "synced", unpushed: { count: 1, delivering: false, reason: "push_outcome_unverified" } } })
  assert.match(summary, /not verified/u)
  assert.doesNotMatch(summary, /not on the remote|stay on this machine/u)
})

test("boot retains an unverified destination warning even when the pending list appears empty", async () => {
  const f = await fixture()
  updateSyncStatus(f.root, process.env, { blocked: true, reason: "delivery_context_changed", unpushed: null })
  const sync = await syncWorkspace({ root: f.root, env: process.env, fileProblem() {}, scheduleDelivery() { assert.fail("an unverified target must not be silently retried") }, spawnGit(command, args, options) {
    if (args.includes("pull")) return { status: 0, stdout: "", stderr: "" }
    if (args.includes("--cherry-pick")) return { status: 0, stdout: "", stderr: "" }
    return spawnSync(command, args, options)
  } })
  assert.equal(sync.unpushed?.reason, "delivery_context_changed")
  assert.notEqual(syncDegradation(sync), null)
  assert.match(syncSummary({ sync }), /not verified/u)
})

test("captured HTTP URL keeps native URL-scoped credentials at their original origin", { timeout: 20000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(), alternate = path.join(f.base, "alternate.git")
  git(f.base, ["clone", "-q", "--bare", f.origin, alternate])
  const { endpoint, env, events } = await httpFixture(t, f)
  const first = `${endpoint}/origin.git`, second = `${endpoint}/alternate.git`
  const calls = path.join(f.base, "credential-calls")
  const helper = path.join(f.base, "credential.mjs")
  await fs.writeFile(helper, `import fs from "node:fs";const data=fs.readFileSync(0,"utf8");if(process.argv[2]==="get"){const user=/username=([^\\n]+)/.exec(data)?.[1];fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({user,host:/host=([^\\n]+)/.exec(data)?.[1],path:/path=([^\\n]+)/.exec(data)?.[1]})+"\\n");process.stdout.write("username="+user+"\\npassword=test-only\\n")}`)
  git(f.root, ["remote", "set-url", "origin", first])
  git(f.root, ["config", "--add", "credential.helper", ""])
  git(f.root, ["config", "--add", "credential.helper", `!${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`])
  git(f.root, ["config", "credential.useHttpPath", "true"])
  git(f.root, ["config", `credential.${first}.username`, "fixture-a"])
  git(f.root, ["config", `credential.${second}.username`, "fixture-b"])
  let changed = false
  const result = await withHttpGit(env, () => deliver({ root: f.root, spawnGit(command, args, options) {
      if (!changed && args.includes("push")) { git(f.root, ["remote", "set-url", "origin", second]); changed = true }
      return spawnSync(command, args, options)
    } }))
  assert.equal(result.reason, "delivery_context_changed")
  // Changed credentials or routing must not authorize another network call merely to upgrade the old receipt.
  assert.equal(result.pinnedDelivery.confirmed, false)
  assert.equal(f.remoteTip(alternate), f.remote)
  assert.notEqual(f.remoteTip(), f.remote)
  const observed = (await fs.readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.ok(observed.length > 0)
  assert.ok(observed.every(entry => entry.user === "fixture-a" && entry.path === "origin.git"))
  assert.equal(events.some(event => event.type === "request" && event.destination === "alternate"), false)
  assert.equal(JSON.stringify(result).includes("test-only"), false)
})

for (const mode of ["drop-after-receive", "deny-receive-auth", "reject-all-refs"]) {
  test(`native receive-pack ${mode} preserves the correct delivery outcome`, { timeout: 20000, skip: process.platform !== "darwin" }, async t => {
    const f = await fixture()
    if (mode === "reject-all-refs") await fs.writeFile(path.join(f.origin, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    const { endpoint, env, events } = await httpFixture(t, f, mode)
    const target = `${endpoint}/origin.git`
    git(f.root, ["remote", "set-url", "origin", target])
    git(f.root, ["config", `http.${target}.extraHeader`, `Authorization: Basic ${Buffer.from("fixture-a:test-only").toString("base64")}`])
    await fs.writeFile(path.join(f.root, "pending.md"), "staged\n")
    git(f.root, ["add", "pending.md"])
    await fs.writeFile(path.join(f.root, "pending.md"), "working after staged\n")
    const index = await fs.readFile(path.join(f.root, ".git/index"))
    const pushes = [], network = []
    await withHttpGit(env, async () => {
      const first = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
        for (const step of ["fetch", "push", "ls-remote"]) if (args.includes(step)) network.push(step)
        const answer = spawnSync(command, args, options)
        if (args.includes("push")) {
          pushes.push({ status: answer.status, stderr: answer.stderr, stdout: answer.stdout })
          console.log(`owned native receive-pack push result: ${JSON.stringify(pushes.at(-1))}; root: ${f.base}`)
        }
        return answer
      } })
      assert.equal(first.result, "blocked")
      const recorded = readSyncStatus({ root: f.root })
      if (mode === "drop-after-receive") {
        assert.equal(first.reason, "push_outcome_unverified")
        assert.equal(pushes.length, 1)
        assert.ok(Number.isInteger(pushes[0].status) && pushes[0].status !== 0)
        assert.notEqual(f.remoteTip(), f.remote)
        assert.equal(recorded.pinnedDelivery?.tip, f.remoteTip())
        assert.equal(recorded.pinnedDelivery?.ref, "refs/heads/main")
        assert.ok(recorded.pinnedDelivery?.commits.includes(f.local))
        assert.equal(recorded.pinnedDelivery?.confirmed, false)
        assert.ok(git(f.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/desk/delivery/"]).split("\n")
          .some(line => line.includes("/candidate ") && line.endsWith(recorded.pinnedDelivery.tip)))
        assert.equal(recorded.deliverySnapshot ?? null, null)
        assert.equal(recorded.delivered?.includes(f.local) ?? false, false)
        assert.equal(recorded.last_push_at ?? null, null)
        assert.deepEqual(network, ["fetch", "push"])
        assert.match(deskPushNote({ root: f.root }).desk_note, /not verified/u)
        assert.doesNotMatch(deskPushNote({ root: f.root }).desk_note, /only on this machine/u)
        const accepted = f.remoteTip(), count = git(f.base, ["--git-dir", f.origin, "rev-list", "--count", "main"])
        const replayNetwork = []
        const again = await runPushWorker({ root: f.root, clock: { sleep: async () => {} }, fileProblem() {}, spawnGit(command, args, options) {
          for (const step of ["fetch", "push", "ls-remote"]) if (args.includes(step)) replayNetwork.push(step)
          return spawnSync(command, args, options)
        } })
        assert.equal(again.result, "ok")
        assert.deepEqual(replayNetwork, ["fetch"])
        assert.equal(f.remoteTip(), accepted)
        assert.equal(git(f.base, ["--git-dir", f.origin, "rev-list", "--count", "main"]), count)
      } else {
        assert.equal(first.reason, mode === "deny-receive-auth" ? "auth_failed" : "push_rejected")
        assert.equal(f.remoteTip(), f.remote)
        assert.equal(recorded.pinnedDelivery ?? null, null)
        assert.equal(pushes.length, mode === "deny-receive-auth" ? 1 : 3)
      }
      assert.equal(git(f.root, ["rev-parse", "HEAD"]), f.local)
      assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index)
      assert.equal(await fs.readFile(path.join(f.root, "pending.md"), "utf8"), "working after staged\n")
    })
    if (mode === "drop-after-receive") assert.ok(events.some(event => event.type === "accepted_then_dropped"))
  })
}
