"use strict";

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var REVISION = 3;
var CREDENTIAL_FILE = "desk-extension-credential.cjs";
// Audited createServer from playwright-core 1.64.0-alpha-1790635538000.
// Match the lifecycle, not a package version: newer packages may retain this implementation.
var ORIGINAL_SHA256 = "0a0d6cd9bfae79dbda66509b6d01fad89fdc37629cc729e26db7b97d80b8fc4b";
var START = "function createServer(name, version3, factory, transportInitialized, runHeartbeat) {";
var END = "\nfunction addServerListener(";
var ANCHOR = "    try {\n";
var ACQUISITION_START = "async function createExtensionBrowser(channel, executablePath, customUserDataDir, profileDirName, clientName) {";
var ACQUISITION_END = "\nvar import_path60, debug16, debugLogger3;";
var ACQUISITION_SHA256 = "e014782f47d440a616b852b8a5838d4d49a2d2c458a5eba2b3ecd70ae5fe91ca";
var ACQUISITION_ANCHOR = "  const relay = new CDPRelayServer(";
var INITIALIZE_CREDENTIAL = '  await require("./' + CREDENTIAL_FILE + '").initialize(customUserDataDir, profileDirectory);\n';
var BROWSER_START = "async function createBrowser(config,";
var BROWSER_END = "\nasync function connectToBrowserEndpoint(";
var BROWSER_SHA256 = "b4976bd9fda5aa82d853428acf2ff586fa16dae44b605649bd2652dd89759d0e";
var RELAY_START = "    CDPRelayServer = class {";
var RELAY_END = "\n    ExtensionConnection = class {";
var RELAY_SHA256 = "0c01234faaad68848d096c87c384a4a9318bdab8a5aef964824498b7e64751e5";
var BROWSER_PREFLIGHT = [
  '  const deskNativeBinding = Object.prototype.hasOwnProperty.call(config, "deskNativeContext")',
  '    ? require("./desk-extension-credential.cjs").validateNativeBinding(config.deskNativeContext, {',
  '        extension: config.extension, browser: config.browser, options: resolveExtensionOptions(cliOptions)',
  '      }) : undefined;',
].join("\n") + "\n";
// Exact complete E3 prefix at 76396fb8; only this known prior candidate and the
// fixed prefix normalize. Never strip arbitrary native blocks.
var LEGACY_NATIVE_PREFIX = [
  'async function createExtensionBrowser(channel, executablePath, customUserDataDir, profileDirName, clientName, deskNativeContext) {',
  '  if (deskNativeContext !== undefined) {',
  '    const deadline = monotonicTime() + 30000;',
  '    const binding = require("./desk-extension-credential.cjs").validateNativeBinding(deskNativeContext, {',
  '      extension: true, browserName: "chromium", channel, executablePath,',
  '      userDataDir: customUserDataDir, profileDirName',
  '    });',
  '    const acquisition = await require("./desk-native-relay.cjs").initialize(binding.record, binding.selection, { deadline, now: monotonicTime });',
  '    binding.retain(acquisition);',
  '    let relay;',
  '    try {',
  '      relay = new CDPRelayServer(channel, binding.selection.browserExecutable, customUserDataDir, profileDirName, acquisition);',
  '      await relay.start();',
  '      debugLogger3("Native relay acquisition");',
  '      await relay.establishExtensionConnection(clientName);',
  '      const remaining = deadline - monotonicTime();',
  '      if (remaining <= 0) throw Object.assign(new Error("NATIVE_HANDSHAKE_TIMEOUT"), { code: "NATIVE_HANDSHAKE_TIMEOUT" });',
  '      const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: remaining, noDefaults: true });',
  '      browser.on("disconnected", () => { acquisition.retire(); relay.stop(); });',
  '      return browser;',
  '    } catch (error) {',
  '      acquisition.retire();',
  '      relay?.stop();',
  '      throw acquisition.failure(error);',
  '    }',
  '  }',
].join("\n") + "\n";
var NATIVE_PREFIX = LEGACY_NATIVE_PREFIX
  .replace("await relay.start();", "await acquisition.start(relay);")
  .replace("await relay.establishExtensionConnection(clientName);", 'await acquisition.waitFor(relay.establishExtensionConnection(clientName), "extension.handshake");')
  .replace("await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: remaining, noDefaults: true });",
    'await acquisition.waitFor(playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: remaining, noDefaults: true }), "cdp.connect");')
  .replace("acquisition.retire(); relay.stop();", "acquisition.retire();")
  .replace("      relay?.stop();\n", "");
