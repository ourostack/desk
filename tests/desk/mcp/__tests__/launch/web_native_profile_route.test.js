import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkTempRoot } from "../_temp_roots.js";
import { mcpRoot } from "./_mcp_handshake.js";

const require = createRequire(import.meta.url);
const { loadTemplate } = require("./fixtures/native-template-loader.cjs");
const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"));
const id = "11111111-1111-4111-8111-111111111111";
function region(source, begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start);
  return source.slice(start, finish);
}

async function profileFixture(t, profile = "Profile 17") {
  const root = await mkTempRoot("desk-E-profile-route-"), home = path.join(root, "native-home");
  const info = os.userInfo();
  t.mock.method(os, "userInfo", () => ({ ...info, homedir: home }));
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  };
  const input = require("./fixtures/playwright-native-error-transport.cjs").read();
  const cli = path.dirname(input.sessionFile);
  const original = fs.readFileSync(path.resolve(cli, "../../coreBundle.js"), "utf8");
  assert.equal(createHash("sha256").update(original).digest("hex"),
    input.coreSha256,
    "bounded extraction is from the exact admitted full maintained source");
  const installed = { dir: path.join(root, "generation"), version: "owned-E-profile", core: null };
  const lib = path.join(installed.dir, "node_modules/playwright-core/lib");
  put(path.join(lib, "coreBundle.js"), original);
  put(path.join(lib, "tools/cli-client/session.js"), input.sessionSource);
  patch.apply(installed);
  assert.equal(patch.readRevision(installed), 4);
  const app = process.platform === "darwin" ? path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge") :
    path.join(root, "owned-browser");
  put(app, "Owned executable observation fixture; never launched.");
  const record = { version: 1, contextId: id, label: "Owned E route", channel: "msedge",
    userDataDir: path.join(root, "profile"), profileDirName: profile, nativeReadyFile: path.join(root, "ready.json"),
    extensionId: "a".repeat(32), sourceDigest: "b".repeat(64) };
  const config = { extension: true, browser: { browserName: "chromium", userDataDir: record.userDataDir,
    launchOptions: { channel: "msedge" } }, deskNativeContext: record };
  const owner = path.join(root, "owner"), configFile = path.join(owner, "config/browser.json");
  put(configFile, config);
  if (process.platform === "win32") {
    const helper = require(path.join(mcpRoot, "web-extension-credential.cjs"));
    helper.privateGeneration(owner); helper.privateGeneration(path.dirname(configFile), configFile);
  }
  const observedFs = Object.create(fs), signals = new EventEmitter(), output = [];
  const candidates = require(path.join(mcpRoot, "web-browser-discovery.cjs")).browserPaths("msedge", process.platform, process.env);
  observedFs.existsSync = file => candidates.includes(String(file)) && process.platform !== "darwin" ? true :
    path.resolve(String(file)).startsWith(root + path.sep) && fs.existsSync(file);
  observedFs.realpathSync = file => candidates.includes(String(file)) && process.platform !== "darwin" ? app : fs.realpathSync(file);
  const proc = Object.assign(signals, { ...process, env: {}, stdout: { write(bytes, callback) {
    output.push(Buffer.from(bytes)); callback?.(); return true;
  } } });
  proc.stderr = { write() { return true; } };
  const cache = new Map();
  function template(name) {
    name = path.basename(name);
    if (cache.has(name)) return cache.get(name);
    const value = loadTemplate(path.join(lib, name), { module: { exports: {} }, __dirname: lib,
      process: proc, Buffer, setTimeout, clearTimeout,
      require: name => name === "fs" ? observedFs :
        name === path.join(lib, "desk-extension-credential.cjs") || name.startsWith("./desk-") ? template(name) : require(name),
    });
    cache.set(name, value); return value;
  }
  const core = fs.readFileSync(path.join(lib, "coreBundle.js"), "utf8");
  const utils = require(path.resolve(cli, "../../utilsBundle.js"));
  const configSource = region(core, "// packages/playwright-core/src/tools/mcp/configIni.ts",
    "\n// packages/playwright-core/src/tools/mcp/log.ts");
  const configApi = vm.runInNewContext(configSource +
    "\ninit_config2(); ({ resolveCLIConfigForCLI, resolveExtensionOptions, deskNativeConfigPresent })", {
      process: proc, require: name => name === "./utilsBundle" ? utils : name === "fs" ? observedFs : require(name),
      __toESM: value => ({ default: value }),
      __esm: object => { let initialized = false; return () => { if (!initialized) { initialized = true; Object.values(object)[0](); } }; },
      init_fileUtils() {}, init_inprocess() {},
    });
  const credential = template("desk-extension-credential.cjs"), acquisitions = [];
  const checkpoint = Object.assign(new Error("owned acquisition resource boundary"), {
    code: "NATIVE_REQUEST_TIMEOUT", resources: { contextId: id, disposition: "unknown", pendingNativeOperation: true },
  });
  const create = vm.runInNewContext(region(core, "async function createBrowser(config,", "\nasync function connectToBrowserEndpoint(") +
    "\ncreateBrowser", {
      require: name => { assert.equal(name, "./desk-extension-credential.cjs"); return credential; },
      resolveExtensionOptions: configApi.resolveExtensionOptions,
      createExtensionBrowser: async (...args) => { acquisitions.push(args); throw checkpoint; },
    });
  return { root, lib, core, config, configFile, record, put, proc, output, observedFs,
    credential, template, configApi, create, acquisitions, checkpoint, utils,
    clientInfo: { daemonProfilesDir: path.join(owner, "cache/ms-playwright/daemon/owned"), workspaceDirHash: "owned", version: "owned-E-profile" },
  };
}

