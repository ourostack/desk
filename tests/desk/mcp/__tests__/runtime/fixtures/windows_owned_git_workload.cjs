#!/usr/bin/env node
"use strict"
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const { spawn } = require("node:child_process")
const profiles = Object.freeze(["G_BASELINE", "G_STDIN512K", "G_BLOCK", "G_DATA_PRESSURE", "G_DELAY1500"])
function fail() { throw new Error("fixture_workload") }
function quotePublic(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0"'!$`]/.test(value)) fail()
  return `"${value.replaceAll("\\", "/")}"`
}
function fixedAlias(node, workload, profile, id) {
  if (!/^(?:O0[1-9]|X01|A(?:1[0-9]|2[0-5])|C(?:0[3-7]|15))-P(?:20|22|24)-R(?:20|22|24)$/.test(id)) fail()
  const fixed = { G_EXIT0: "!exit 0", G_EXIT7: "!exit 7", G_EPIPE: "!exit 9" }
  if (Object.hasOwn(fixed, profile)) return fixed[profile]
  if (!profiles.includes(profile)) fail()
  return `!exec ${quotePublic(node)} ${quotePublic(workload)} ${profile} ${id}`
}
function binaryInput(size) {
  if (![4096, 524288].includes(size)) fail()
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = i & 255
  return out
}
function main() {
  if (process.platform !== "win32") fail()
  const hook = path.basename(__filename) === "pre-commit"
  const [profile, id] = process.argv.slice(2)
  if (!hook && (!profiles.includes(profile) || process.argv.length !== 4 ||
    process.env.DESK_TEST_OWNED_GIT_CASE !== id)) fail()
  if (hook && process.env.DESK_TEST_OWNED_GIT_CASE !== "A24-P24-R24") fail()
  const D = BigInt(process.env.DESK_TEST_OWNED_GIT_D)
  if (process.hrtime.bigint() >= D) fail()
  const endpoint = process.env.DESK_TEST_OWNED_GIT_WITNESS
  const witnessNonce = process.env.DESK_TEST_OWNED_GIT_WITNESS_NONCE
  if (!/^\\\\\.\\pipe\\desk-owned-git-witness-[0-9a-f]{64}$/.test(endpoint || "") ||
    !/^[a-f0-9]{64}$/.test(witnessNonce || "")) fail()
  const signal = net.createConnection({ path: endpoint })
  const signalTimer = setTimeout(() => { signal.destroy(); process.exitCode=1 },
    Math.max(0,Number((D-process.hrtime.bigint())/1000000n)))
  signal.once("connect", () => signal.end(`${hook ? "HOOK_RAN" : "WORKLOAD_STARTED"} ${witnessNonce}\n`))
  signal.on("error", () => { process.exitCode = 1 })
  signal.once("close", () => clearTimeout(signalTimer))
  if (hook) return
  if (profile === "G_BLOCK") {
    const timer = setInterval(() => { if (process.hrtime.bigint() >= D) clearInterval(timer) }, 5)
    return
  }
  if (profile === "G_DATA_PRESSURE") {
    const block = Buffer.alloc(65536, 120)
    for (const output of [process.stdout, process.stderr]) {
      let left = 4194304
      const pump = () => {
        while (left > 0 && process.hrtime.bigint() < D) {
          left -= block.length
          if (!output.write(block)) { output.once("drain", pump); return }
        }
      }
      pump()
    }
    return
  }
  if (profile === "G_DELAY1500") {
    const until = process.hrtime.bigint() + 1500000000n
    const wait = () => {
      if (process.hrtime.bigint() >= D) { process.exitCode = 1; return }
      if (process.hrtime.bigint() < until) setTimeout(wait, 1)
    }
    wait()
  }
  const expected = profile === "G_STDIN512K" ? 524288 : profile === "G_BASELINE" ? 4096 : 0
  let bytes = 0, wrong = false
  process.stdin.on("data", (chunk) => {
    for (const value of chunk) { if (value !== (bytes & 255)) wrong = true; bytes++ }
    if (bytes > expected || process.hrtime.bigint() >= D) { wrong = true; process.stdin.destroy() }
  })
  process.stdin.on("end", () => {
    if (wrong || bytes !== expected) { process.exitCode = 1; return }
    if (profile !== "G_BASELINE" && profile !== "G_STDIN512K") return
    const fixtureRoot = process.env.DESK_TEST_OWNED_GIT_PUBLIC_FIXTURES
    const image = path.join(fixtureRoot, "retained-supervisor.exe")
    const child = spawn(image, ["--descendant-witness"], {
      windowsHide: true, detached: true, stdio: ["ignore", "inherit", "inherit"],
      env: { SystemRoot: process.env.SystemRoot, DESK_TEST_OWNED_GIT_D: D.toString(),
        DESK_TEST_OWNED_GIT_WITNESS: endpoint, DESK_TEST_OWNED_GIT_WITNESS_NONCE: witnessNonce },
    })
    child.on("error", () => { process.exitCode = 1 })
    // Skip libuv's kill-on-workload-exit job, not the nonbreakaway product/
    // broader jobs. Retained Windows sources do not set BREAKAWAY for detached.
    child.unref()
  })
  process.stdin.on("error", () => { process.exitCode = 1 })
}
module.exports = { quotePublic, fixedAlias, binaryInput }
if (require.main === module) {
  try { main() } catch { process.exitCode = 1 }
}