var RELAY_EDITS = [
  ["constructor(browserChannel, executablePath, customUserDataDir, profileDirectory) {",
    "constructor(browserChannel, executablePath, customUserDataDir, profileDirectory, deskNativeAcquisition) {\n        this._nativeAcquisition = deskNativeAcquisition;"],
  ["this._protocolVersion = parseInt(process.env.PWTEST_EXTENSION_PROTOCOL ?? VERSION.toString(), 10);",
    "this._protocolVersion = this._nativeAcquisition ? VERSION : parseInt(process.env.PWTEST_EXTENSION_PROTOCOL ?? VERSION.toString(), 10);"],
  ["this._token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;",
    "this._token = this._nativeAcquisition ? undefined : process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;"],
  ['this._extensionPath = `/extension/${uuid}`;',
    'this._extensionPath = `/extension/${uuid}`;\n        if (this._nativeAcquisition) this._nativeAcquisition.protectPaths(this._cdpPath, this._extensionPath);'],
  ['this._wsHost = await this._wsServer.listen(0, void 0, "");',
    'this._wsHost = await this._wsServer.listen(0, void 0, "");\n        if (this._nativeAcquisition) this._nativeAcquisition.protectEndpoints(this.cdpEndpoint(), this.extensionEndpoint());'],
  ["const deadline = this._token ? monotonicTime() + extensionConnectionTimeout : 0;",
    "const deadline = this._nativeAcquisition ? this._nativeAcquisition.deadline : this._token ? monotonicTime() + extensionConnectionTimeout : 0;"],
  ["if (timedOut) {\n          const profile", 'if (timedOut) {\n          if (this._nativeAcquisition) throw this._nativeAcquisition.failure({ code: "NATIVE_HANDSHAKE_TIMEOUT" });\n          const profile'],
  ["async _openConnectPageInBrowser(clientName) {",
    "async _openConnectPageInBrowser(clientName) {\n        if (this._nativeAcquisition) return await this._nativeAcquisition.connect(this.extensionEndpoint());"]
];
var IDLE_CLOSE = [
  '      if (!backendPromise && request2.params.name === "browser_close") {',
  '        const closeTool = factory.toolSchemas.find((tool) => tool.name === "browser_close");',
  "        if (closeTool) {",
  "          const args = request2.params.arguments || {};",
  "          const json = !!args._meta?.json;",
  "          try {",
  "            closeTool.inputSchema.parse(args);",
  "          } catch (error) {",
  "            if (!(error instanceof zod.ZodError))",
  "              throw error;",
  '            const message = `Invalid arguments for tool "browser_close":\\n${zod.prettifyError(error)}`;',
  '            return { content: [{ type: "text", text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : "### Error\\n" + message }], isError: true };',
  "          }",
  '          const result = "No browser session is open.";',
  '          const text = json ? JSON.stringify({ result }, null, 2) : args._meta?.raw ? result : "### Result\\n" + result;',
  '          return { content: [{ type: "text", text }] };',
  "        }",
  "      }"
].join("\n") + "\n";

function unsupported() {
  var error = new Error("Unsupported Playwright MCP server lifecycle; the staged browser install was not published.");
  error.code = "PLAYWRIGHT_PATCH_UNSUPPORTED";
  return error;
}

function patchLifecycle(source) {
  var start = source.indexOf(START);
  var end = source.indexOf(END, start);
  if (start < 0 || end < 0 || source.indexOf(START, start + START.length) !== -1) throw unsupported();
  var lifecycle = source.slice(start, end);
  var original = lifecycle;
  var alreadyPatched = lifecycle.indexOf(IDLE_CLOSE) !== -1;
  if (alreadyPatched) {
    original = lifecycle.replace(IDLE_CLOSE, "");
    if (original.indexOf(IDLE_CLOSE) !== -1) throw unsupported();
  }
  if (crypto.createHash("sha256").update(original).digest("hex") !== ORIGINAL_SHA256) throw unsupported();
  if (alreadyPatched) return source;
  var patched = original.replace(ANCHOR, ANCHOR + IDLE_CLOSE);
  return source.slice(0, start) + patched + source.slice(end);
}

