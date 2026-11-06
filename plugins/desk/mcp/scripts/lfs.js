#!/usr/bin/env node
import process from "node:process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { inspectLfs } from "../src/runtime/lfs.js"

export function main({ argv = process.argv.slice(2), cwd = process.cwd(), write = (text) => process.stdout.write(text) } = {}) {
  if (argv[0] !== "inspect" || !(argv.length === 1 || argv.length === 3 && argv[1] === "--repo" && argv[2] !== "" && !argv[2].startsWith("--"))) {
    write(`${JSON.stringify({ state: "usage", message: "usage: node lfs.js inspect [--repo <existing repository>]; inspect is read-only" })}\n`)
    return 2
  }
  const result = inspectLfs({ repo: argv[2] ?? cwd })
  write(`${JSON.stringify(result, null, 2)}\n`)
  return result.state === "inspected" || result.state === "limited" ? 0 : 1
}

let entrypoint = false
try {
  entrypoint = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {
  entrypoint = false
}
if (entrypoint) process.exitCode = main()
