import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { isolatedEnv, mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(path.join(mcpRoot, "package.json"))
const repo = path.resolve(mcpRoot, "../../..")
const loader = path.join(repo, "tests/desk/mcp/__tests__/launch/fixtures/native-template-loader.cjs")
const canonical = path.join(mcpRoot, "web-native-error-transport.cjs")

for (const included of [false, true]) {
  test(`actual NYC ${included ? "collects the first included VM template" : "leaves an excluded VM template uninstrumented"}`, async () => {
    const root = await mkTempRoot("native-template-nyc-"), script = path.join(root, "probe.cjs")
    const preload = path.join(root, "preload.cjs")
    fs.writeFileSync(preload, `global.__deskTemplatePreload = ${JSON.stringify(root)};\n`)
    fs.writeFileSync(script, `
      const assert = require("node:assert/strict");
      assert.equal(global.__deskTemplatePreload, ${JSON.stringify(root)}, "inherited preloads still execute");
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
    const exclude = ["tests/desk/mcp/__tests__/**", "plugins/desk/mcp/node_modules/**"]
    const raw = path.join(root, "raw")
    // NYC's spawn hook propagates its parent config; preserve each actual CLI cell's declared scope.
    const inherited = { ...process.env, NODE_OPTIONS:
      [process.env.NODE_OPTIONS, "--require=" + JSON.stringify(preload)].filter(Boolean).join(" ") }
    const env = { ...isolatedEnv({ home, cache: path.join(root, "cache") }), NODE_OPTIONS: inherited.NODE_OPTIONS,
      NYC_CONFIG_OVERRIDE: JSON.stringify({ cwd: repo, include: [include], exclude, tempDirectory: raw, tempDir: raw, all: false }) }
    const result = spawnSync(process.execPath, [
      require.resolve("nyc/bin/nyc.js"), "--silent", "--all=false", "--cwd", repo, "--temp-dir", raw,
      "--include", include,
      ...exclude.flatMap(pattern => ["--exclude", pattern]),
      process.execPath, script,
    ], { cwd: repo, env, encoding: "utf8", timeout: 20000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr + result.stdout)
  })
}

const relayCanonical = 'plugins/desk/mcp/web-native-relay.cjs';
const other = 'plugins/desk/mcp/web-native-artifacts.cjs';
const scenario = fileURLToPath(new URL('./fixtures/native-template-nyc-scenario.cjs', import.meta.url));
const owner = Object.keys(require.cache).find(file => /[/\\]nyc[/\\]index\.js$/.test(file)) ||
  require.resolve('nyc', { paths: [path.join(repo, 'plugins/desk/mcp')] });
const bin = path.join(path.dirname(owner), 'bin/nyc.js');
const sha = value => createHash('sha256').update(value).digest('hex');

for (const cell of ['empty-required', 'other-measured', 'selected-initialized', 'selected-uninitialized']) {
  test(`actual ordinary NYC template selection: ${cell}`, { timeout: 20000 }, async t => {
    const root = await mkTempRoot(`native-template-nyc-${cell}-`);
    const include = cell === 'empty-required' ? [] : cell === 'other-measured' ? [other] : [relayCanonical];
    const config = { cwd: repo, all: true, include,
      exclude: include.length ? ['tests/desk/mcp/__tests__/**', 'plugins/desk/mcp/node_modules/**'] : ['**'],
      extension: ['.js', '.cjs'], cache: false, checkCoverage: false,
      reporter: ['json'], reportDir: path.join(root, 'report'), tempDir: path.join(root, 'raw') };
    const configFile = path.join(root, 'nyc.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const staged = path.join(root, 'desk-native-relay.cjs');
    fs.copyFileSync(path.join(repo, relayCanonical), staged);
    const child = spawnSync(process.execPath, [bin, '--cwd', repo, '--nycrc-path', configFile,
      process.execPath, '--import', new URL('../_isolated_env.mjs', import.meta.url).href,
      scenario, cell, staged],
    // NYC's maintained wrap.js explicitly supports this nested-run override.
    // Retain every inherited preload; only this owned child's actual NYC
    // selection changes to the cell's config, never the producer/parent.
    { cwd: repo, env: { ...process.env, NYC_CONFIG_OVERRIDE: JSON.stringify(config),
        DESK_TEST_PARENT_NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const receipt = JSON.parse(child.stdout.trim().split('\n').find(line => line.startsWith('{"cell":')));
    assert.equal(receipt.cell, cell);
    assert.equal(receipt.sourceSha256, sha(fs.readFileSync(path.join(repo, relayCanonical))));
    t.diagnostic(JSON.stringify({ driverPid: child.pid, driverExit: child.status,
      configSha256: sha(JSON.stringify(config)), ...receipt }));
  });
}
