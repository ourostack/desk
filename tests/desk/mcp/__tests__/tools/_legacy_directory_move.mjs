import { promises as fs } from "node:fs"
import path from "node:path"
import { spawn as spawnChild } from "node:child_process"

// These cooked bytes are the qualified Windows PowerShell 5.1 Directory.Move program.
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

function supported(file) {
  // Only qualified drive-absolute DOS paths, <248 UTF-16 units, not UNC,
  // device/verbatim namespaces or long-path normalization. Never repair a spelling.
  if (typeof file !== "string" || !/^[A-Za-z]:\\/u.test(file) || file.length >= 248 ||
      /[/:<>"|?*\u0000-\u001f]/u.test(file.slice(2)) ||
      file.slice(3).split("\\").some(component =>
        component === "." || component === ".." || /[. ]$/u.test(component) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)/iu.test(component)))
    throw new Error("task_archive: unsupported Windows archive path; no native move was released")
}

const problem = reason => new Error(`task_archive: native directory move ${reason}`)
const version = value => typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
const exception = value => typeof value === "string" &&
  /^System\.(?:IO\.[A-Za-z]{1,64}Exception|UnauthorizedAccessException|ArgumentException|NotSupportedException|Security\.SecurityException)$/u.test(value)

// Dependencies are internal JS seams for protocol tests, never MCP input.
export async function moveArchive(source, destination, beforeMove, {
  platform = process.platform, spawn = spawnChild, realpath = fs.realpath, env = process.env,
  setTimeout: startTimer = setTimeout, clearTimeout: stopTimer = clearTimeout,
} = {}) {
  if (platform !== "win32") {
    await beforeMove()
    await fs.rename(source, destination)
    return
  }
  supported(source)
  supported(destination)
  let physicalSource, physicalParent
  try {
    physicalSource = await realpath(source)
    physicalParent = await realpath(path.win32.dirname(destination))
  } catch { throw problem("path resolution unavailable; no native move was released") }
  supported(physicalSource)
  supported(physicalParent)
  supported(path.win32.join(physicalParent, path.win32.basename(destination)))
  const systemRoot = env.SystemRoot || env.SYSTEMROOT
  if (!systemRoot) throw problem("runtime unavailable; no native move was released")
  const state = { released: false, closed: false, forced: false, movement: "not_released", retirement: "confirmed" }
  let child
  try {
    child = spawn(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROGRAM],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env })
  } catch { throw Object.assign(problem("spawn unavailable"), { archiveMove: state }) }

  function bounded(promise, ms, label) {
    let timer
    return Promise.race([promise, new Promise((_, reject) => {
      timer = startTimer(() => reject(problem(label)), ms)
    })]).finally(() => stopTimer(timer))
  }
  let output = "", stdoutBytes = 0, stderrBytes = 0, issue = null, readyItem = null, result = null
  let readyResolve, readyReject, closeResolve, exitCode, exitSignal
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closed = new Promise(resolve => { closeResolve = resolve })
  function fail(reason) {
    issue ??= problem(reason)
    readyReject(issue)
  }
  child.on("error", () => fail("spawn unavailable"))
  child.stdin.on("error", () => fail("input unavailable"))
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length
    if (stdoutBytes > 16384) { fail("output exceeded its bound"); return }
    output += chunk.toString("utf8")
    for (;;) {
      const newline = output.indexOf("\n")
      if (newline === -1) break
      const line = output.slice(0, newline).trim()
      output = output.slice(newline + 1)
      let item
      try { item = JSON.parse(line) } catch { fail("response is not JSON"); continue }
      if (item?.state === "ready" && readyItem === null && !state.released && item.pid === child.pid &&
          version(item.powershell) && version(item.runtime) && item.edition === "Desktop" && item.api === "System.IO.Directory.Move") {
        readyItem = item
        state.runtime = { powershell: item.powershell, runtime: item.runtime, edition: "Desktop" }
        readyResolve()
      } else if (item?.state === "result" && state.released && result === null &&
          (item.moved === true && item.exception === null && item.hresult === null ||
           item.moved === false && exception(item.exception) && Number.isInteger(item.hresult) &&
           item.hresult >= -2147483648 && item.hresult <= 2147483647)) {
        result = { moved: item.moved, exception: item.exception, hresult: item.hresult }
      } else fail("response has an unexpected state")
    }
  })
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length
    if (stderrBytes > 16384) fail("diagnostic output exceeded its bound")
  })
  child.once("close", (code, signal) => {
    state.closed = true
    exitCode = code
    exitSignal = signal
    if (readyItem === null) fail("closed before readiness")
    closeResolve()
  })
  let failure
  try {
    try { child.stdin.write(JSON.stringify({ source, destination }) + "\n") } catch { fail("input unavailable") }
    await bounded(ready, 5000, "readiness exceeded its bound")
    await beforeMove()
    if (issue || state.closed) throw issue || problem("closed before release")
    state.released = true
    try { child.stdin.end("move\n") } catch { throw problem("input unavailable") }
    await bounded(closed, 5000, "acknowledgement exceeded its bound")
    if (issue) throw issue
    if (output.trim() || exitSignal !== null) throw problem("acknowledgement is invalid")
    if (result?.moved === false && exitCode === 3) {
      throw problem("was refused")
    }
    if (result?.moved !== true || exitCode !== 0) throw problem("acknowledgement is missing or invalid")
    state.movement = "confirmed"
  } catch (error) { failure = error }
  finally {
    if (!state.closed) {
      try { child.stdin.end() } catch {
        failure.native_close_failure = "native input closure failed"
      }
      try { await bounded(closed, 2000, "close is unconfirmed") } catch {
        state.forced = true
        try { child.kill() } catch { /* Retirement remains unconfirmed until this handle closes. */ }
        try { await bounded(closed, 2000, "retirement is unconfirmed") } catch {
          state.retirement = "unconfirmed"
        }
        if (state.closed) state.retirement = "forced"
        failure.native_close_failure = `native retirement ${state.retirement}`
      }
    }
    if (state.released) {
      if (!issue && !output.trim() && result?.moved === false && exitCode === 3 &&
          exitSignal === null && state.retirement === "confirmed") {
        state.movement = "refused"
        state.refusal = result
      } else if (failure) state.movement = "unconfirmed"
    }
  }
  if (failure) { failure.archiveMove = state; throw failure }
  return state
}
