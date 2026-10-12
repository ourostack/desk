// The runtime server is imported a piece at a time, so the thread that answers the host is never held for the whole graph at once.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { importInChunks, localImports, packageImports } from "../../../../../plugins/desk/mcp/src/runtime/chunked-import.js"
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

test("each piece loads on its own turn after its own local imports, then the module itself; a failing piece is left to the final import", async () => {
  const events = []
  const sources = {
    "server.js": 'import "x"\nimport { a } from "./a.js"\nimport { b } from "./b.js"\n',
    "a.js": 'import { leaf } from "./lib/leaf.js"\nimport { b } from "./b.js"\n',
    "leaf.js": 'import { a } from "../a.js"\n',
    "b.js": "export const b = 1\n",
  }
  const loaded = await importInChunks("file:///m/src/server.js", {
    read: (href) => sources[href.split("/").pop()],
    load: async (href) => {
      events.push(`load ${href.split("/").pop()}`)
      if (href.endsWith("a.js")) throw new Error("a is broken")
      return { href }
    },
    yieldTurn: async () => { events.push("turn") },
  })
  // A cycle (leaf.js imports a.js back) and a shared import (b.js) are each loaded once.
  assert.deepEqual(events, ["load leaf.js", "turn", "load b.js", "turn", "load a.js", "turn", "load server.js"])
  assert.equal(loaded.href, "file:///m/src/server.js")
})

test("an unreadable module is imported in one step, and the real default loader and turn work", async () => {
  const unreadable = await importInChunks("file:///nowhere/server.js", { load: async (href) => href })
  assert.equal(unreadable, "file:///nowhere/server.js")
  const root = await mkTempRoot("desk-chunked-import-")
  writeFileSync(path.join(root, "leaf.mjs"), "export const leaf = 1\n")
  writeFileSync(path.join(root, "middle.mjs"), 'import { leaf } from "./leaf.mjs"\nexport const middle = leaf + 1\n')
  writeFileSync(path.join(root, "main.mjs"), 'import { middle } from "./middle.mjs"\nexport const value = middle + 1\n')
  assert.equal((await importInChunks(pathToFileURL(path.join(root, "main.mjs")).href)).value, 3)
})

test("package imports are found in source order, once each, without Node's built-in modules", () => {
  const source = [
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js"',
    'import matter from "gray-matter"',
    'import { readFileSync } from "node:fs"',
    'import { a } from "./a.js"',
    'export { b } from "pkg"',
    'import again from "gray-matter"',
  ].join("\n")
  assert.deepEqual(packageImports("file:///m/src/server.js", () => source), ["@modelcontextprotocol/sdk/server/index.js", "gray-matter", "pkg"])
})

test("with a package resolver, each package is its own piece before the module's local imports, and the walk continues inside it", async () => {
  const events = []
  const sources = {
    "server.js": 'import { Server } from "sdk"\nimport { a } from "./a.js"\nimport x from "missing"\n',
    "a.js": 'import { Server } from "sdk"\n',
    "index.js": 'import { p } from "./protocol.js"\nimport Ajv from "ajv"\n',
    "protocol.js": "export const p = 1\n",
    "ajv.js": "module.exports = {}\n",
  }
  const resolved = { sdk: "file:///m/node_modules/sdk/index.js", ajv: "file:///m/node_modules/ajv/ajv.js" }
  await importInChunks("file:///m/src/server.js", {
    read: (href) => sources[href.split("/").pop()],
    resolvePackage: (specifier) => {
      if (!resolved[specifier]) throw new Error(`cannot resolve ${specifier}`)
      return resolved[specifier]
    },
    load: async (href) => { events.push(href.replace("file:///m/", "")) },
    yieldTurn: async () => {},
  })
  assert.deepEqual(events, ["node_modules/ajv/ajv.js", "node_modules/sdk/protocol.js", "node_modules/sdk/index.js", "src/a.js", "src/server.js"])
})

test("the mirror's resolver loads a package early as the same instance the module later imports", async () => {
  const root = await mkTempRoot("desk-chunked-import-packages-")
  mkdirSync(path.join(root, "node_modules", "counted"), { recursive: true })
  writeFileSync(path.join(root, "node_modules", "counted", "package.json"), JSON.stringify({ name: "counted", type: "module", exports: { ".": "./index.js" } }))
  writeFileSync(path.join(root, "node_modules", "counted", "index.js"), "globalThis.deskCountedLoads = (globalThis.deskCountedLoads ?? 0) + 1\nexport const counted = globalThis.deskCountedLoads\n")
  mkdirSync(path.join(root, "src", "runtime"), { recursive: true })
  copyFileSync(new URL("../../../../../plugins/desk/mcp/src/runtime/resolve-here.js", import.meta.url), path.join(root, "src", "runtime", "resolve-here.js"))
  writeFileSync(path.join(root, "src", "server.js"), 'import { counted } from "counted"\nexport const value = counted\n')
  const server = pathToFileURL(path.join(root, "src", "server.js")).href
  const { resolvePackage } = await import(new URL("./runtime/resolve-here.js", server).href)
  assert.equal(resolvePackage("counted"), pathToFileURL(path.join(root, "node_modules", "counted", "index.js")).href)
  const loaded = []
  const result = await importInChunks(server, { resolvePackage, load: (href) => { loaded.push(href); return import(href) } })
  assert.equal(loaded[0], resolvePackage("counted"))
  assert.equal(result.value, 1)
  assert.equal(globalThis.deskCountedLoads, 1)
})
