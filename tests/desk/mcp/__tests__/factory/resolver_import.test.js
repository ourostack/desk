import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolveHookDeskRoot } from "../../../../../plugins/desk/mcp/scripts/resolve-desk-root.js"
import { scratch, json } from "./_session_helpers.js"
import * as path from "node:path"

test("importing the canonical hook resolver emits nothing and uses the host binding rather than cwd", () => scratch(async (ctx) => {
  const module = new URL("../../../../../plugins/desk/mcp/scripts/resolve-desk-root.js", import.meta.url).href
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`], { env: ctx.env, encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.equal(resolveHookDeskRoot({ env: ctx.env, cwd: ctx.base }).root, ctx.desk)
  const config = path.join(ctx.base, "activation.json")
  await json(config, { schema_version: 1, desk: { root: ctx.base } })
  assert.equal(resolveHookDeskRoot({ env: { ...ctx.env, DESK_ACTIVATION_CONFIG: config }, cwd: ctx.desk }).root, ctx.base)
  await json(config, {})
  assert.equal(resolveHookDeskRoot({ env: { ...ctx.env, DESK_ACTIVATION_CONFIG: config } }).root, null)
  assert.equal(resolveHookDeskRoot({ env: {} }).root, null)
  assert.equal(resolveHookDeskRoot().root, null)
}))
