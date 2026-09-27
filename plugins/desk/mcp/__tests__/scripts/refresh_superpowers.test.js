import { test } from "node:test"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)

test("Superpowers refresh and release contract", () => {
  require(path.join(repoRoot, "scripts", "test-refresh-superpowers.cjs"))
})
