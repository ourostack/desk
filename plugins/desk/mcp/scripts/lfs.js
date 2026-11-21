#!/usr/bin/env node
import process from "node:process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { inspectLfs } from "../src/runtime/lfs.js"
import { defineCli, defineCommand } from "../src/lib/ouro-ui/registry/ouro/ax/ax-command.ts"
import { runCli } from "../src/lib/ouro-ui/registry/ouro/ax/cli.ts"

const lfsCli = (cwd) => defineCli({
  name: "lfs",
  about: ["Reports local Git LFS observations; inspect is read-only."],
  commands: [
    defineCommand({
      name: "inspect",
      summary: "Inspect an existing repository's binary storage: exit 0 for a report (even one with limitations), 1 when the repository could not be inspected.",
      effect: "private",
      readOnly: true,
      output: "one JSON value",
      text: (result) => JSON.stringify(result, null, 2),
      exit: (result) => (result.state === "inspected" || result.state === "limited" ? "ok" : "error"),
      flags: { repo: { type: "string", placeholder: "<existing repository>", description: "The repository to inspect; the current folder by default." } },
      run: (input) => inspectLfs({ repo: input.repo ?? cwd }),
    }),
  ],
})

export function main({ argv = process.argv.slice(2), cwd = process.cwd(), write = (text) => process.stdout.write(text), writeError = (text) => process.stderr.write(text) } = {}) {
  return runCli(lfsCli(cwd), argv, { stdout: { write }, stderr: { write: writeError } })
}

let entrypoint = false
try {
  entrypoint = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {
  entrypoint = false
}
if (entrypoint) process.exitCode = await main()
