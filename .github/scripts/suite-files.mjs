// The Desk unit test files, found the one way the shard runner and the verdict script both need: every `*.test.js` under the tests folder, as paths relative to it with forward slashes, sorted.
import fs from "node:fs"
import path from "node:path"

export function suiteFiles(testsRoot, only = "") {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".test.js") ? [full] : []
  })
  const relative = walk(testsRoot).sort().map((file) => path.relative(testsRoot, file).split(path.sep).join("/"))
  // `only` narrows the list for an investigation run: a regular expression over the relative path.
  return only === "" ? relative : relative.filter((file) => new RegExp(only, "u").test(file))
}
