import '../_isolated_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkTempRoot } from '../_temp_roots.js';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const canonical = 'plugins/desk/mcp/web-native-relay.cjs';
const other = 'plugins/desk/mcp/web-native-artifacts.cjs';
const scenario = fileURLToPath(new URL('./fixtures/native-template-nyc-scenario.cjs', import.meta.url));
const owner = Object.keys(require.cache).find(file => /[/\\]nyc[/\\]index\.js$/.test(file)) ||
  require.resolve('nyc', { paths: [path.join(repo, 'plugins/desk/mcp')] });
const bin = path.join(path.dirname(owner), 'bin/nyc.js');
const sha = value => createHash('sha256').update(value).digest('hex');

for (const cell of ['empty-required', 'other-measured', 'selected-initialized', 'selected-uninitialized']) {
  test(`actual ordinary NYC template selection: ${cell}`, { timeout: 20000 }, async t => {
    const root = await mkTempRoot(`native-template-nyc-${cell}-`);
    const include = cell === 'empty-required' ? [] : cell === 'other-measured' ? [other] : [canonical];
    const config = { cwd: repo, all: true, include,
      exclude: include.length ? ['tests/desk/mcp/__tests__/**', 'plugins/desk/mcp/node_modules/**'] : ['**'],
      extension: ['.js', '.cjs'], cache: false, checkCoverage: false,
      reporter: ['json'], reportDir: path.join(root, 'report'), tempDir: path.join(root, 'raw') };
    const configFile = path.join(root, 'nyc.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const staged = path.join(root, 'desk-native-relay.cjs');
    fs.copyFileSync(path.join(repo, canonical), staged);
    const child = spawnSync(process.execPath, [bin, '--cwd', repo, '--nycrc-path', configFile,
      process.execPath, '--import', fileURLToPath(new URL('../_isolated_env.mjs', import.meta.url)),
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
    assert.equal(receipt.sourceSha256, sha(fs.readFileSync(path.join(repo, canonical))));
    t.diagnostic(JSON.stringify({ driverPid: child.pid, driverExit: child.status,
      configSha256: sha(JSON.stringify(config)), ...receipt }));
  });
}
