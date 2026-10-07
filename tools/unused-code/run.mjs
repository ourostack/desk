// Runs knip over a copy of the repository's files, with a package.json at the copy's root.
// knip needs a package.json at the root of what it scans, and a package.json at the real repository root would change how Node
// loads every file below it (the offline evaluation tests build fixtures inside the checkout and would inherit its module type).
// The copy holds every tracked file and every untracked file that Git does not ignore, so it sees the working tree as it is.
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, "..", "..")
const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
if (listed.status !== 0) {
  console.error(`git ls-files failed: ${listed.stderr}`)
  process.exit(2)
}
const copy = mkdtempSync(join(tmpdir(), "desk-knip-"))
let status = 2
try {
  for (const file of listed.stdout.split("\0").filter(Boolean)) {
    const source = join(repository, file)
    if (!existsSync(source)) continue
    mkdirSync(dirname(join(copy, file)), { recursive: true })
    cpSync(source, join(copy, file), { verbatimSymlinks: true })
  }
  writeFileSync(join(copy, "package.json"), `${JSON.stringify({ name: "desk-repository", private: true })}\n`)
  const knip = join(here, "node_modules", "knip", "bin", "knip.js")
  status = spawnSync(process.execPath, [knip, "--config", "tools/unused-code/knip.jsonc"], { cwd: copy, stdio: "inherit" }).status ?? 2
} finally {
  rmSync(copy, { recursive: true, force: true })
}
process.exit(status)
