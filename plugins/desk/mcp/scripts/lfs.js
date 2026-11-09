#!/usr/bin/env node
import process from "node:process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { inspectLfs } from "../src/runtime/lfs.js"
import { createLfsDesk, planLfsDesk } from "../src/runtime/lfs-create.js"

export function main({ argv = process.argv.slice(2), cwd = process.cwd(), write = (text) => process.stdout.write(text) } = {}) {
  if (argv[0] === "create") {
    let repo, expectedPlan, apply = false
    let valid = true
    for (let i = 1; i < argv.length; i += 1) {
      const flag = argv[i]
      if (flag === "--apply" && !apply) apply = true
      else if ((flag === "--repo" && repo === undefined || flag === "--expect-plan" && expectedPlan === undefined) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
        if (flag === "--repo") repo = argv[++i]
        else expectedPlan = argv[++i]
      } else valid = false
    }
    if (!valid || !repo || apply !== (expectedPlan !== undefined) || expectedPlan !== undefined && !/^[a-f0-9]{64}$/u.test(expectedPlan)) {
      write(`${JSON.stringify({ state: "usage", message: "usage: node lfs.js create --repo <absent absolute path> [--apply --expect-plan <reviewed SHA-256>]; existing paths are never adopted" })}\n`)
      return 2
    }
    const result = apply ? createLfsDesk({ repo, expectedPlan }) : planLfsDesk({ repo })
    write(`${JSON.stringify(result, null, 2)}\n`)
    return ["plan", "configured_local"].includes(result.state) ? 0 : 1
  }
  if (argv[0] !== "inspect" || !(argv.length === 1 || argv.length === 3 && argv[1] === "--repo" && argv[2] !== "" && !argv[2].startsWith("--"))) {
    write(`${JSON.stringify({ state: "usage", message: "usage: node lfs.js inspect [--repo <existing repository>] or create --repo <absent absolute path> [--apply --expect-plan <reviewed SHA-256>]; inspect is read-only and create never adopts an existing path" })}\n`)
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