function region(source, startMarker, endMarker) {
  var start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0 || source.indexOf(startMarker, start + startMarker.length) !== -1) throw unsupported();
  return { start: start, end: end, text: source.slice(start, end) };
}
function count(source, text) { return source.split(text).length - 1; }
function normalizeEdits(text, edits) {
  var applied = edits.filter(function (edit) { return count(text, edit[1]) === 1; }).length;
  if (applied && applied !== edits.length) throw unsupported();
  if (applied) edits.slice().reverse().forEach(function (edit) { text = text.replace(edit[1], edit[0]); });
  return { text: text, native: !!applied };
}
function patchSource(source) {
  // Validate/compute lifecycle first, but retain the original source for the
  // mixed/partial-revision checks; publish no transformation until all qualify.
  var lifecycle = patchLifecycle(source);
  var server = region(source, START, END);
  var acquisition = region(source, "async function createExtensionBrowser(", ACQUISITION_END);
  var browser = region(source, BROWSER_START, BROWSER_END);
  var relay = region(source, RELAY_START, RELAY_END);
  var originalAcquisition = acquisition.text;
  var nativeAcquisition = count(originalAcquisition, NATIVE_PREFIX) === 1;
  var legacyAcquisition = count(originalAcquisition, LEGACY_NATIVE_PREFIX) === 1;
  if (count(originalAcquisition, INITIALIZE_CREDENTIAL) && count(server.text, IDLE_CLOSE) !== 1) throw unsupported();
  if ((nativeAcquisition || legacyAcquisition) && count(originalAcquisition, INITIALIZE_CREDENTIAL) !== 1) throw unsupported();
  if (nativeAcquisition || legacyAcquisition) originalAcquisition = originalAcquisition.replace(
    nativeAcquisition ? NATIVE_PREFIX : LEGACY_NATIVE_PREFIX, ACQUISITION_START + "\n");
  originalAcquisition = originalAcquisition.replace(INITIALIZE_CREDENTIAL, "");
  if (hash(originalAcquisition) !== ACQUISITION_SHA256) throw unsupported();
  var browserEdits = [
    ["  if (config.browser.remoteEndpoint)", BROWSER_PREFLIGHT + "  if (config.browser.remoteEndpoint)"],
    ["profileDirName, clientInfo.clientName);", "profileDirName, clientInfo.clientName, deskNativeBinding ? deskNativeBinding.record : undefined);"],
    ["    throw error;\n  }\n}", "    throw deskNativeBinding ? deskNativeBinding.failure(error) : error;\n  }\n}"]
  ];
  var browserAwaitEdits = [
    ['    const { endpoint } = await browser.bind(bindOptions.title, { workspaceDir: bindOptions.workspaceDir });',
      '    const bindOperation = browser.bind(bindOptions.title, { workspaceDir: bindOptions.workspaceDir });\n' +
      '    const { endpoint } = await (deskNativeBinding ? deskNativeBinding.waitFor(bindOperation, "browser.bind") : bindOperation);'],
    ['    await browser.close().catch(() => {\n    });',
      '    const closeOperation = browser.close();\n' +
      '    await (deskNativeBinding ? deskNativeBinding.waitFor(closeOperation, "browser.close") : closeOperation).catch(() => {\n    });']
  ];
  var originalAwait = normalizeEdits(browser.text, browserAwaitEdits);
  var originalBrowser = normalizeEdits(originalAwait.text, browserEdits);
  var originalRelay = normalizeEdits(relay.text, RELAY_EDITS);
  if (hash(originalBrowser.text) !== BROWSER_SHA256 || hash(originalRelay.text) !== RELAY_SHA256) throw unsupported();
  if ((nativeAcquisition || legacyAcquisition || originalBrowser.native || originalRelay.native || originalAwait.native) &&
      !((nativeAcquisition || legacyAcquisition) && originalBrowser.native && originalRelay.native &&
        originalAwait.native === nativeAcquisition && count(server.text, IDLE_CLOSE) === 1)) throw unsupported();
  var replacements = [
    { area: server, text: region(lifecycle, START, END).text },
    { area: acquisition, text: originalAcquisition.replace(ACQUISITION_ANCHOR, INITIALIZE_CREDENTIAL + ACQUISITION_ANCHOR)
      .replace(ACQUISITION_START + "\n", NATIVE_PREFIX) },
    { area: browser, text: originalBrowser.text },
    { area: relay, text: originalRelay.text }
  ];
  browserEdits.forEach(function (edit) { replacements[2].text = replacements[2].text.replace(edit[0], edit[1]); });
  browserAwaitEdits.forEach(function (edit) { replacements[2].text = replacements[2].text.replace(edit[0], edit[1]); });
  RELAY_EDITS.forEach(function (edit) { replacements[3].text = replacements[3].text.replace(edit[0], edit[1]); });
  replacements.sort(function (a, b) { return b.area.start - a.area.start; }).forEach(function (replacement) {
    source = source.slice(0, replacement.area.start) + replacement.text + source.slice(replacement.area.end);
  });
  return source;
}

function bundleFile(dir) {
  return path.join(dir, "node_modules", "playwright-core", "lib", "coreBundle.js");
}

