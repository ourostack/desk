import { strict as assert } from "node:assert"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { importRuntimeServer } from "../../../../../plugins/desk/mcp/src/runtime/bootstrap.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
const runtime = await importRuntimeServer({ mcpRoot, runtimeCacheDir: process.argv[2] })
assert.equal(runtime._deskRuntime.loaded_from_source_mirror, true)
process.stdout.write("source-mirror-load-ok\n")
