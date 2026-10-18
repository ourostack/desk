import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { isolatedEnv, mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(path.join(mcpRoot, "package.json"))
const repo = path.resolve(mcpRoot, "../../..")
const loader = path.join(repo, "tests/desk/mcp/__tests__/launch/fixtures/native-template-loader.cjs")
const canonical = path.join(mcpRoot, "web-native-error-transport.cjs")

for (const included of [false, true]) {
  test(`actual NYC ${included ? "collects the first included VM template" : "leaves an excluded VM template uninstrumented"}`, async () => {
    const root = await mkTempRoot("native-template-nyc-"), script = path.join(root, "probe.cjs")
    fs.writeFileSync(script, `
      const assert = require("node:assert/strict");
      const { loadTemplate } = require(${JSON.stringify(loader)});
      const canonical = ${JSON.stringify(canonical)};
      assert.equal(global.__coverage__, undefined, "no eligible normal module has run");
      const first = { module: { exports: {} }, require, process, Buffer, setTimeout, clearTimeout };
      const api = loadTemplate(canonical, first);
      if (${included}) {
        const coverage = global.__coverage__;
        assert.ok(coverage && coverage[canonical]);
        assert.equal(first.__coverage__, coverage, "adopt the actual standard VM collector, not copied counters");
        const before = Object.values(coverage[canonical].f).reduce((sum, count) => sum + count, 0);
        assert.throws(() => api.project({ code: "NATIVE_REQUEST_TIMEOUT" }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
        const after = Object.values(coverage[canonical].f).reduce((sum, count) => sum + count, 0);
        assert.ok(after > before, "actual template function execution increments ordinary counters");
        const second = { module: { exports: {} }, require, process, Buffer, setTimeout, clearTimeout };
        assert.throws(() => loadTemplate(canonical, second).project({ code: "NATIVE_REQUEST_TIMEOUT" }),
          { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
        assert.equal(second.__coverage__, coverage, "later contexts share the same collector");
        assert.ok(Object.values(coverage[canonical].f).reduce((sum, count) => sum + count, 0) > after);
      } else {
        assert.throws(() => api.project({ code: "NATIVE_REQUEST_TIMEOUT" }), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED" });
        assert.equal(global.__coverage__, undefined);
        assert.equal(first.__coverage__, undefined);
      }
    `)
    const home = path.join(root, "home")
    fs.mkdirSync(home)
    const include = included ? "plugins/desk/mcp/web-native-error-transport.cjs" :
      "plugins/desk/hooks/lib/copilot-intake-context.cjs"
    const raw = path.join(root, "raw")
    // NYC's spawn hook propagates its parent config; preserve each actual CLI cell's declared scope.
    const env = { ...isolatedEnv({ home, cache: path.join(root, "cache") }),
      NYC_CONFIG_OVERRIDE: JSON.stringify({ cwd: repo, include: [include], tempDirectory: raw, tempDir: raw, all: false }) }
    const result = spawnSync(process.execPath, [
      require.resolve("nyc/bin/nyc.js"), "--silent", "--all=false", "--cwd", repo, "--temp-dir", raw,
      "--include", include,
      process.execPath, script,
    ], { cwd: repo, env, encoding: "utf8", timeout: 20000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr + result.stdout)
  })
}
