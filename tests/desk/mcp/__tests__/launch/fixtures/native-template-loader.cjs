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
  "browser-context.cjs": "browser-context.cjs",
  "browser-context-common.cjs": "browser-context-common.cjs",
  "web.cjs": "web.cjs",
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
  let instrumented = false;
  if (process.env.NYC_CONFIG) {
    // NYC is a declared MCP devDependency. A relocated retained invocation can
    // resolve from its actual loaded module, without an extra dependency/env
    // locator or installation. This cache lookup locates tooling, never code
    // under test or a production/native client.
    const filename = Object.keys(require.cache).find(file => /[/\\]nyc[/\\]index\.js$/.test(file));
    assert.ok(filename, "running NYC loaded its standard instrumenter owner");
    const NYC = require(filename);
    const nyc = new NYC(JSON.parse(process.env.NYC_CONFIG));
    if (nyc.exclude.shouldInstrument(canonical)) {
      const instrumenter = nyc.instrumenter();
      source = instrumenter.instrumentSync(source, canonical, { registerMap() {} });
      const existing = global.__coverage__ && global.__coverage__[canonical], generated = instrumenter.lastFileCoverage();
      if (existing) for (const key of ["statementMap", "fnMap", "branchMap"])
        assert.equal(JSON.stringify(generated[key]), JSON.stringify(existing[key]), "standard canonical source-position identity");
      if (global.__coverage__) context.__coverage__ = global.__coverage__;
      instrumented = true;
    }
  }
  vm.runInNewContext(source, context, { filename: canonical });
  if (instrumented && !global.__coverage__) {
    assert.ok(context.__coverage__, "standard Istanbul template execution initialized its ordinary collector");
    global.__coverage__ = context.__coverage__;
  }
  return context.module.exports;
}

module.exports = { loadTemplate };
