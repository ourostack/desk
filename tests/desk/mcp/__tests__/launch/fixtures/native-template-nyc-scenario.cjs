"use strict";
// Actual NYC subprocess, never a fabricated collector/configuration owner.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadTemplate } = require("./native-template-loader.cjs");
const root = path.resolve(__dirname, "../../../../../../plugins/desk/mcp");
const canonical = path.join(root, "web-native-relay.cjs");
const other = path.join(root, "web-native-artifacts.cjs");
const cell = process.argv[2];
const staged = process.argv[3];
assert.equal(process.argv.length, 4, "scenario argv carries only cell and owned staged-source path");
assert.ok(Object.hasOwn(process.env, "DESK_TEST_PARENT_NODE_OPTIONS"), "private inherited-preload reference is present");
assert.ok((process.env.NODE_OPTIONS || "").includes(process.env.DESK_TEST_PARENT_NODE_OPTIONS),
  "all inherited parent preloads remain present");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceSha256 = hash(fs.readFileSync(canonical));
const owner = Object.keys(require.cache).find(file => /[/\\]nyc[/\\]index\.js$/.test(file));
assert.ok(owner, "real NYC is the owner of this invocation");
const nyc = new (require(owner))(JSON.parse(process.env.NYC_CONFIG));
const selected = nyc.exclude.shouldInstrument(canonical);
assert.equal(selected, cell.startsWith("selected-"));
if (cell === "other-measured") require(other);
if (cell === "selected-initialized") require(canonical); // Genuine normal import initializes the collector.
const collector = global.__coverage__;
const coverage = collector && collector[canonical];
const mapHash = value => value ? hash(JSON.stringify([value.statementMap, value.fnMap, value.branchMap])) : null;
const originalMap = mapHash(coverage);
const context = { module: { exports: {} }, require, __dirname: root };

async function main() {
  if (cell === "selected-uninitialized") {
    assert.equal(collector, undefined);
    assert.throws(() => loadTemplate(staged, context), /ordinary NYC collector already initialized/);
    assert.equal(global.__coverage__, undefined, "the refusal cannot initialize a fake collector");
  } else {
    const result = loadTemplate(staged, context);
    assert.equal(typeof result.initialize, "function");
    await assert.rejects(result.initialize(null), { code: "NATIVE_CONFIG_INVALID" });
    if (selected) {
      assert.equal(context.__coverage__, collector);
      assert.equal(global.__coverage__, collector);
      assert.equal(mapHash(collector[canonical]), originalMap, "unaltered standard source-map identity");
    } else {
      assert.equal(Object.hasOwn(context, "__coverage__"), false, "unselected source is not instrumented in its VM");
      assert.equal(global.__coverage__, collector);
      assert.equal(collector && Object.hasOwn(collector, canonical), collector ? false : undefined);
    }
  }
  if (cell === "empty-required") assert.equal(global.__coverage__, undefined);
  if (cell === "other-measured") assert.ok(collector[other], "a real independently selected module remains measured");
  const tampered = path.join(path.dirname(staged), "tampered", "desk-native-relay.cjs");
  fs.mkdirSync(path.dirname(tampered));
  fs.writeFileSync(tampered, fs.readFileSync(canonical, "utf8") + "\n// owned byte drift\n");
  assert.throws(() => loadTemplate(tampered, { module: { exports: {} }, require }),
    /execute unchanged actual template bytes/);
  process.stdout.write(JSON.stringify({ cell, pid: process.pid, nycProcessId: process.env.NYC_PROCESS_ID,
    sourceSha256, selected, collectorInitialized: Boolean(collector),
    canonicalMapSha256: mapHash(collector && collector[canonical]),
    preloadSha256: hash(JSON.stringify({ NODE_OPTIONS: process.env.NODE_OPTIONS, execArgv: process.execArgv })) }) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
