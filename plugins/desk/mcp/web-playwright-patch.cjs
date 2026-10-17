"use strict";

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var REVISION = 4;
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
function patchLegacySource(source) {
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

// Full, independently reviewed regions from the supplied maintained library.
// Each transform reverses only its complete known edits, then hashes the whole
// original region. Partial edits and arbitrary desk-* blocks never normalize.
var ERROR_REGIONS = [
  ["var init_browserBackend = __esm({", "\n// packages/playwright-core/src/tools/backend/common.ts",
    "024e7dcae1350fc0c5afa4f71f1e9405081c0fcf8c5e63d980319ed6e3287c34"],
  ["async function startCliDaemonServer(", "\nasync function saveSessionFile(",
    "b4b6608dc24505cc41c1ede77e96ae00426cd5ed52dc85652f0b933a399b4543"],
  ["function decorateProgram3(program4) {", "\nfunction defaultConfigFile(",
    "becf9648f7de7d20e50d02350c886bffa538e8d66c7dc809874f5db0a497f638"],
  ["function createSessionConfig(", "\nvar import_fs67, import_net10, import_path63;",
    "b46fb243926574fbeacb1832adc19a7910413b62d5bcda4e61e655f6c6932985"]
];
var SESSION_REGION = ["  static async startDaemon(", "\n  async _stopDaemon()",
  "1086c0f0f2fedc452761a5870bbf93512f58a743152ffe6bbf3222d12e71331c"];
var NATIVE_DETECTION = [
  "    let deskNativePresent = false;",
  "    if (options.config) {",
  '      try { const config = JSON.parse(require("fs").readFileSync(options.config, "utf8")); deskNativePresent = !!config && Object.prototype.hasOwnProperty.call(config, "deskNativeContext"); }',
  '      catch (_) { process.stderr.write("NATIVE_ERROR_TRANSPORT_UNCONFIRMED\\n"); gracefullyProcessExitDoNotHang(1); return; }',
  "    }"
].join("\n") + "\n";
var NATIVE_ACTION = [
  "    if (deskNativePresent) {",
  '      const deskCodec = require("./desk-native-error-transport.cjs");',
  '      let deskScope, deskStage = "launch.config";',
  "      try {",
  "        const launch = deskCodec.forLaunch({ config: options.config, session: sessionName, browser: options.browser }, clientInfo);",
  "        deskScope = launch.scope;",
  "        launch.validate();",
  "        const nativeConfig = await resolveCLIConfigForCLI(clientInfo.daemonProfilesDir, sessionName, options);",
  "        deskScope = deskCodec.forDaemon(nativeConfig, sessionName);",
  "        deskCodec.sessionStamp(deskScope);",
  '        deskStage = "launch.acquire";',
  "        const { browser, browserInfo: browserInfo2, ownership, idleTimer } = await createBrowserWithInfo(nativeConfig, { cwd: process.cwd(), clientName: guessClientName() }, options, { title: sessionName, workspaceDir: clientInfo.workspaceDir });",
  "        const browserContext = nativeConfig.browser.isolated ? await browser.newContext(nativeConfig.browser.contextOptions) : browser.contexts()[0];",
  '        if (!browserContext) throw new Error("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");',
  "        const persistent = options.persistent || options.profile || nativeConfig.browser.userDataDir ? true : void 0;",
  '        deskStage = "launch.backend";',
  "        await startCliDaemonServer(sessionName, browserContext, browserInfo2, nativeConfig, clientInfo, { cwd: process.cwd(), clientName: guessClientName() }, { persistent, exitOnClose: true, ownership, idleTimer, deskNativeStage: (stage) => { deskStage = stage; } });",
  '        await deskCodec.writeLaunch(deskScope, { version: 1, kind: "ready", contextId: deskScope.contextId, sourceGeneration: deskScope.sourceGeneration, stage: "launch.ready", requestId: null });',
  "      } catch (error) {",
  "        try {",
  '          if (!deskScope) throw new Error("NATIVE_ERROR_TRANSPORT_UNCONFIRMED");',
  "          await deskCodec.writeLaunch(deskScope, deskCodec.project(error, deskScope, { stage: deskStage, requestId: null }));",
  '        } catch (_) { process.stderr.write("NATIVE_ERROR_TRANSPORT_UNCONFIRMED\\n"); }',
  "        gracefullyProcessExitDoNotHang(1);",
  "      }",
  "      return;",
  "    }"
].join("\n") + "\n";
function errorEdits(index) {
  if (index === 0) return [
    ["        this._idleTimer = options.idleTimer;",
      '        this._idleTimer = options.idleTimer;\n        this._deskNativeCodec = Object.prototype.hasOwnProperty.call(config, "deskNativeContext") ? require("./desk-native-error-transport.cjs") : undefined;\n' +
      '        this._deskNativeErrorScope = this._deskNativeCodec?.forDaemon(config, config.deskNativeContext?.contextId);\n        if (this._deskNativeErrorScope) this._deskNativeCodec.sessionStamp(this._deskNativeErrorScope);'],
    ['        await this._context?.dispose().catch((e) => debug10("pw:tools:error")(e));\n        await this._disposeCallback?.().catch((e) => debug10("pw:tools:error")(e));',
      '        const deskCleanup = {};\n        const deskObserveCleanup = (e) => {\n          debug10("pw:tools:error")(e);\n          if (this._deskNativeErrorScope) this._deskNativeCodec.markResult(deskCleanup, e, this._deskNativeErrorScope);\n        };\n' +
      '        await this._context?.dispose().catch(deskObserveCleanup);\n        await this._disposeCallback?.().catch(deskObserveCleanup);\n        if (this._deskNativeErrorScope) {\n          const failure = this._deskNativeCodec.takeResult(deskCleanup, this._deskNativeErrorScope);\n          if (failure) throw failure;\n        }'],
    ["        let responseObject;", "        let responseObject;\n        const deskErrorBox = {};"],
    ["          for (const reason of context.drainPendingUnhandledRejections())\n            response2.addError(formatRejectionReason(reason));",
      "          for (const reason of context.drainPendingUnhandledRejections()) {\n            if (this._deskNativeErrorScope) this._deskNativeCodec.markResult(deskErrorBox, reason, this._deskNativeErrorScope);\n            response2.addError(formatRejectionReason(reason));\n          }"],
    ['          const messages = [String(error), ...context.drainPendingUnhandledRejections().map(formatRejectionReason)];',
      '          if (this._deskNativeErrorScope) this._deskNativeCodec.markResult(deskErrorBox, error, this._deskNativeErrorScope);\n          const deskPending = context.drainPendingUnhandledRejections();\n          if (this._deskNativeErrorScope) for (const reason of deskPending) this._deskNativeCodec.markResult(deskErrorBox, reason, this._deskNativeErrorScope);\n          const messages = [String(error), ...deskPending.map(formatRejectionReason)];'],
    ["        if (this._disconnected || responseObject.isClose) {",
      "        if (this._deskNativeErrorScope) {\n          const failure = this._deskNativeCodec.takeResult(deskErrorBox, this._deskNativeErrorScope);\n          if (failure) this._deskNativeCodec.markResult(responseObject, failure, this._deskNativeErrorScope);\n        }\n        if (this._disconnected || responseObject.isClose) {"],
    ["          await this.dispose();",
      "          try { await this.dispose(); } catch (error) {\n            if (!this._deskNativeErrorScope) throw error;\n            this._deskNativeCodec.markResult(responseObject, error, this._deskNativeErrorScope);\n          }"]
  ];
  if (index === 1) return [
    ["  const sessionConfig = createSessionConfig(clientInfo, sessionName, browserInfo2, options);",
      '  const deskCodec = Object.prototype.hasOwnProperty.call(contextConfig, "deskNativeContext") ? require("./desk-native-error-transport.cjs") : undefined;\n' +
      "  const deskScope = deskCodec?.forDaemon(contextConfig, sessionName);\n  const sessionConfig = createSessionConfig(clientInfo, sessionName, browserInfo2, deskScope ? { ...options, deskNativeErrorScope: deskScope } : options);"],
    ["  await backend.initialize(mcpClientInfo);",
      '  if (deskScope) options.deskNativeStage?.("launch.backend");\n  await backend.initialize(mcpClientInfo);'],
    ["      const { id, method, params: params2 } = message;",
      "      const { id, method, params: params2 } = message;\n      if (deskScope && (!Number.isSafeInteger(id) || id <= 0)) return;"],
    ["          await connection.send({ id, result: formatResult(response2) });",
      '          const failure = deskScope && deskCodec.takeResult(response2, deskScope);\n          await connection.send(failure ? { id, error: deskCodec.project(failure, deskScope, { stage: "command", requestId: id }) } : { id, result: formatResult(response2) });'],
    ["        const error = process.env.PWDEBUGIMPL ? e.stack || e.message : e.message;",
      '        const error = deskScope ? deskCodec.project(e, deskScope, { stage: method === "stop" ? "stop" : "command", requestId: id }) : process.env.PWDEBUGIMPL ? e.stack || e.message : e.message;'],
    ["  await new Promise((resolve, reject) => {", '  if (deskScope) options.deskNativeStage?.("launch.publish");\n  await new Promise((resolve, reject) => {']
  ];
  if (index === 2) return [["    const mcpConfig = await resolveCLIConfigForCLI(clientInfo.daemonProfilesDir, sessionName, options);",
    NATIVE_DETECTION + NATIVE_ACTION + "    const mcpConfig = await resolveCLIConfigForCLI(clientInfo.daemonProfilesDir, sessionName, options);"]];
  return [["    name: sessionName,", '    name: sessionName,\n    ...(options.deskNativeErrorScope ? { deskNativeErrorTransport: require("./desk-native-error-transport.cjs").sessionStamp(options.deskNativeErrorScope) } : {}),']];
}
function patchExact(source, specification, edits) {
  var area = region(source, specification[0], specification[1]);
  var normalized = normalizeEdits(area.text, edits).text;
  if (hash(normalized) !== specification[2]) throw unsupported();
  edits.forEach(function (edit) {
    // The complete pinned original and fixed edit table prove this anchor's
    // unique occurrence. Qualification never depends on an unpinned body.
    normalized = normalized.replace(edit[0], edit[1]);
  });
  return source.slice(0, area.start) + normalized + source.slice(area.end);
}
function patchSource(source) {
  var errorStates = ERROR_REGIONS.map(function (specification, index) {
    return normalizeEdits(region(source, specification[0], specification[1]).text, errorEdits(index)).native;
  });
  if (errorStates.some(Boolean) && (!errorStates.every(Boolean) || count(source, NATIVE_PREFIX) !== 1))
    throw unsupported();
  source = patchLegacySource(source);
  ERROR_REGIONS.forEach(function (specification, index) { source = patchExact(source, specification, errorEdits(index)); });
  return source;
}
function sessionFile(dir) { return path.join(dir, "node_modules/playwright-core/lib/tools/cli-client/session.js"); }
function patchSessionSource(source) {
  var area = region(source, SESSION_REGION[0], SESSION_REGION[1]);
  var start = "  static async startDaemon(clientInfo, cliArgs, mode) {\n";
  // Argument construction is retained verbatim from the hash-qualified method.
  var original = area.text, insertedStart = "    // Desk native error transport revision 4.\n";
  var insertedEnd = "    // End Desk native error transport revision 4.\n";
  if (count(original, insertedStart) || count(original, insertedEnd)) {
    var begin = original.indexOf(insertedStart), finish = original.indexOf(insertedEnd, begin);
    if (count(original, insertedStart) !== 1 || count(original, insertedEnd) !== 1 || begin !== start.length || finish < begin) throw unsupported();
    var candidate = original.slice(0, begin) + original.slice(finish + insertedEnd.length);
    // Reconstruct the one exact approved insertion, not arbitrary block removal.
    if (hash(candidate) !== SESSION_REGION[2] || patchSessionSource(source.slice(0, area.start) + candidate + source.slice(area.end)) !== source) throw unsupported();
    return source;
  }
  if (hash(original) !== SESSION_REGION[2]) throw unsupported();
  var argumentStart = original.indexOf("    const args = ["), argumentEnd = original.indexOf("    const child = ", argumentStart);
  var argumentsSource = original.slice(argumentStart, argumentEnd);
  var block = insertedStart + [
    "    let deskNativePresent = false;",
    "    if (cliArgs.config) {",
    '      try { const config = JSON.parse(import_fs.default.readFileSync(cliArgs.config, "utf8")); deskNativePresent = !!config && Object.prototype.hasOwnProperty.call(config, "deskNativeContext"); }',
    '      catch (_) { throw Object.assign(new Error("NATIVE_ERROR_TRANSPORT_UNCONFIRMED"), { code: "NATIVE_ERROR_TRANSPORT_UNCONFIRMED", resources: { disposition: "unknown" } }); }',
    "    }",
    "    if (deskNativePresent) {",
    '      const deskCodec = require("../../desk-native-error-transport.cjs");',
    "      const reader = deskCodec.forLaunch(cliArgs, clientInfo);",
    "      let child, deskFailure;",
    "      const onData = (bytes) => reader.push(bytes);",
    "      const onEnd = () => reader.end();",
    "      try {",
    "        reader.validate();",
    "        const err = reader.openErrorLog();",
    '        const cliPath = (0, import_package.libPath)("entry", "cliDaemon.js");',
    "        const sessionName = (0, import_registry.resolveSessionName)(cliArgs.session);",
    argumentsSource.trimEnd(),
    '        try { child = (0, import_child_process.spawn)(process.execPath, args, { detached: true, stdio: ["ignore", "pipe", err], cwd: process.cwd(), windowsHide: true }); }',
    "        catch (_) { reader.end(); await reader.wait(); }",
    '        child.stdout.on("data", onData); child.stdout.on("end", onEnd); child.stdout.on("error", onEnd);',
    '        child.on("error", onEnd); child.on("close", onEnd);',
    '        process.on("SIGINT", onEnd); process.on("SIGTERM", onEnd);',
    "        await reader.wait();",
    "        return { pid: child.pid, sessionName, endpoint: cliArgs.endpoint };",
    "      } catch (error) { deskFailure = error; throw error; } finally {",
    "        const cleanupError = reader.dispose();",
    '        process.off("SIGINT", onEnd); process.off("SIGTERM", onEnd);',
    "        if (child) {",
    '          child.stdout.off("data", onData); child.stdout.off("end", onEnd); child.stdout.off("error", onEnd);',
    '          child.off("error", onEnd); child.off("close", onEnd);',
    "          child.stdout.destroy(); child.unref();",
    "        }",
    "        if (cleanupError) {",
    "          if (!deskFailure) throw cleanupError;",
    '          const projected = deskCodec.project(cleanupError, reader.scope, { stage: "launch.publish", requestId: null });',
    "          deskFailure.relatedErrors = (deskFailure.relatedErrors || []).concat([{ code: projected.code, message: projected.message, resources: projected.resources }]);",
    "        }",
    "      }",
    "    }"
  ].join("\n") + "\n" + insertedEnd;
  return source.slice(0, area.start) + original.replace(start, start + block) + source.slice(area.end);
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
  var patchedSession, originalSession;
  try {
    originalSession = fs.readFileSync(sessionFile(installed.dir), "utf8");
    patchedSession = patchSessionSource(originalSession);
  }
  catch (error) { if (error.code === "ENOENT") throw unsupported(); throw error; }
  var coreNative = region(source, ERROR_REGIONS[2][0], ERROR_REGIONS[2][1]).text.indexOf(NATIVE_ACTION) !== -1;
  if (coreNative !== (patchedSession === originalSession)) throw unsupported();
  var helper = require("./web-extension-credential.cjs"), root = fs.realpathSync(__dirname);
  var modules = helper.nativeInventory(root);
  var credential = helper.publicCode(root, "web-extension-credential.cjs");
  var nativeHelper = helper.publicCode(root, "web-native-relay.cjs");
  var errorCodec = helper.publicCode(root, "web-native-error-transport.cjs");
  var capture = captureNativeDiscoveryInputs(process.platform, process.env, require("os").userInfo().homedir);
  helper.privateGeneration(installed.dir);
  fs.writeFileSync(path.join(path.dirname(file), CREDENTIAL_FILE), credential);
  fs.writeFileSync(path.join(path.dirname(file), "desk-native-relay.cjs"), nativeHelper);
  fs.writeFileSync(path.join(path.dirname(file), "desk-native-error-transport.cjs"), errorCodec);
  fs.writeFileSync(file, patched);
  fs.writeFileSync(sessionFile(installed.dir), patchedSession);
  fs.writeFileSync(path.join(installed.dir, "playwright-patch.json"), JSON.stringify({
    revision: REVISION, mcpVersion: installed.version, coreVersion: installed.core, bundleSha256: hash(patched), credentialSha256: hash(credential),
    nativeHelperSha256: hash(nativeHelper), patchSourceSha256: hash(helper.publicCode(root, "web-playwright-patch.cjs")),
    nativeRuntime: { version: 1, mcpRoot: root, modules: modules, discoveryInputs: capture },
    guardedRegionProofs: guardedRegionProofs(patched),
    errorCodecSha256: hash(errorCodec), sessionSha256: hash(patchedSession),
    errorRegionProofs: { core: ERROR_REGIONS.map(function (entry) {
      return { original: entry[2], patched: hash(region(patched, entry[0], entry[1]).text) };
    }), session: { original: SESSION_REGION[2], patched: hash(region(patchedSession, SESSION_REGION[0], SESSION_REGION[1]).text) } }
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
    var sessionSource = fs.readFileSync(sessionFile(installed.dir), "utf8");
    if (patchSessionSource(sessionSource) !== sessionSource) return 0;
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
  captureNativeDiscoveryInputs: captureNativeDiscoveryInputs, patchSessionSource: patchSessionSource };
