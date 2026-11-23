import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { performance } from "node:perf_hooks"

const MARKER = "desk_acl_phase|"
const STAGES = new Set([
  "script_entry", "encoding_start", "encoding_ready", "identity_ready",
  "waiting_input", "input_read", "request_parsed", "item_start", "item_ready",
  "acl_read_start", "acl_read_ready", "constrain_start", "acl_write_start",
  "acl_write_ready", "readback_start", "readback_ready", "verified",
  "response_start", "response_ready",
])

// Throwaway #1602 experiment: retain the real runner, stdin protocol and ACL
// operations. The extra stderr contains only fixed stage names and counters.
export function traceProgram(program) {
  const replace = (before, after) => {
    if (program.split(before).length !== 2) {
      throw new Error("Native ACL phase probe needs its exact, unique source anchor")
    }
    program = program.replace(before, after)
  }
  const mark = (name) => `Write-DeskAclPhase '${name}'`
  replace("$ErrorActionPreference = 'Stop'", `$ErrorActionPreference = 'Stop'
$script:deskAclTraceRequest = 0
$script:deskAclTracePath = 0
function Write-DeskAclPhase($stage) {
  [Console]::Error.WriteLine(('desk_acl_phase|{0}|{1}|{2}|{3}|{4}' -f $stage,
    $script:deskAclTraceRequest, $script:deskAclTracePath,
    [Diagnostics.Stopwatch]::GetTimestamp(), [Diagnostics.Stopwatch]::Frequency))
}
${mark("script_entry")}`)
  replace("$utf8 = New-Object System.Text.UTF8Encoding($false)",
    `${mark("encoding_start")}\n$utf8 = New-Object System.Text.UTF8Encoding($false)`)
  replace("[Console]::OutputEncoding = $utf8",
    `[Console]::OutputEncoding = $utf8\n${mark("encoding_ready")}`)
  replace("$administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    `$administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')\n${mark("identity_ready")}`)
  replace("$line = [Console]::In.ReadLine()",
    `${mark("waiting_input")}\n  $line = [Console]::In.ReadLine()`)
  replace("if ($null -eq $line) { break }",
    `if ($null -eq $line) { break }\n  $script:deskAclTraceRequest += 1\n  $script:deskAclTracePath = 0\n  ${mark("input_read")}`)
  replace("$request = $line | ConvertFrom-Json",
    `$request = $line | ConvertFrom-Json\n    ${mark("request_parsed")}`)
  replace("$item = Get-Item -LiteralPath $target -Force",
    `$script:deskAclTracePath += 1\n    ${mark("item_start")}\n    $item = Get-Item -LiteralPath $target -Force\n    ${mark("item_ready")}`)
  replace("$acl = $item.GetAccessControl('Access,Owner')",
    `${mark("acl_read_start")}\n    $acl = $item.GetAccessControl('Access,Owner')\n    ${mark("acl_read_ready")}`)
  replace("$acl.SetAccessRuleProtection($true, $false)",
    `${mark("constrain_start")}\n    $acl.SetAccessRuleProtection($true, $false)`)
  replace("$item.SetAccessControl($acl)",
    `${mark("acl_write_start")}\n    $item.SetAccessControl($acl)\n    ${mark("acl_write_ready")}`)
  replace("$applied = Get-Acl -LiteralPath $target",
    `${mark("readback_start")}\n    $applied = Get-Acl -LiteralPath $target\n    ${mark("readback_ready")}`)
  replace("$results += [pscustomobject]@{",
    `${mark("verified")}\n    $results += [pscustomobject]@{`)
  replace("[Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4",
    `${mark("response_start")}\n    [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4`)
  replace("results = @($results)\n    })))",
    `results = @($results)\n    })))\n    ${mark("response_ready")}`)
  return program
}

export function traceWindowsAclPhases() {
  if (process.platform !== "win32") return
  const spawn = childProcess.spawn
  const traces = []
  childProcess.spawn = function tracedSpawn(executable, args, options) {
    if (typeof executable !== "string" ||
        !/[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu.test(executable) ||
        !Array.isArray(args)) return spawn.call(this, executable, args, options)
    const encoded = args.indexOf("-EncodedCommand") + 1
    if (encoded === 0 || typeof args[encoded] !== "string") return spawn.call(this, executable, args, options)
    const program = Buffer.from(args[encoded], "base64").toString("utf16le")
    if (!program.includes("function Protect-Request($request)")) return spawn.call(this, executable, args, options)
    const tracedArgs = [...args]
    tracedArgs[encoded] = Buffer.from(traceProgram(program), "utf16le").toString("base64")
    const started = performance.now()
    const trace = { provider: traces.length + 1, spawnMs: null, firstWriteMs: null,
      writes: 0, stderrBytes: 0, clixmlHeader: false, last: null, stages: new Map(), exit: null }
    traces.push(trace)
    let buffer = ""
    let firstTick
    let previousTick
    let previousStage
    const child = spawn.call(this, executable, tracedArgs, options)
    child.once("spawn", () => { trace.spawnMs = performance.now() - started })
    const write = child.stdin.write
    child.stdin.write = function tracedWrite(...values) {
      trace.writes += 1
      trace.firstWriteMs ??= performance.now() - started
      return write.apply(this, values)
    }
    child.stderr.on("data", (chunk) => {
      trace.stderrBytes += chunk.length
      buffer += chunk.toString("utf8")
      let newline
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "")
        buffer = buffer.slice(newline + 1)
        if (line === "#< CLIXML") trace.clixmlHeader = true
        if (!line.startsWith(MARKER)) continue
        const fields = line.slice(MARKER.length).split("|")
        if (fields.length !== 5 || !STAGES.has(fields[0]) ||
            !fields.slice(1).every((value) => /^\d+$/u.test(value))) {
          throw new Error("Native ACL phase probe received an invalid fixed stage frame")
        }
        const [stage, request, entry, ticks, rate] = fields
        const tick = BigInt(ticks)
        const frequency = Number(rate)
        if (!Number.isSafeInteger(frequency) || frequency <= 0) {
          throw new Error("Native ACL phase probe received an invalid clock frequency")
        }
        firstTick ??= tick
        if (previousTick !== undefined) {
          const durationMs = Number(tick - previousTick) * 1000 / frequency
          const previous = trace.stages.get(previousStage)
          previous.totalMs += durationMs
          previous.maxMs = Math.max(previous.maxMs, durationMs)
        }
        const summary = trace.stages.get(stage) ?? { count: 0, totalMs: 0, maxMs: 0 }
        summary.count += 1
        trace.stages.set(stage, summary)
        trace.last = { stage, request: Number(request), entry: Number(entry),
          nodeMs: performance.now() - started, nativeMs: Number(tick - firstTick) * 1000 / frequency }
        previousTick = tick
        previousStage = stage
      }
    })
    child.once("close", (code, signal) => {
      trace.exit = { code, signal, nodeMs: performance.now() - started }
    })
    return child
  }
  syncBuiltinESMExports()
  process.once("exit", () => {
    for (const trace of traces) {
      process.stderr.write(`DESK_NATIVE_ACL_PHASE ${JSON.stringify({
        ...trace, stages: [...trace.stages].map(([stage, summary]) => ({ stage, ...summary })),
      })}\n`)
    }
  })
}
