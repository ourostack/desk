import * as path from "node:path"
import { deskPluginRoot, deskVersion } from "../package-metadata.js"

/**
 * Who is serving this call, read from the serving process alone: no search, index, git or network read, so desk_status can
 * attach it to every answer even when the slow runtime status misses its budget. `plugin_root` is the plugin folder the tools
 * load from (the newest release's copy when Desk runs that), and `loaded` is false until the runtime's source mirror is.
 */
export function runtimeIdentity({ env = process.env, runtime = null } = {}) {
  const loadedRoot = typeof runtime?.plugin_root === "string" && runtime.plugin_root !== "" ? runtime.plugin_root : null
  const pluginRoot = loadedRoot ?? deskPluginRoot(env)
  const mirror = runtime?.source_mirror_path ?? runtime?.sourceMirrorPath ?? null
  const mirrorPath = typeof mirror === "string" && mirror !== "" ? mirror : null
  return {
    plugin: { name: "desk", version: deskVersion({ DESK_PLUGIN_ROOT: pluginRoot }) },
    plugin_root: pluginRoot,
    source_mirror_path: mirrorPath,
    source_mirror_hash: mirrorPath === null ? null : path.basename(mirrorPath),
    loaded: mirrorPath !== null,
    ...(runtime?.newest_release === undefined ? {} : { newest_release: runtime.newest_release }),
  }
}
