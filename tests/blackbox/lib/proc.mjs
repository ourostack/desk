// Process measurements that need no Desk code: the resident memory (RSS) of a process and all its children, sampled while it runs.

import { execFile } from "node:child_process"

const WINDOWS = process.platform === "win32"
const SAMPLE_MS = WINDOWS ? 2000 : 400

function listProcesses() {
  return new Promise((resolve) => {
    if (WINDOWS) {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([math]::Round($_.WorkingSetSize / 1024))\" }"],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parse(stdout)))
    } else {
      execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parse(stdout)))
    }
  })
}

function parse(text) {
  return text.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).map(Number)).filter((row) => row.length === 3 && row.every(Number.isFinite))
}

/** RSS in KiB of `pid` and every descendant, or null when the process is gone. */
export async function treeRssKiB(pid) {
  const rows = await listProcesses()
  const children = new Map()
  let found = false
  for (const [child, parent] of rows) {
    if (child === pid) found = true
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(child)
  }
  if (!found) return null
  const rss = new Map(rows.map(([child, , kib]) => [child, kib]))
  let total = 0
  const stack = [pid]
  const seen = new Set()
  while (stack.length > 0) {
    const next = stack.pop()
    if (seen.has(next)) continue
    seen.add(next)
    total += rss.get(next) ?? 0
    for (const child of children.get(next) ?? []) stack.push(child)
  }
  return total
}

export class RssSampler {
  constructor(pid) {
    this.peakKiB = 0
    this.samples = 0
    this.stopped = false
    const tick = async () => {
      if (this.stopped || pid === undefined) return
      const kib = await treeRssKiB(pid)
      if (kib !== null) {
        this.samples += 1
        this.peakKiB = Math.max(this.peakKiB, kib)
      }
      if (!this.stopped) this.timer = setTimeout(tick, SAMPLE_MS)
    }
    this.timer = setTimeout(tick, 50)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }
}
