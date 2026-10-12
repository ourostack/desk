// Load a module graph a piece at a time, so no single import holds the thread that answers the host for long.
//
// Importing the runtime server in one step compiles and evaluates its whole graph in one synchronous stretch (about 150 ms on a fast machine), and every request that arrives meanwhile waits. Importing only the server's direct local imports first still left each of them to load its own subtree in one stretch: on a loaded machine one such piece held the thread for over 200 ms. So the graph is walked depth first and each local module is imported after its own local imports, one per turn of the event loop; every import then finds its local dependencies already loaded and runs only its own code and any packages it is first to use.

// Dependency-free, so the session can use it before the runtime pack loads.

import { readFileSync } from "node:fs"

const LOCAL_IMPORT = /^(?:import|export)\s[^"']*?from\s+["'](\.{1,2}\/[^"']+)["']/gmu

/** The module's own relative imports (`./x.js`, `../y.js`), resolved against its URL, in source order. */
export function localImports(url, read = (href) => readFileSync(new URL(href), "utf8")) {
  return [...new Set([...read(url).matchAll(LOCAL_IMPORT)].map((match) => new URL(match[1], url).href))]
}

const PACKAGE_IMPORT = /^(?:import|export)\s[^"']*?from\s+["']([^."'/][^"']*)["']/gmu

/** The module's package imports (`pkg`, `@scope/pkg/sub.js`), without Node's built-in modules, in source order. */
export function packageImports(url, read = (href) => readFileSync(new URL(href), "utf8")) {
  return [...new Set([...read(url).matchAll(PACKAGE_IMPORT)].map((match) => match[1]).filter((specifier) => !specifier.startsWith("node:")))]
}

/** Import `url` after importing each local module below it, leaves first, each on its own turn of the event loop. A piece that fails is left for the final import to report. */
export async function importInChunks(url, {
  load = (href) => import(href),
  read,
  resolvePackage = null,
  yieldTurn = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
  const visited = new Set([url])
  async function below(href) {
    let pieces = []
    try {
      // A package a module is first to use (the MCP SDK, which brings in its schema validator, is the largest) is its own piece too, so it does not load in the same turn as the module.
      if (resolvePackage) {
        for (const specifier of packageImports(href, read)) {
          try {
            pieces.push(resolvePackage(specifier))
          } catch {
            // An unresolvable package is left for the module's own import to report.
          }
        }
      }
      pieces.push(...localImports(href, read))
    } catch {
      // An unreadable source still gets its own import, which reports the problem.
    }
    for (const piece of pieces) {
      if (visited.has(piece)) continue
      visited.add(piece)
      await below(piece)
      try {
        await load(piece)
      } catch {
        // The final import fails the same way and names the cause.
      }
      await yieldTurn()
    }
  }
  await below(url)
  return load(url)
}
