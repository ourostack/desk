// Reports an export of a hook that nothing uses.
// knip cannot see this for a CommonJS hook: tests load a hook as one whole object (`require(".../boot-checks.cjs")`) and then use some of its members, so knip counts the whole object as used and no single export as unused.
// A hook export counts as used when another tracked JavaScript file both names the hook (its file name) and the export (as a whole word). The check runs in the same job as knip, over the same working tree.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
if (listed.status !== 0) {
  console.error(`git ls-files failed: ${listed.stderr}`)
  process.exit(2)
}
const files = listed.stdout.split("\0").filter((file) => /\.(c|m)?js$/u.test(file) && !file.startsWith("evals/offline/vendor/") && existsSync(join(repository, file)))
const sources = new Map(files.map((file) => [file, readFileSync(join(repository, file), "utf8")]))
// A hook with no `module.exports` is a script that only runs (requiring it would run it), so it has no exports to check.
const hooks = files.filter((file) => /^plugins\/(desk|plain-language)\/hooks\/[^/]+\.cjs$/u.test(file) && sources.get(file).includes("module.exports"))
const require = createRequire(import.meta.url)

let unused = 0
for (const hook of hooks) {
  const name = basename(hook)
  const stem = name.replace(/\.cjs$/u, "")
  const exported = Object.keys(require(join(repository, hook)))
  for (const key of exported) {
    const word = new RegExp(`(?<![\\w$])${key.replaceAll("$", "\\$")}(?![\\w$])`, "u")
    const used = [...sources].some(([file, text]) => file !== hook && text.includes(stem) && word.test(text))
    if (!used) {
      unused += 1
      console.log(`Unused hook export  ${key}  ${hook}`)
    }
  }
}
if (unused > 0) console.log(`${unused} hook export(s) that no other file uses`)
process.exit(unused > 0 ? 1 : 0)
