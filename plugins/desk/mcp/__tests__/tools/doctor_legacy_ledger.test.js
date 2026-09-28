// desk_doctor and the retired manual work ledger (M3-12).
//
// The ledger's private partitions stay where they were. Doctor counts the
// partition folders under the legacy `work-ledger/` state path so an operator
// knows they are there; it never opens, reads, migrates or removes them.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { doctorRuntime } from "../../src/tools/doctor.js"
import { legacyLedgerPartitions, LEGACY_LEDGER_SEGMENTS } from "../../src/protected/legacy-ledger.js"
import { resolveStateHome } from "../../src/util/paths.js"

function makeState() {
  const base = mkdtempSync(path.join(tmpdir(), "desk-legacy-ledger-"))
  return { base, stateHome: path.join(base, "state"), ledgerDir: path.join(base, "state", ...LEGACY_LEDGER_SEGMENTS) }
}

function seedPartitions(ledgerDir, count) {
  for (let index = 0; index < count; index += 1) {
    const partition = path.join(ledgerDir, createHash("sha256").update(String(index)).digest("hex").slice(0, 32))
    mkdirSync(partition, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(partition, "work-ledger.sqlite"), `private payload ${index}`, { mode: 0o600 })
  }
}

// Every file's bytes and every folder's mode and mtime, so a read that
// touched nothing and a removal both show up as a difference.
function snapshot(dir) {
  const out = {}
  const walk = (current) => {
    const stat = statSync(current)
    out[path.relative(dir, current) || "."] = { mode: stat.mode, mtimeMs: stat.mtimeMs }
    if (!stat.isDirectory()) {
      out[path.relative(dir, current)].sha = createHash("sha256").update(readFileSync(current)).digest("hex")
      return
    }
    for (const name of readdirSync(current).sort()) walk(path.join(current, name))
  }
  walk(dir)
  return out
}

test("the legacy ledger path is the retired store's own namespace", () => {
  assert.deepEqual(LEGACY_LEDGER_SEGMENTS, ["ouroboros-skills", "desk", "work-ledger"])
})

test("the doctor counts under the same state home the protected stores use", () => {
  // One shared lookup (review N2): if it ever changes, both sides move together.
  for (const env of [
    { HOME: "/home/a" },
    { HOME: "/home/a", XDG_STATE_HOME: "  " },
    { HOME: "/home/a", XDG_STATE_HOME: "/state/b" },
    { HOME: "/home/a", XDG_STATE_HOME: "~/c" },
  ]) {
    assert.equal(legacyLedgerPartitions({ env }).path, path.join(resolveStateHome(env), ...LEGACY_LEDGER_SEGMENTS))
  }
})

test("doctor reports zero legacy partitions when the retired store never existed", () => {
  const state = makeState()
  try {
    const env = { HOME: state.base, XDG_STATE_HOME: state.stateHome }
    assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: 0, path: state.ledgerDir })
    const body = doctorRuntime({ input: {}, env })
    assert.deepEqual(body.legacy_work_ledger, { partitions: 0, path: state.ledgerDir })
    assert.equal(body.summary, "Desk MCP runtime dependencies are ready.")
    // Counting created nothing.
    assert.throws(() => statSync(state.stateHome), /ENOENT/u)

    // A file where a parent folder would be means the legacy folder cannot exist either.
    mkdirSync(path.join(state.stateHome, "ouroboros-skills"), { recursive: true })
    writeFileSync(path.join(state.stateHome, "ouroboros-skills", "desk"), "not a folder")
    assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: 0, path: state.ledgerDir })
  } finally {
    rmSync(state.base, { recursive: true, force: true })
  }
})

