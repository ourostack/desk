"use strict";
// SPDX-License-Identifier: Apache-2.0
// Microsoft Playwright 1.64.0-alpha-1790635538000, supplied maintained library.
// LICENSE.playwright.txt beside this fixture applies. Read only the explicitly
// supplied public runtime input, never unpublished Git objects or a live profile.
// Complete bounded regions are independently pinned to the reviewed contract.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const regions = [
  ["backend", "var init_browserBackend = __esm({", "\n// packages/playwright-core/src/tools/backend/common.ts", "024e7dcae1350fc0c5afa4f71f1e9405081c0fcf8c5e63d980319ed6e3287c34"],
  ["daemon", "async function startCliDaemonServer(", "\nasync function saveSessionFile(", "b4b6608dc24505cc41c1ede77e96ae00426cd5ed52dc85652f0b933a399b4543"],
  ["program", "function decorateProgram3(program4) {", "\nfunction defaultConfigFile(", "becf9648f7de7d20e50d02350c886bffa538e8d66c7dc809874f5db0a497f638"],
  ["metadata", "function createSessionConfig(", "\nvar import_fs67, import_net10, import_path63;", "b46fb243926574fbeacb1832adc19a7910413b62d5bcda4e61e655f6c6932985"],
  ["session", "  static async startDaemon(", "\n  async _stopDaemon()", "1086c0f0f2fedc452761a5870bbf93512f58a743152ffe6bbf3222d12e71331c"],
  ["configLoader", "async function loadConfig(configFile) {", "\nfunction resolveConfigPaths(", "adbf471d2fc29dcf8a83f03dc08aed0058361bbe5f72dc45610248afd36ad789"],
  ["configIni", "function configFromIniFile(filePath) {", "\n// packages/playwright-core/src/tools/mcp/config.ts", "4deca6f390b3931fee8cc57ed3076ed384a0f4f1e33a3077c6b749d50d0d41fa"],
  ["toolsExports", "var tools_exports = {};", "\nvar init_tools2 = __esm({", "bbbe1a73e260c1bd94c759018d09cbf8823684f4718c3e34ec3f0445d0c0c202"],
];
function read() {
  const cli = process.env.DESK_TEST_MAINTAINED_CLI_DIR;
  assert.ok(cli, "requires the admitted public maintained CLI input");
  const core = fs.readFileSync(path.resolve(cli, "../../coreBundle.js"), "utf8");
  const sessionFile = path.join(cli, "session.js");
  const session = fs.readFileSync(sessionFile, "utf8"), out = { sessionFile, sessionSource: session };
  for (const [key, begin, finish, hash] of regions) {
    const source = key === "session" ? session : core;
    const start = source.indexOf(begin), end = source.indexOf(finish, start);
    assert.ok(start >= 0 && end > start && source.indexOf(begin, start + begin.length) === -1, key);
    const text = source.slice(start, end);
    assert.equal(crypto.createHash("sha256").update(text).digest("hex"), hash, key + " exact complete source");
    out[key] = text;
  }
  // The declarations stay dormant when composed with the older four-region
  // lifecycle fixture. Behavioral tests execute the exact extracted regions
  // independently at their actual resource boundaries.
  out.core = "\nfunction auditedNativeErrorFixtureDeclarations() {\n" +
    out.backend + regions[0][2] + "\n" +
    out.daemon + regions[1][2] + ") {}\n" +
    out.program + regions[2][2] + ") {}\n" +
    out.metadata + regions[3][2] + "\n" +
    out.configLoader + "\nfunction resolveConfigPaths() {}\n" +
    out.configIni + "\n// packages/playwright-core/src/tools/mcp/config.ts\n" +
    out.toolsExports + "\nvar init_tools2 = __esm({});\n}\n";
  return out;
}
module.exports = { read, regions };
