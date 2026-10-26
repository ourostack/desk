// Shared scaffolding for search-tool tests: a small synthetic desk and its
// exact-word index, in memory the way the search engine keeps it.

// Imported first so a test file run on its own (`node --test <file>`, not
// through `npm test`) also gets the temporary HOME and XDG folders and the
// real-home write guard.
import "../_isolated_env.mjs"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after } from "node:test"

const tempDeskRoots = new Set()

after(() => Promise.all([...tempDeskRoots].map((root) => fs.rm(root, { recursive: true, force: true }))))

export async function mkTempDeskRoot() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "desk-search-test-"))
  tempDeskRoots.add(root)
  return root
}

/** Write a file under `<root>/<rel>`, creating parent dirs. */
export async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

const indexes = new Map()

after(() => { for (const db of indexes.values()) db.close() })

/**
 * Index a fixture desk into an in-memory database (one per desk, reused on
 * the next call) and return the rebuildIndex summary. `fixtureDb(deskRoot)`
 * is the database the indexed search functions read.
 */
export async function buildFixtureIndex(deskRoot, opts = {}) {
  const { rebuildIndex } = await import("../../../../../plugins/desk/mcp/src/indexer/index.js")
  const { openDb } = await import("../../../../../plugins/desk/mcp/src/db/init.js")
  if (!indexes.has(deskRoot)) indexes.set(deskRoot, openDb(deskRoot, { dbPath: ":memory:" }))
  return rebuildIndex(deskRoot, { ...opts, db: indexes.get(deskRoot) })
}

export function fixtureDb(deskRoot) {
  const db = indexes.get(deskRoot)
  if (db === undefined) throw new Error(`no fixture index for ${deskRoot}; call buildFixtureIndex first`)
  return db
}