test("doctor reports one and many legacy partitions by count only and never changes them", () => {
  for (const count of [1, 3]) {
    const state = makeState()
    try {
      seedPartitions(state.ledgerDir, count)
      // A stray file beside the partitions is not a partition.
      writeFileSync(path.join(state.ledgerDir, "stray.txt"), "not a partition")
      const before = snapshot(state.stateHome)
      const env = { HOME: state.base, XDG_STATE_HOME: state.stateHome }

      const body = doctorRuntime({ input: {}, env })
      assert.deepEqual(body.legacy_work_ledger, { partitions: count, path: state.ledgerDir })
      assert.match(body.summary, new RegExp(`Retired work ledger\\n  ${count} private ${count === 1 ? "partition" : "partitions"} remain under ${state.ledgerDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"))
      assert.match(body.summary, /Desk no longer reads or writes them and never deletes them/u)
      assert.doesNotMatch(JSON.stringify(body), /private payload/u)
      assert.deepEqual(snapshot(state.stateHome), before)
    } finally {
      rmSync(state.base, { recursive: true, force: true })
    }
  }
})

test("the legacy count uses ~/.local/state when XDG_STATE_HOME is unset or blank", () => {
  const state = makeState()
  try {
    const ledgerDir = path.join(state.base, ".local", "state", ...LEGACY_LEDGER_SEGMENTS)
    seedPartitions(ledgerDir, 2)
    for (const env of [{ HOME: state.base }, { HOME: state.base, XDG_STATE_HOME: "  " }]) {
      assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: 2, path: ledgerDir })
    }
    // `~` in XDG_STATE_HOME expands against HOME.
    assert.deepEqual(legacyLedgerPartitions({ env: { HOME: state.base, XDG_STATE_HOME: "~/.local/state" } }), { partitions: 2, path: ledgerDir })
    // Without HOME in the environment, an absolute XDG_STATE_HOME still decides the path on its own.
    assert.deepEqual(legacyLedgerPartitions({ env: { XDG_STATE_HOME: path.join(state.base, ".local", "state") } }), { partitions: 2, path: ledgerDir })
  } finally {
    rmSync(state.base, { recursive: true, force: true })
  }
})

test("a symlinked legacy folder or partition is reported, never followed", () => {
  const state = makeState()
  try {
    const elsewhere = path.join(state.base, "elsewhere")
    seedPartitions(elsewhere, 2)
    mkdirSync(path.dirname(state.ledgerDir), { recursive: true })
    symlinkSync(elsewhere, state.ledgerDir)
    const env = { HOME: state.base, XDG_STATE_HOME: state.stateHome }
    assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: null, path: state.ledgerDir, unavailable: "not_a_directory" })
    const body = doctorRuntime({ input: {}, env })
    assert.match(body.summary, /Retired work ledger\n  the legacy folder could not be counted \(not_a_directory\)/u)

    rmSync(state.ledgerDir)
    seedPartitions(state.ledgerDir, 1)
    symlinkSync(path.join(elsewhere, readdirSync(elsewhere)[0]), path.join(state.ledgerDir, "linked"))
    assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: 1, path: state.ledgerDir })
  } finally {
    rmSync(state.base, { recursive: true, force: true })
  }
})

test("an unreadable legacy folder is reported as uncounted, not as zero", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions and a non-root user" : false }, () => {
  const state = makeState()
  try {
    seedPartitions(state.ledgerDir, 2)
    chmodSync(state.ledgerDir, 0o000)
    const env = { HOME: state.base, XDG_STATE_HOME: state.stateHome }
    assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: null, path: state.ledgerDir, unavailable: "unreadable" })
  } finally {
    chmodSync(state.ledgerDir, 0o700)
    rmSync(state.base, { recursive: true, force: true })
  }
})

test("a legacy folder whose parent cannot be searched is reported as uncounted, not as zero", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions and a non-root user" : false }, () => {
  const state = makeState()
  const parent = path.dirname(state.ledgerDir)
  try {
    seedPartitions(state.ledgerDir, 1)
    // Without search permission on the parent, looking the folder up fails with EACCES, not ENOENT.
    chmodSync(parent, 0o000)
    const env = { HOME: state.base, XDG_STATE_HOME: state.stateHome }
    assert.deepEqual(legacyLedgerPartitions({ env }), { partitions: null, path: state.ledgerDir, unavailable: "unreadable" })
    assert.match(doctorRuntime({ input: {}, env }).summary, /the legacy folder could not be counted \(unreadable\)/u)
  } finally {
    chmodSync(parent, 0o700)
    rmSync(state.base, { recursive: true, force: true })
  }
})

test("preview doctor carries no legacy ledger count", () => {
  const state = makeState()
  try {
    seedPartitions(state.ledgerDir, 1)
    const body = doctorRuntime({ input: { format: "preview" }, env: { HOME: state.base, XDG_STATE_HOME: state.stateHome } })
    assert.equal(body.legacy_work_ledger, undefined)
    assert.doesNotMatch(JSON.stringify(body), /work-ledger/u)
  } finally {
    rmSync(state.base, { recursive: true, force: true })
  }
})
