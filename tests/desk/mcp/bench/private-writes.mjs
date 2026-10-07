// Micro-benchmark: what N private-store writes cost, with the real protection (the native Windows ACL provider, or the macOS ACL tools).
// Usage: node private-writes.mjs [--src <path to a src/factory/outbox.js>] [--n 100] [--label <text>]
// Every write is a new marker file (the factory's smallest private write), then the same writes again over the existing files. It prints one JSON line.
// `--src` lets the same script time another checkout of the factory code (for example the commit before a change) in the same job.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(arg("--src", path.join(here, "..", "..", "..", "..", "plugins", "desk", "mcp", "src", "factory", "outbox.js")))
const n = Number(arg("--n", "100"))
const label = arg("--label", path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(src)))))))
const { writeMarker } = await import(pathToFileURL(src).href)

const base = fs.mkdtempSync(path.join(os.tmpdir(), "desk-bench-"))
const env = { ...process.env, HOME: base, USERPROFILE: base, XDG_STATE_HOME: path.join(base, "state") }
const marker = (i) => ({
  schema_version: 1,
  host: "claude-code",
  session_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  log_path: "/session.log",
  cwd: "/project",
  desk_root: path.join(base, "desk"),
  end_reason: "prompt_input_exit",
  ended_at: "2026-09-25T09:30:00.000Z",
  plugins: [{ name: "desk", version: "3.2.0-alpha.37" }],
  updated_at: new Date().toISOString(),
})

const times = []
let failure = null
try {
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      const started = performance.now()
      await writeMarker(env, marker(i))
      times.push({ pass, ms: performance.now() - started })
    }
  }
} catch (error) {
  failure = String(error?.message ?? error)
}
fs.rmSync(base, { recursive: true, force: true })
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
const stat = (rows) => (rows.length === 0 ? null : { count: rows.length, totalMs: Math.round(rows.reduce((sum, r) => sum + r.ms, 0)), meanMs: +(rows.reduce((sum, r) => sum + r.ms, 0) / rows.length).toFixed(1), p50Ms: +percentile(rows.map((r) => r.ms), 0.5).toFixed(1), p95Ms: +percentile(rows.map((r) => r.ms), 0.95).toFixed(1), maxMs: +Math.max(...rows.map((r) => r.ms)).toFixed(1) })
console.log(JSON.stringify({ label, platform: process.platform, n, failure, firstWrite: times[0] ? +times[0].ms.toFixed(1) : null, createNew: stat(times.filter((t) => t.pass === 0)), overwrite: stat(times.filter((t) => t.pass === 1)) }))
if (failure) process.exitCode = 1
