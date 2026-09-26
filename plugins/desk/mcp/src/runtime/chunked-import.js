// Load a module graph a piece at a time, so no single import holds the thread that answers the host for long.
//
// Importing the runtime server in one step compiles and evaluates its whole graph in one synchronous stretch (about 150 ms on a fast machine), and every request that arrives meanwhile waits. Importing its local imports first, one per turn of the event loop, spreads that work out; the final import then finds most of the graph already loaded.
//
// Dependency-free, so the session can use it before the runtime pack loads.

import { readFileSync } from "node:fs"

const LOCAL_IMPORT = /^(?:import|export)\s[^"']*?from\s+["'](\.{1,2}\/[^"']+)["']/gmu

/** The module's own relative imports (`./x.js`, `../y.js`), resolved against its URL, in source order. */
export function localImports(url, read = (href) => readFileSync(new URL(href), "utf8")) {
  return [...new Set([...read(url).matchAll(LOCAL_IMPORT)].map((match) => new URL(match[1], url).href))]
}

/** Import `url` after importing each of its local imports on its own turn of the event loop. A piece that fails is left for the final import to report. */
export async function importInChunks(url, {
  load = (href) => import(href),
  read,
  yieldTurn = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
  let pieces = []
  try {
    pieces = localImports(url, read)
  } catch {
    // An unreadable source still gets its single import, which reports the problem.
  }
  for (const piece of pieces) {
    try {
      await load(piece)
    } catch {
      // The final import fails the same way and names the cause.
    }
    await yieldTurn()
  }
  return load(url)
}
