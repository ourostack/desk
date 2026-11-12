// TEMPORARY probe for #758; removed before merge. Windows only.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { removeTree } from "../_remove_tree.js"

const N = 10
async function trial(remove) {
  const base = mkdtempSync(path.join(os.tmpdir(), "desk-probe-held-"))
  const exe = path.join(base, "gh.exe")
  cpSync(process.execPath, exe)
  const child = spawn(exe, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" })
  await once(child, "spawn")
  const closed = once(child, "close")
  let outcome
  try { await remove(base); outcome = "removed" } catch (error) { outcome = error.code ?? String(error) }
  await closed
  await removeTree(base).catch(() => {})
  return outcome
}

test("probe: rmSync of a fixture whose copied exe is still held", { skip: process.platform !== "win32" }, async () => {
  const outcomes = []
  for (let i = 0; i < N; i++) outcomes.push(await trial(async (base) => rmSync(base, { recursive: true, force: true })))
  assert.equal(outcomes.filter((o) => o !== "removed").length, N, `rmSync outcomes ${JSON.stringify(outcomes)}`)
})

test("probe: removeTree of a fixture whose copied exe is still held", { skip: process.platform !== "win32" }, async () => {
  const outcomes = []
  for (let i = 0; i < N; i++) outcomes.push(await trial(removeTree))
  assert.equal(outcomes.filter((o) => o === "removed").length, N, `removeTree outcomes ${JSON.stringify(outcomes)}`)
})
