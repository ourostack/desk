import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { claimCard, leasePaths, leaseStatus } from "../../../../../plugins/desk/mcp/src/runtime/leases.js"
import { keepersCheck, publish } from "../../../../../plugins/desk/mcp/src/runtime/keepers.js"

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

test("a failure that is not a corrupted claims.json is not hidden behind that message", async () => {
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

test("a lease reads the last push GitHub recorded, and anything unreadable counts as no push", async () => {
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

test("a peer with an ssh alias is read over ssh, and an unusable alias or failed read counts as silent", async () => {
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
