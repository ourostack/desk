// The runtime server is imported a piece at a time, so the thread that answers the host is never held for the whole graph at once.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { importInChunks, localImports } from "../../src/runtime/chunked-import.js"
import { mkTempRoot } from "../_temp_roots.js"

test("local imports are found in source order, once each, including multi-line and re-export forms", () => {
  const source = [
    'import { a } from "./a.js"',
    'import {',
    '  b,',
    '} from "../lib/b.js"',
    'export { c } from "./c.js"',
    'import { d } from "node:fs"',
    'import { e } from "package/e.js"',
    'import { again } from "./a.js"',
  ].join("\n")
  assert.deepEqual(localImports("file:///m/src/server.js", () => source), ["file:///m/src/a.js", "file:///m/lib/b.js", "file:///m/src/c.js"])
})

test("each piece loads on its own turn, then the module itself; a failing piece is left to the final import", async () => {
  const events = []
  const loaded = await importInChunks("file:///m/src/server.js", {
    read: () => 'import "x"\nimport { a } from "./a.js"\nimport { b } from "./b.js"\n',
    load: async (href) => {
      events.push(`load ${href.split("/").pop()}`)
      if (href.endsWith("a.js")) throw new Error("a is broken")
      return { href }
    },
    yieldTurn: async () => { events.push("turn") },
  })
  assert.deepEqual(events, ["load a.js", "turn", "load b.js", "turn", "load server.js"])
  assert.equal(loaded.href, "file:///m/src/server.js")
})

test("an unreadable module is imported in one step, and the real default loader and turn work", async () => {
  const unreadable = await importInChunks("file:///nowhere/server.js", { load: async (href) => href })
  assert.equal(unreadable, "file:///nowhere/server.js")
  const root = await mkTempRoot("desk-chunked-import-")
  writeFileSync(path.join(root, "leaf.mjs"), "export const leaf = 1\n")
  writeFileSync(path.join(root, "main.mjs"), 'import { leaf } from "./leaf.mjs"\nexport const value = leaf + 1\n')
  assert.equal((await importInChunks(pathToFileURL(path.join(root, "main.mjs")).href)).value, 2)
})