test("actual native preflight and extension argument path derive an absent profile only from the validated record", async t => {
  const f = await profileFixture(t);
  const options = Object.freeze({ browser: "msedge", extension: true, config: f.configFile });
  const resolved = await f.configApi.resolveCLIConfigForCLI(f.clientInfo.daemonProfilesDir, id, options);
  assert.equal(f.configApi.resolveExtensionOptions(options).profileDirName, undefined);
  await assert.rejects(f.create(resolved, {}, options, {}), error => error === f.checkpoint);
  assert.equal(f.acquisitions.length, 1);
  assert.equal(f.acquisitions[0][3], "Profile 17");
  assert.equal(f.acquisitions[0][5].profileDirName, "Profile 17");
  await assert.rejects(f.create(resolved, {}, { ...options, profileDirName: "Profile 17" }, {}), error => error === f.checkpoint);
  assert.equal(f.acquisitions[1][3], "Profile 17");
  assert.equal(Object.hasOwn(options, "profileDirName"), false);
  assert.deepEqual(f.proc.env, {}, "no profile environment workaround");
});

for (const profile of ["Wrong profile", null, "", false, 0]) {
  test(`actual native preflight refuses an explicitly supplied mismatching profile ${JSON.stringify(profile)}`, async t => {
    const f = await profileFixture(t);
    await assert.rejects(f.create(f.config, {}, { browser: "msedge", profileDirName: profile }, {}),
      { code: "NATIVE_SELECTION_MISMATCH" });
    assert.equal(f.acquisitions.length, 0);
  });
}

