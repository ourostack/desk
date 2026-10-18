"use strict";

// Test-only resource-context compilation, not a production loader.
// Stage and canonical bytes must be identical. Under the running declared NYC
// dependency use its unmodified Istanbul instrumenter/configuration and share
// the collector's ordinary __coverage__ object. Counter maps/positions are
// produced by Istanbul from those exact bytes, never manufactured or rewritten.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../../../../../plugins/desk/mcp");
const names = {
  "desk-extension-credential.cjs": "web-extension-credential.cjs",
  "desk-native-relay.cjs": "web-native-relay.cjs",
  "desk-native-error-transport.cjs": "web-native-error-transport.cjs",
  "web-extension-credential.cjs": "web-extension-credential.cjs",
  "web-native-relay.cjs": "web-native-relay.cjs",
  "web-native-error-transport.cjs": "web-native-error-transport.cjs",
  "web-playwright-patch.cjs": "web-playwright-patch.cjs",
};

function loadTemplate(runtimeFile, context) {
  const canonical = path.join(root, names[path.basename(runtimeFile)]);
  const bytes = fs.readFileSync(runtimeFile);
  assert.deepEqual(bytes, fs.readFileSync(canonical), "execute unchanged actual template bytes");
  let source = bytes.toString("utf8");
  if (process.env.NYC_CONFIG) {
    // NYC is a declared MCP devDependency. A relocated retained invocation can
    // resolve from its actual loaded module, without an extra dependency/env
    // locator or installation. This cache lookup locates tooling, never code
    // under test or a production/native client.
    const filename = Object.keys(require.cache).find(file => /[/\\]nyc[/\\]index\.js$/.test(file));
    assert.ok(filename, "running NYC loaded its standard instrumenter owner");
    const NYC = require(filename);
    const nyc = new NYC(JSON.parse(process.env.NYC_CONFIG));
    // Match NYC's own _maybeInstrumentSource boundary, not collector presence.
    // An empty ordinary producer legitimately selects no JS/CJS source.
    if (nyc.exclude.shouldInstrument(canonical)) {
      const instrumenter = nyc.instrumenter();
      source = instrumenter.instrumentSync(source, canonical, { registerMap() {} });
      assert.ok(global.__coverage__, "ordinary NYC collector already initialized by normal module imports");
      const existing = global.__coverage__[canonical], generated = instrumenter.lastFileCoverage();
      if (existing) for (const key of ["statementMap", "fnMap", "branchMap"])
        assert.equal(JSON.stringify(generated[key]), JSON.stringify(existing[key]), "standard canonical source-position identity");
      context.__coverage__ = global.__coverage__;
    }
  }
  vm.runInNewContext(source, context, { filename: canonical });
  return context.module.exports;
}

module.exports = { loadTemplate };
