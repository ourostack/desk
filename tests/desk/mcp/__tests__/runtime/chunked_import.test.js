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

test("each piece loads on its own turn after the pieces below it, then the module itself; a failing piece is left to the final import", async () => {
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
  // a.js and leaf.js import each other, so only a.js, where the walk enters that cycle, loads on its own; b.js is shared and loads once.
  assert.deepEqual(events, ["load b.js", "turn", "load a.js", "turn", "load server.js"])
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

test("with a package resolver, each package is its own piece in source order, and the walk does not read inside packages", async () => {
  const events = []
  const reads = []
  const sources = {
    "server.js": 'import { Server } from "sdk"\nimport { a } from "./a.js"\nimport x from "missing"\n',
    "a.js": 'import { Server } from "sdk"\nimport Ajv from "ajv"\n',
  }
  const resolved = { sdk: "file:///m/node_modules/sdk/index.js", ajv: "file:///m/node_modules/ajv/ajv.js" }
  await importInChunks("file:///m/src/server.js", {
    read: (href) => { reads.push(href.replace("file:///m/", "")); return sources[href.split("/").pop()] },
    resolvePackage: (specifier) => {
      if (!resolved[specifier]) throw new Error(`cannot resolve ${specifier}`)
      return resolved[specifier]
    },
    load: async (href) => { events.push(href.replace("file:///m/", "")) },
    yieldTurn: async () => {},
  })
  assert.deepEqual(events, ["node_modules/sdk/index.js", "node_modules/ajv/ajv.js", "src/a.js", "src/server.js"])
  assert.deepEqual(reads, ["src/server.js", "src/a.js"])
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

test("a module in an import cycle is never imported on its own: the cycle is entered where the whole graph enters it", async () => {
  // A valid cycle: main imports a, a imports b, b imports c, c imports a back. Importing main evaluates c, then b, then a. Importing
  // c on its own would instead evaluate b before c and fail with "Cannot access 'c' before initialization", and Node would keep that
  // failure for every later import of the graph.
  const root = await mkTempRoot("desk-chunked-import-cycle-")
  writeFileSync(path.join(root, "main.mjs"), 'import { A } from "./a.mjs"\nexport const value = A\n')
  writeFileSync(path.join(root, "a.mjs"), 'import { b } from "./b.mjs"\nexport const A = b + 1\n')
  writeFileSync(path.join(root, "b.mjs"), 'import { c } from "./c.mjs"\nexport const b = c + 1\n')
  writeFileSync(path.join(root, "c.mjs"), 'import { A } from "./a.mjs"\nexport const c = 1\nexport function readA() { return A }\n')
  const loaded = []
  const result = await importInChunks(pathToFileURL(path.join(root, "main.mjs")).href, {
    load: (href) => { loaded.push(path.basename(new URL(href).pathname)); return import(href) },
  })
  assert.equal(result.value, 3)
  assert.deepEqual(loaded, ["a.mjs", "main.mjs"], "only the cycle's entry is imported on its own")
})

test("imports are taken in source order, including side-effect imports, and packages are leaves", async () => {
  const events = []
  const sources = {
    "server.js": 'import "./setup.js"\nimport { Server } from "sdk"\nimport { a } from "./a.js"\n',
    "setup.js": "globalThis.ready = true\n",
    "a.js": 'import { b } from "./b.js"\n',
    "b.js": 'import { a } from "./a.js"\n',
  }
  await importInChunks("file:///m/src/server.js", {
    read: (href) => sources[href.split("/").pop()] ?? (() => { throw new Error(`read ${href}`) })(),
    resolvePackage: (specifier) => `file:///m/node_modules/${specifier}/index.js`,
    load: async (href) => { events.push(href.replace("file:///m/", "")) },
    yieldTurn: async () => {},
  })
  assert.deepEqual(events, ["src/setup.js", "node_modules/sdk/index.js", "src/a.js", "src/server.js"])
})
