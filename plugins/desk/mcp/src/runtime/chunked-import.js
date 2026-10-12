// Load a module graph a piece at a time, so no single import holds the thread that answers the host for long.
//
// Importing the runtime server in one step compiles and evaluates its whole graph in one synchronous stretch (about 150 ms on a fast machine), and every request that arrives meanwhile waits. Importing only the server's direct local imports first still left each of them to load its own subtree in one stretch, and the final import of the server loaded the MCP SDK and its schema validator in one: on a loaded machine either held the thread for 90 to 240 ms. So the graph is walked depth first, in the order Node evaluates it, and each piece is imported after the pieces below it, one per turn of the event loop.
//
// Two rules keep each piece's evaluation exactly what the whole import would have done at that point:
// - The walk follows every module request of a module in source order (local, package and side-effect imports and re-exports), as Node does.
// - A module in an import cycle is never imported on its own, except the cycle's first module in that order, where the whole graph enters the cycle. Entered anywhere else, a cycle evaluates in a different order and can fail with "Cannot access ... before initialization", which Node then keeps for every later import of the graph. Cycles are found with Tarjan's algorithm.
// Packages are leaves: their internals cannot import our modules back, and importing a package entry on its own evaluates it as the whole graph would when it first reaches that entry.

// Dependency-free, so the session can use it before the runtime pack loads.

import { readFileSync } from "node:fs"

const MODULE_REQUEST = /^(?:import|export)\s+(?:[^"']*?\bfrom\s*)?["']([^"']+)["']/gmu
const readSource = (href) => readFileSync(new URL(href), "utf8")

/** The module's own relative imports (`./x.js`, `../y.js`), resolved against its URL, in source order. */
export function localImports(url, read = readSource) {
  return moduleRequests(url, read).filter((specifier) => specifier.startsWith(".")).map((specifier) => new URL(specifier, url).href)
}

/** The module's package imports (`pkg`, `@scope/pkg/sub.js`), without Node's built-in modules, in source order. */
export function packageImports(url, read = readSource) {
  return moduleRequests(url, read).filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:"))
}

/** Every static module request (imports with or without bindings, re-exports), once each, in source order. */
function moduleRequests(url, read = readSource) {
  return [...new Set([...read(url).matchAll(MODULE_REQUEST)].map((match) => match[1]))]
}

/** Import `url` after importing the pieces below it, in Node's evaluation order, each on its own turn of the event loop. A piece that fails is left for the final import to report. */
export async function importInChunks(url, {
  load = (href) => import(href),
  read = readSource,
  resolvePackage = null,
  yieldTurn = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
  const order = new Map()
  const low = new Map()
  const walking = []
  const onWalk = new Set()
  function requestsOf(href) {
    if (href.includes("/node_modules/")) return []
    let specifiers = []
    try {
      specifiers = moduleRequests(href, read)
    } catch {
      // An unreadable source is a leaf; its own import reports the problem.
    }
    const pieces = []
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("file:")) pieces.push(new URL(specifier, href).href)
      else if (resolvePackage && !specifier.startsWith("node:") && !specifier.startsWith("/")) {
        try {
          pieces.push(resolvePackage(specifier))
        } catch {
          // An unresolvable package is left for the module's own import to report.
        }
      }
    }
    return pieces
  }
  async function visit(href) {
    order.set(href, order.size)
    low.set(href, order.get(href))
    walking.push(href)
    onWalk.add(href)
    for (const piece of requestsOf(href)) {
      if (!order.has(piece)) {
        await visit(piece)
        low.set(href, Math.min(low.get(href), low.get(piece)))
      } else if (onWalk.has(piece)) {
        low.set(href, Math.min(low.get(href), order.get(piece)))
      }
    }
    if (low.get(href) !== order.get(href)) return
    // href is where the walk, like Node, first entered its strongly connected component: the other members load with it.
    let member
    do {
      member = walking.pop()
      onWalk.delete(member)
    } while (member !== href)
    if (href === url) return
    try {
      await load(href)
    } catch {
      // The final import fails the same way and names the cause.
    }
    await yieldTurn()
  }
  await visit(url)
  return load(url)
}