function hash(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function apply(installed) {
  var file = bundleFile(installed.dir);
  var source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw unsupported();
    throw error;
  }
  var patched = patchSource(source);
  var helper = require("./web-extension-credential.cjs"), root = fs.realpathSync(__dirname);
  var modules = helper.nativeInventory(root);
  var credential = helper.publicCode(root, "web-extension-credential.cjs");
  var nativeHelper = helper.publicCode(root, "web-native-relay.cjs");
  var capture = captureNativeDiscoveryInputs(process.platform, process.env, require("os").userInfo().homedir);
  helper.privateGeneration(installed.dir);
  fs.writeFileSync(path.join(path.dirname(file), CREDENTIAL_FILE), credential);
  fs.writeFileSync(path.join(path.dirname(file), "desk-native-relay.cjs"), nativeHelper);
  fs.writeFileSync(file, patched);
  fs.writeFileSync(path.join(installed.dir, "playwright-patch.json"), JSON.stringify({
    revision: REVISION, mcpVersion: installed.version, coreVersion: installed.core, bundleSha256: hash(patched), credentialSha256: hash(credential),
    nativeHelperSha256: hash(nativeHelper), patchSourceSha256: hash(helper.publicCode(root, "web-playwright-patch.cjs")),
    nativeRuntime: { version: 1, mcpRoot: root, modules: modules, discoveryInputs: capture },
    guardedRegionProofs: guardedRegionProofs(patched)
  }) + "\n", { mode: 384 });
  helper.privateGeneration(installed.dir, path.join(installed.dir, "playwright-patch.json"));
  if (readRevision(installed) !== REVISION) throw unsupported();
}

function readRevision(installed) {
  try {
    require("./web-extension-credential.cjs").verifyGeneration(installed, __dirname);
    var source = fs.readFileSync(bundleFile(installed.dir), "utf8");
    // verifyGeneration already checks the complete receipt proof map. Exact
    // current normalization additionally rules out the known previous E3 body.
    if (patchSource(source) !== source) return 0;
    return REVISION;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError || /^NATIVE_/.test(error.code || "") ||
        error.code === "PLAYWRIGHT_PATCH_UNSUPPORTED") return 0;
    throw error;
  }
}
function guardedRegionProofs(source) {
  return [[START, END, ORIGINAL_SHA256], ["async function createExtensionBrowser(", ACQUISITION_END, ACQUISITION_SHA256],
    [BROWSER_START, BROWSER_END, BROWSER_SHA256], [RELAY_START, RELAY_END, RELAY_SHA256]].map(function (entry) {
    return { original: entry[2], patched: hash(region(source, entry[0], entry[1]).text) };
  });
}
function captureNativeDiscoveryInputs(platform, env, home) {
  return require("./web-extension-credential.cjs").captureNativeDiscoveryInputs(platform, env, home);
}

// Do not follow package symlinks into profiles, credentials or another generation.
// Promise-based copying also works when an older host Node selected a compatible child Node.
function copyPackages(fromRoot, toRoot) {
  var canonicalRoot = fs.realpathSync(fromRoot);
  function copy(from, to) {
    return fs.promises.lstat(from).then(function (stat) {
      if (stat.isDirectory()) {
        return fs.promises.mkdir(to).then(function () {
          return fs.promises.readdir(from);
        }).then(function (entries) {
          return entries.reduce(function (previous, entry) {
            return previous.then(function () { return copy(path.join(from, entry), path.join(to, entry)); });
          }, Promise.resolve());
        });
      }
      if (stat.isSymbolicLink()) {
        return Promise.all([fs.promises.readlink(from), fs.promises.realpath(from), fs.promises.stat(from)]).then(function (values) {
          var relative = path.relative(canonicalRoot, values[1]);
          if (relative === ".." || relative.indexOf(".." + path.sep) === 0 || path.isAbsolute(relative)) {
            throw new Error("Cannot migrate a browser package symlink outside its installed package tree.");
          }
          var target = path.isAbsolute(values[0]) ? path.join(toRoot, relative) : values[0];
          return fs.promises.symlink(target, to, values[2].isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file");
        });
      }
      if (stat.isFile()) return fs.promises.copyFile(from, to);
      throw new Error("Cannot migrate a non-file entry in the installed browser package tree.");
    });
  }
  return copy(fromRoot, toRoot);
}

module.exports = { REVISION: REVISION, apply: apply, copyPackages: copyPackages, patchSource: patchSource, readRevision: readRevision,
  captureNativeDiscoveryInputs: captureNativeDiscoveryInputs };
