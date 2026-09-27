import { test } from "node:test"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)

test("Superpowers upstream pull request contract", () => {
  require(path.join(repoRoot, "scripts", "test-superpowers-upstream-pr.cjs"))
})
