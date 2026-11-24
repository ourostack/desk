// Shared JSON records under `_shared/` and `pages/` cite task folders by desk path ("track/slug/task.md"). A move changes that path, so these
// helpers find the citing records and rewrite the cited path; Markdown links are handled separately by archive-links.js.
import { promises as fs } from "node:fs"
import * as path from "node:path"

const SKIP_DIRS = new Set(["node_modules", ".git", ".state", "_cache"])
const CITING_ROOTS = ["_shared", "pages"]
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

async function jsonFiles(dir, out) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await jsonFiles(file, out)
    } else if (entry.isFile() && entry.name.endsWith(".json")) out.push(file)
  }
  return out
}

/** `text` with every whole-path citation of `sourcePrefix` (or a file under it) changed to `destinationPrefix`, and how many. */
function rewriteCitations(text, sourcePrefix, destinationPrefix) {
  let count = 0
  const after = text.replace(new RegExp(`(^|[^A-Za-z0-9_./-])${escape(sourcePrefix)}(?=$|[^A-Za-z0-9_.-])`, "g"), (_, lead) => {
    count += 1
    return `${lead}${destinationPrefix}`
  })
  return { text: after, count }
}

/** The JSON records under `_shared/` and `pages/` that cite a path of `pairs` (`[from, to]`, applied in order), as `[{ file, rel, before, after, rewritten }]`; `before` is a Buffer. */
export async function planCitationRewrites({ root, pairs }) {
  const planned = []
  for (const top of CITING_ROOTS) {
    for (const file of await jsonFiles(path.join(root, top), [])) {
      const before = await fs.readFile(file)
      let text = before.toString("utf8")
      if (!Buffer.from(text, "utf8").equals(before)) continue
      let rewritten = 0
      for (const [from, to] of pairs) {
        const linked = rewriteCitations(text, from, to)
        text = linked.text
        rewritten += linked.count
      }
      if (rewritten > 0) planned.push({ file, rel: path.relative(root, file).split(path.sep).join("/"), before, after: text, rewritten })
    }
  }
  return planned
}