test("normal fixed Session argv reaches the actual daemon resolver and native acquisition without a profile flag", async t => {
  const f = await profileFixture(t), child = new EventEmitter(), parentSignals = new EventEmitter();
  child.stdout = new EventEmitter(); child.pid = 127;
  child.stdout.destroy = () => {}; child.unref = () => {};
  const codec = f.template("desk-native-error-transport.cjs");
  f.proc.stdout.write = (bytes, callback) => { queueMicrotask(() => child.stdout.emit("data", Buffer.from(bytes))); callback?.(); return true; };
  const program = f.utils.program.createCommand();
  let exit, action;
  const decorate = vm.runInNewContext(region(f.core, "function decorateProgram3(program4) {", "\nfunction defaultConfigFile(") +
    "\ndecorateProgram3", {
      require: name => { assert.equal(name, "./desk-native-error-transport.cjs"); return codec; },
      process: f.proc, numberParser: Number, setupExitWatchdog() {},
      createClientInfo: () => f.clientInfo, guessClientName: () => "owned E fixture",
      deskNativeConfigPresent: f.configApi.deskNativeConfigPresent,
      resolveCLIConfigForCLI: f.configApi.resolveCLIConfigForCLI,
      createBrowserWithInfo: f.create, gracefullyProcessExitDoNotHang: code => { exit = code; },
    });
  decorate(program);
  const sessionSource = fs.readFileSync(path.join(f.lib, "tools/cli-client/session.js"), "utf8");
  let argv;
  const Session = vm.runInNewContext("class Session {\n" +
    region(sessionSource, "  static async startDaemon(", "\n  async _stopDaemon()") + "\n}; Session", {
      process: Object.assign(parentSignals, { execPath: process.execPath, cwd: () => f.root }),
      require: name => name === "../../coreBundle.js" ? { tools: f.configApi } : codec,
      import_package: { libPath: () => path.join(f.lib, "entry/cliDaemon.js") },
      import_registry: { resolveSessionName: value => value },
      import_child_process: { spawn(_node, args) {
        argv = args;
        queueMicrotask(() => { action = program.parseAsync(args.slice(1), { from: "user" }); });
        return child;
      } },
    });
  try {
    await assert.rejects(Session.startDaemon(f.clientInfo, {
      session: id, config: f.configFile, browser: "msedge", extension: true, persistent: true, "idle-timeout": 0,
    }), { code: "NATIVE_REQUEST_TIMEOUT" });
  } finally { await action; }
  assert.equal(exit, 1);
  assert.equal(argv.some(value => value.startsWith("--profile")), false);
  assert.equal(f.acquisitions.length, 1);
  assert.equal(f.acquisitions[0][3], "Profile 17");
  assert.equal(f.acquisitions[0][5].profileDirName, "Profile 17");
  assert.equal(parentSignals.eventNames().length, 0);
  assert.equal(child.eventNames().length, 0);
  assert.equal(child.stdout.eventNames().length, 0);
});

test("profile derivation retains strict record, source and cached-binding fences before acquisition", async t => {
  const f = await profileFixture(t), route = { extension: true, browser: f.config.browser, options: { channel: "msedge" } };
  for (const record of [
    { ...f.record, profileDirName: null }, { ...f.record, profileDirName: "" },
    { ...f.record, profileDirName: "../foreign" }, { ...f.record, extra: true },
  ]) {
    assert.throws(() => f.credential.validateNativeBinding(record, route), { code: "NATIVE_CONFIG_INVALID" });
  }
  for (const mismatch of [null, "", "Wrong profile", false, 0])
    assert.throws(() => f.credential.validateNativeBinding(f.record, {
      ...route, options: { ...route.options, profileDirName: mismatch },
    }), { code: "NATIVE_SELECTION_MISMATCH" });
  const bound = f.credential.validateNativeBinding(f.record, route);
  assert.equal(bound.selection.profileDirName, "Profile 17");
  assert.equal(Object.isFrozen(bound.record), true);
  f.record.profileDirName = "Profile 23";
  await assert.rejects(f.create(f.config, {}, { browser: "msedge" }, {}), { code: "NATIVE_SELECTION_MISMATCH" });
  f.record.profileDirName = "Profile 17";
  const helperFile = path.join(f.lib, "desk-extension-credential.cjs"), original = fs.readFileSync(helperFile);
  fs.appendFileSync(helperFile, "\n// owned source drift\n");
  await assert.rejects(f.create(f.config, {}, { browser: "msedge" }, {}), { code: "NATIVE_CODE_UNAVAILABLE" });
  fs.writeFileSync(helperFile, original);
  assert.equal(f.acquisitions.length, 0);
});

test("ordinary non-native extension options remain the maintained resolver's values", async t => {
  const f = await profileFixture(t), { deskNativeContext: _record, ...ordinary } = f.config;
  await assert.rejects(f.create(ordinary, {}, { browser: "msedge", profileDirName: "Ordinary profile" }, {}),
    error => error === f.checkpoint);
  assert.equal(f.acquisitions[0][3], "Ordinary profile");
  assert.equal(f.acquisitions[0][5], undefined);
  await assert.rejects(f.create(ordinary, {}, { browser: "msedge" }, {}), error => error === f.checkpoint);
  assert.equal(f.acquisitions[1][3], undefined, "absence is not defaulted for a non-native extension");
  assert.equal(f.acquisitions[1][5], undefined);
});
