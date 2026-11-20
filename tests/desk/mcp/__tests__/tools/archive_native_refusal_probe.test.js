import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { PassThrough } from "node:stream"
import fs from "node:fs/promises"
import path from "node:path"
import { openArchiveHandleSession } from "../../../../../plugins/desk/mcp/src/tools/archive-native-session.js"

const anchors = [
  ["      $phase = 'delete_open'\n", "delete_open"],
  ["      $phase = 'held_validate'\n", "held_validate"],
  ["      $phase = 'current_open'\n", "current_open"],
  ["      $phase = 'current_validate'\n", "current_validate"],
  ["      $phase = 'rename'\n", "rename"],
  ["        $rename.success = [bool]$ok\n", "rename_returned"],
  ["  if ($null -eq $script:failure) { $script:failure", "refuse_entered"],
  ["  throw 'owned_refusal'\n", "refuse_throw"],
  ["} catch {\n  if ($null -eq $script:failure)", "caught", true],
  ["finally {\n  Close-Entry $current", "dispose_started", true],
  ["  if ($script:closeFailures -gt 0)", "dispose_finished"],
  ["if ($script:disposition -ceq 'moved'", "result_emitted"],
]

function probeSpawn(observations) {
  return (executable, args, options) => {
    let program = args[4]
    for (const [anchor, stage, inside] of anchors) {
      assert.equal(program.split(anchor).length, 2, `unique diagnostic anchor: ${stage}`)
      const indent = anchor.match(/^ */u)[0]
      const replacement = inside ? anchor.replace("\n", `\n  Probe '${stage}'\n`) :
        `${indent}Probe '${stage}'\n${anchor}`
      program = program.replace(anchor, replacement)
    }
    program = `
$script:probeStart = [Diagnostics.Stopwatch]::GetTimestamp()
function Probe([string]$stage) {
  [Console]::WriteLine(('DESK_REFUSAL_PROBE ' + $stage + ' ' + $PID + ' ' +
    [long](([Diagnostics.Stopwatch]::GetTimestamp() - $script:probeStart) * 1000000 / [Diagnostics.Stopwatch]::Frequency)))
  [Console]::Out.Flush()
}
${program}`
    const child = spawn(executable, [...args.slice(0, 4), program], options)
    const output = child.stdout
    const protocol = new PassThrough()
    let pending = ""
    output.on("data", chunk => {
      pending += chunk.toString("utf8")
      for (;;) {
        const newline = pending.indexOf("\n")
        if (newline < 0) break
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line.startsWith("DESK_REFUSAL_PROBE ")) {
          const match = /^DESK_REFUSAL_PROBE ([a-z_]+) (\d+) (\d+)$/u.exec(line)
          assert.ok(match, "well-formed counts-only probe")
          assert.equal(Number(match[2]), child.pid)
          observations.push({ stage: match[1], nativeUs: Number(match[3]) })
        } else protocol.write(`${line}\n`)
      }
    })
    output.on("end", () => { protocol.end(pending); pending = "" })
    output.on("error", error => protocol.destroy(error))
    child.stdout = protocol
    return child
  }
}

test("diagnostic: actual native refusal retains its unchanged deadline and occupied destination",
  { skip: process.platform !== "win32", timeout: 35000 }, async () => {
    const root = await fs.mkdtemp(path.join(process.env.DESK_TEST_RUN_DIR, "native-refusal-probe-"))
    const source = path.join(root, "source"), destination = path.join(root, "destination")
    const observations = []
    let session
    try {
      await fs.mkdir(source)
      await fs.writeFile(path.join(source, "payload.txt"), "SOURCE\n")
      session = await openArchiveHandleSession({ source, destination }, { spawn: probeSpawn(observations) })
      await session.admit()
      await assert.rejects(session.move(async () => {
        await fs.mkdir(destination)
        await fs.writeFile(path.join(destination, "payload.txt"), "FOREIGN\n")
      }), error => {
        assert.equal(error.archiveMove.movement, "refused")
        assert.equal(error.archiveMove.retirement, "confirmed")
        assert.equal(error.archiveMove.forced, false)
        return true
      })
      assert.equal(await fs.readFile(path.join(source, "payload.txt"), "utf8"), "SOURCE\n")
      assert.equal(await fs.readFile(path.join(destination, "payload.txt"), "utf8"), "FOREIGN\n")
    } finally {
      try { if (session) await session.close() }
      finally {
        console.log(JSON.stringify({ diagnostic: "native-refusal", observations, receipt: session?.receipt }))
        await fs.rm(root, { recursive: true, force: true })
      }
    }
  })
