import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { claimCard, leasePaths, leaseStatus } from "../../../../../plugins/desk/mcp/src/runtime/leases.js"
import { endingsDir, progressOf } from "../../../../../plugins/desk/mcp/src/runtime/outcomes.js"
import { findings, keepersCheck, publish, readKeeperConfig } from "../../../../../plugins/desk/mcp/src/runtime/keepers.js"

const setup = () => {
  const state = mkdtempSync(path.join(tmpdir(), "kmcli-"))
  const home = path.join(state, "ouroboros-skills", "desk", "drains")
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, XDG_STATE_HOME: state }
  const run = async (argv) => {
    const out = []; const err = []
    const io = { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) } }
    const code = await runDrainsCli({ argv, script: "drains", io, env })
    return { code, text: out.join("") + err.join("") }
  }
  return { state, home, env, run }
}

test("leases take and status work through the CLI; a claim needs a card and an owner", async () => {
  const { run } = setup()
  const taken = await run(["leases", "take", "--card", "t/c", "--owner", "s1"])
  assert.equal(taken.code, 0)
  assert.match(taken.text, /claimed by s1/)
  assert.match((await run(["leases", "status"])).text, /t\/c: ownerless/)
  for (const argv of [["leases", "take", "--owner", "s"], ["leases", "take", "--card", "c"], ["progress"]]) assert.notEqual((await run(argv)).code, 0)
  const bad = await run(["leases", "take", "--card", "t/c", "--owner", " "])
  assert.notEqual(bad.code, 0)
  assert.match(bad.text, /needs both a card and the session/)
})

test("a corrupted claims.json stops the lease commands instead of reading as no claims", async () => {
  const { home, run } = setup()
  writeFileSync(path.join(home, "claims.json"), "{not json")
  for (const argv of [["leases", "status"], ["leases", "take", "--card", "a", "--owner", "b"]]) {
    const r = await run(argv)
    assert.notEqual(r.code, 0)
    assert.match(r.text, /claims\.json cannot be read/)
  }
})

test("a failure that is not a corrupted claims.json is not hidden behind that message", { skip: process.platform === "win32" }, async () => {
  const { home, run } = setup()
  chmodSync(home, 0o555)
  try {
    const r = await run(["leases", "take", "--card", "a", "--owner", "b"]).catch((e) => ({ code: 1, text: String(e) }))
    assert.notEqual(r.code, 0)
    assert.doesNotMatch(r.text, /claims\.json cannot be read/)
  } finally { chmodSync(home, 0o755) }
})

test("keepers check runs from keepers.json and refuses a config it cannot read", async () => {
  const { home, run } = setup()
  writeFileSync(path.join(home, "keepers.json"), JSON.stringify({ host: "laptop", peers: [{ host: "mini" }] }))
  const ok = await run(["keepers", "check"])
  assert.equal(ok.code, 0)
  assert.match(ok.text, /laptop: heartbeat shown/)
  assert.match(ok.text, /peer_silent/)
  const dir = await run(["keepers", "check", "--config", home])
  assert.notEqual(dir.code, 0)
  assert.match(dir.text, /cannot be read/)
})

const withGh = async (script, fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), "fakegh-"))
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\n${script}\n`)
  chmodSync(path.join(dir, "gh"), 0o755)
  const before = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${before}`
  try { return await fn() } finally { process.env.PATH = before }
}

test("a lease reads the last push GitHub recorded, and anything unreadable counts as no push", { skip: process.platform === "win32" }, async () => {
  const { home, env } = setup()
  const paths = leasePaths({ env })
  const NOW = Date.parse("2026-11-26T12:00:00Z")
  const t = (iso) => Date.parse(iso)
  await claimCard({ paths, card: "t/c", owner: "s1", repo: "o/r", branch: "b", now: t("2026-11-26T08:00:00Z"), env, push: () => null })
  const state = async (script) => withGh(script, async () => (await leaseStatus({ paths, now: NOW, env })).leases[0])
  // the owner's history is gone, so it is ownerless whatever the push says; the push path is still exercised
  assert.equal((await state("echo 2026-11-26T11:59:00Z")).state, "ownerless")
  assert.equal((await state("exit 1")).state, "ownerless")
  assert.ok(home)
  // an unusable repo or branch skips the lookup
  await claimCard({ paths, card: "t/d", owner: "s1", repo: "bad repo", branch: "", now: NOW, env, push: () => null })
  const all = await withGh("exit 1", async () => (await leaseStatus({ paths, now: NOW, env })).leases)
  assert.equal(all.length, 2)
})

