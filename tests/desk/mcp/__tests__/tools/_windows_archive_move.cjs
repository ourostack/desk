// Test-only native candidate. Production archive bytes remain unchanged.
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { createHash } = require("node:crypto")

const PROGRAM = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if ($request.source -isnot [string] -or $request.destination -isnot [string] -or
      !$request.source -or !$request.destination) { throw 'invalid_owned_input' }
  $ready = @{
    state = 'ready'; pid = $PID
    powershell = $PSVersionTable.PSVersion.ToString()
    edition = [string]$PSVersionTable.PSEdition
    runtime = [Environment]::Version.ToString()
    api = 'System.IO.Directory.Move'
  }
  [Console]::WriteLine(($ready | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  if ([Console]::ReadLine() -ne 'move') { exit 2 }
  try {
    [System.IO.Directory]::Move($request.source, $request.destination)
    $answer = @{ state = 'result'; moved = $true; exception = $null; hresult = $null }
  } catch {
    $failure = $_.Exception.GetBaseException()
    $answer = @{ state = 'result'; moved = $false
      exception = $failure.GetType().FullName; hresult = $failure.HResult }
  }
  [Console]::WriteLine(($answer | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  if ($answer.moved) { exit 0 } else { exit 3 }
} catch {
  [Console]::WriteLine('{"state":"program_error"}')
  [Console]::Out.Flush()
  exit 4
}
`
const programSha256 = createHash("sha256").update(PROGRAM).digest("hex")
const traceFile = path.resolve(__dirname, "../../../../../windows-native-directory-move-" + process.pid + ".jsonl")
function bounded(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label), { code:"OWNED_NATIVE_MOVE_TIMEOUT" })), ms)
  })]).finally(() => clearTimeout(timer))
}

exports.moveOwnedDirectory = async function moveOwnedDirectory(source, destination, beforeMove = async () => {}) {
  if (process.platform !== "win32") throw new Error("The native candidate is Windows-only")
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
  if (!systemRoot) throw new Error("The owned native candidate has no system runtime")
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROGRAM],
    { windowsHide:true, stdio:["pipe", "pipe", "pipe"], env:process.env })
  const trace = { programSha256, childPid:child.pid, ready:null, result:null,
    released:false, closed:false, forced:false, exitCode:null, signal:null, stdoutBytes:0, stderrBytes:0 }
  let output = "", problem = null, readyResolve, readyReject, closeResolve
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closed = new Promise(resolve => { closeResolve = resolve })
  child.on("error", error => { problem = error; readyReject(error) })
  child.stdin.on("error", error => { problem = error; readyReject(error) })
  child.stdout.on("data", chunk => {
    trace.stdoutBytes += chunk.length
    if (trace.stdoutBytes > 16384) {
      problem = new Error("Owned native response exceeds the bounded output")
      readyReject(problem)
      child.stdin.end()
      return
    }
    output += chunk.toString("utf8")
    for (;;) {
      const newline = output.indexOf("\n")
      if (newline === -1) break
      const line = output.slice(0, newline).trim()
      output = output.slice(newline + 1)
      let item
      try { item = JSON.parse(line) } catch (error) {
        problem = Object.assign(new Error("Owned native response is not JSON"), { cause:error })
        readyReject(problem)
        continue
      }
      if (item.state === "ready" && trace.ready === null && item.pid === child.pid) {
        trace.ready = item
        readyResolve(item)
      } else if (item.state === "result" && trace.result === null && typeof item.moved === "boolean") {
        trace.result = item
      } else {
        problem = new Error("Owned native response has an unexpected state")
        readyReject(problem)
      }
    }
  })
  child.stderr.on("data", chunk => {
    trace.stderrBytes += chunk.length
    if (trace.stderrBytes > 16384) {
      problem = new Error("Owned native diagnostic output exceeds its bound")
      readyReject(problem)
      child.stdin.end()
    }
  })
  child.once("close", (code, signal) => {
    trace.closed = true
    trace.exitCode = code
    trace.signal = signal
    if (trace.ready === null) readyReject(problem || new Error("Owned native child exited before readiness"))
    closeResolve()
  })
  let failure
  try {
    child.stdin.write(JSON.stringify({ source, destination }) + "\n")
    await bounded(ready, 5000, "Owned native readiness exceeded its bound")
    await beforeMove(trace.ready)
    trace.released = true
    child.stdin.end("move\n")
    await bounded(closed, 5000, "Owned native move acknowledgement exceeded its bound")
    if (problem) throw problem
    if (trace.result?.moved !== true || trace.exitCode !== 0 || trace.signal !== null)
      throw Object.assign(new Error("Owned native directory move was refused"),
        { code:"OWNED_NATIVE_MOVE_REFUSED" })
  } catch (error) { failure = error }
  finally {
    if (!trace.closed) child.stdin.end()
    if (!trace.closed) {
      try { await bounded(closed, 2000, "Owned native close is unconfirmed") } catch {
        // The directly spawned ChildProcess holds this exact native handle.
        trace.forced = true
        child.kill()
        try { await bounded(closed, 2000, "Owned native child retirement is unconfirmed") }
        catch (error) { failure = error }
      }
    }
    trace.errorCode = failure?.code || null
    fs.appendFileSync(traceFile, JSON.stringify(trace) + "\n")
  }
  if (failure) { failure.nativeMove = trace; throw failure }
  if (!trace.closed || trace.forced) {
    throw Object.assign(new Error("Owned native move is not normally retired"),
      { code:"OWNED_NATIVE_MOVE_UNSETTLED", nativeMove:trace })
  }
  return trace
}
