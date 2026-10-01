// The place a script run straight from an installed plugin folder (no
// node_modules beside it) registers the restored runtime dependencies, so the
// card readers can still load gray-matter. `boot-dependencies.js` fills it;
// `organization.js` reads it when gray-matter is not beside the plugin.

let resolver = null
let failure = null

/** Registers `require`-like `resolver(name)` for the restored runtime dependencies. */
export function setRuntimeResolver(next) {
  resolver = next
  failure = null
}

/** Records why the runtime dependencies could not be restored, so boot can say so. */
export function setRuntimeResolverFailure(message) {
  resolver = null
  failure = message
}

/** The restored dependency `name`; throws when nothing is registered, like a failed `require`. */
export function requireFromRuntime(name) {
  if (resolver === null) throw new Error(`Cannot find module '${name}' in the restored runtime dependencies`)
  return resolver(name)
}

/** Why the restore failed, or null when it did not run or succeeded. */
export function runtimeResolverFailure() {
  return failure
}