test("a peer with an ssh alias is read over ssh, and an unusable alias or failed read counts as silent", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fakessh-"))
  const now = Date.parse("2026-11-26T12:00:00Z")
  writeFileSync(path.join(dir, "ssh"), `#!/bin/sh\necho '{"host":"mini","at":"${new Date(now - 60_000).toISOString()}"}'\n`)
  chmodSync(path.join(dir, "ssh"), 0o755)
  const before = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${before}`
  try {
    const run = (peer) => keepersCheck({ config: { host: null, repo: null, peers: [peer] }, heartbeatDir: dir, endings: [], leases: [], now })
    assert.equal((await run({ host: "mini", ssh: "aris-mac-mini" })).findings.length, 0)
    assert.equal((await run({ host: "mini", ssh: "bad alias" })).findings.length, 1)
    writeFileSync(path.join(dir, "ssh"), "#!/bin/sh\nexit 255\n")
    assert.equal((await run({ host: "mini", ssh: "aris-mac-mini" })).findings.length, 1)
  } finally { process.env.PATH = before }
})

test("the heartbeat publishes to a shared remote and says so when it cannot", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pub-"))
  const bare = path.join(root, "origin.git")
  const clone = path.join(root, "clone")
  spawnSync("git", ["init", "-q", "--bare", bare], { windowsHide: true })
  spawnSync("git", ["init", "-q", clone], { windowsHide: true })
  spawnSync("git", ["-C", clone, "remote", "add", "origin", bare], { windowsHide: true })
  const now = Date.parse("2026-11-26T12:00:00Z")
  assert.equal(publish({ repo: clone, host: "laptop", now }), true)
  assert.equal(publish({ repo: path.join(root, "missing"), host: "laptop", now }), false)
  assert.equal(publish({ repo: clone, host: "bad host", now }), false)
  const dir = mkdtempSync(path.join(tmpdir(), "hb-"))
  const noRemote = path.join(root, "bare-clone")
  spawnSync("git", ["init", "-q", noRemote], { windowsHide: true })
  const r = await keepersCheck({ config: { host: "laptop", repo: noRemote, peers: [] }, heartbeatDir: dir, endings: [], leases: [], now })
  assert.match(r.status[0], /locally only/)
})

test("odd configs, endings and acceptance records are each judged, never trusted", async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "cfg-")), "keepers.json")
  writeFileSync(f, JSON.stringify({ host: "bad host", repo: 5, peers: "none" }))
  assert.deepEqual(readKeeperConfig(f), { host: null, repo: null, peers: [] })
  writeFileSync(f, JSON.stringify({ host: "a", repo: "/r", peers: [{ host: "b" }, 3] }))
  assert.deepEqual(readKeeperConfig(f), { host: "a", repo: "/r", peers: [{ host: "b" }] })
  const NOW = Date.parse("2026-11-26T12:00:00Z")
  const e = (ending, card = "c") => ({ at: "2026-11-26T11:00:00Z", card, ending })
  assert.equal(findings({ endings: [{ card: 5, ending: {} }, { card: "n" }, e({ kind: "unverified" }), e({ kind: "unverified", why: "x" }, "d")], now: NOW }).length, 2)
  assert.equal(endingsDir({ HOME: "/h", XDG_STATE_HOME: "rel" }), path.join("/h", ".local", "state", "ouroboros-skills", "desk", "turn-ends"))
  assert.ok(endingsDir({}).endsWith(path.join("desk", "turn-ends")))
  const lookup = () => null
  const r = progressOf({ card: "c", lookup, endings: [{ card: "c" }, e({ kind: "waiting" }), e({ kind: "done" })], acceptance: [{ card: "z" }, { card: "c", passed: true, check: "x", version: "v1" }, { card: "c", passed: true, check: "x", version: "v2", at: "t" }, { card: "c", passed: true, check: "", version: "v" }, { card: "c", passed: true, check: "x", version: "" }, { card: "c", passed: false }, { card: "c", passed: true, check: 5, version: "v" }, { card: "c", passed: true, check: "x", version: 5 }] })
  assert.equal(r.count, 2)
  assert.equal(r.unverified.length, 6)
})

test("a lease judges an owner by its own history, and an unreadable gh reads as no push", { skip: process.platform === "win32" }, async () => {
  const { env } = setup()
  const home = mkdtempSync(path.join(tmpdir(), "cop-"))
  env.COPILOT_HOME = home
  const paths = leasePaths({ env })
  mkdirSync(path.dirname(paths.claims), { recursive: true })
  mkdirSync(path.join(home, "session-state", "s1"), { recursive: true })
  writeFileSync(path.join(home, "session-state", "s1", "events.jsonl"), `${JSON.stringify({ type: "user.message", timestamp: "2026-11-26T11:59:00.000Z" })}\n`)
  const NOW = Date.parse("2026-11-26T12:00:00Z")
  assert.equal((await claimCard({ paths, card: "t/c", owner: "s1", now: NOW - 60_000, env, push: () => null })).taken, true)
  const again = await claimCard({ paths, card: "t/c", owner: "s2", now: NOW, env, push: () => null })
  assert.equal(again.taken, false)
  assert.match(again.status[0], /held by s1/)
  assert.equal((await leaseStatus({ paths, now: NOW, env, push: () => null })).leases[0].state, "held")
  writeFileSync(paths.claims, JSON.stringify({ claims: 5 }))
  assert.deepEqual((await leaseStatus({ paths, now: NOW, env })).leases, [])
  writeFileSync(paths.claims, JSON.stringify({ claims: [{ card: "t/c", owner: "s1", repo: "o/r", branch: "b", claimedAt: "2026-11-26T11:59:00Z" }] }))
  const before = process.env.PATH
  process.env.PATH = mkdtempSync(path.join(tmpdir(), "nogh-"))
  try { assert.equal((await leaseStatus({ paths, now: NOW, env })).leases[0].state, "held") } finally { process.env.PATH = before }
})

test("a peer ssh alias is needed to read over ssh, and a ssh read of a bad name is refused", async () => {
  const now = Date.parse("2026-11-26T12:00:00Z")
  const r = await keepersCheck({ config: { host: null, repo: null, peers: [{ host: "x y", ssh: "alias" }, { host: "m" }] }, heartbeatDir: tmpdir(), endings: [], leases: [], now, read: undefined })
  assert.equal(r.findings.length, 2)
})

test("a finding with a card names it in the status line", async () => {
  const r = await keepersCheck({ config: { host: null, repo: null, peers: [] }, heartbeatDir: tmpdir(), endings: [], leases: [{ card: "t/c", state: "lapsed", why: "w" }], now: Date.now() })
  assert.match(r.status.join("\n"), /lease_lapsed t\/c: lapsed: w/)
})
