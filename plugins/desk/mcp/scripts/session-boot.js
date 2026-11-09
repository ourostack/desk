#!/usr/bin/env node
// Session-start's one-call boot: `session-start/SKILL.md` runs this one
// command, optionally with `--task <name>`, in place of the migration check,
// host probe, prereq probe, workspace sync, active-task scan, card validation,
// push-account resolution, repo fetch and open-PR lookup it used to spell out
// as separate steps. Foreground boot returns local context and a background
// operation. Only the worker's bounded background inspection restores a
// runtime pack and performs the deeper checks.
let code
if (process.argv.includes("--background")) {
  const path = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const { ensureBootDependencies } = await import("../src/runtime/boot-dependencies.js")
  ensureBootDependencies({ mcpRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), env: process.env })
  const { runBootCli } = await import("../src/runtime/boot.js")
  code = await runBootCli({ argv: process.argv.slice(2) })
} else {
  const { runForegroundBootCli } = await import("../src/runtime/boot-entry.js")
  code = await runForegroundBootCli({ argv: process.argv.slice(2) })
}
// The agent's shell waits for this process to end, not for its output. A status write still waiting on the factory's
// lock, which another session can hold, must not keep it waiting once the boot text is out.
process.stdout.write("", () => process.exit(code))
