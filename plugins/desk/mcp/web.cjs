// Desk's browser: the desk-web MCP server.
//
// browser_context opens one of two browsers and closes it again:
//   fresh  an empty throwaway profile in a private temp folder;
//   mine   a private copy of the person's own Edge (or Chrome) profile, so their sign-ins work.
// Each runs headless with its own user-data folder. Fresh uses the legacy CLI; mine uses
// the owned native producer in web-auth.cjs. Both use playwright-core over a pipe, not a debugging
// port. So Desk never focuses a window, never attaches to, closes or changes the person's running
// browser, and never touches another agent's browser. Closing a context ends its own processes and deletes its folder.
//
// browser_command runs a legacy fresh command or a validated, protected native mine command.
//
// playwright-core is installed with npm into Desk's state folder on the first open.

"use strict";

var childProcess = require("child_process");
var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var browserDiscovery = require("./web-browser-discovery.cjs");
var launch = require("./web-launch.cjs");
var authBrowser = require("./web-auth.cjs");

var PLAYWRIGHT_VERSION = "1.63.0";
var BROWSER_TOOL_NAMES = ["browser_context", "browser_command"];
var unknownToolMessage = require("./src/tool-refusal.cjs").unknownToolMessage;
var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var PREFIX = "desk-browser-";
var PROFILE_POLICY = 1;
var AUTH_PROFILE_POLICY = 2;
var safeErrors = new WeakMap();
// Each context folder is its own Playwright CLI workspace, so one fixed session name per folder is enough.
var SESSION = "desk";
// The page commands browser_command may run; one of them must come first. Everything else stays out: opening, closing,
// attaching or listing browsers (only browser_context opens and closes, and some of these reach other sessions or kill every
// Playwright browser on the machine). Scripts (eval, run-code), sign-in state and cookies are the agent's to use.
var PAGE_COMMANDS = ["goto", "go-back", "go-forward", "reload", "snapshot", "find", "click", "dblclick", "type", "fill", "press",
  "keydown", "keyup", "select", "check", "uncheck", "hover", "drag", "drop", "upload", "mousemove", "mousedown", "mouseup",
  "mousewheel", "eval", "run-code", "state-save", "state-load", "cookie-list", "cookie-get", "cookie-set", "cookie-delete", "cookie-clear", "console", "dialog-accept", "dialog-dismiss", "resize", "screenshot", "pdf", "tab-list", "tab-new",
  "tab-close", "tab-select", "localstorage-list", "localstorage-get", "localstorage-set", "localstorage-delete",
  "localstorage-clear", "sessionstorage-list", "sessionstorage-get", "sessionstorage-set", "sessionstorage-delete",
  "sessionstorage-clear", "requests", "request", "request-headers", "request-body", "response-headers", "response-body",
  "route", "route-list", "unroute", "network-state-set", "generate-locator", "highlight"];
// Long options that would switch session or browser, or print help instead of running. The CLI also refuses any option the command does not have.
var REFUSED_OPTIONS = ["session", "s", "config", "profile", "browser", "persistent", "headed", "extension", "endpoint", "cdp",
  "cdp-endpoint", "all", "global", "g", "help", "h", "version", "v"];
// Keep authorized sessions in Cookies and Local Storage, not saved passwords in Login Data.
var PASSWORD_STORE = /^Login Data(?:$|[ .-])/i;
// Parts of a profile that are large caches, belong to extensions, or would reopen the person's own tabs.
var SKIP = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "CacheStorage",
  "ScriptCache", "Extensions", "Extension Scripts", "Extension State", "Extension Rules", "Local Extension Settings",
  "Sync Extension Settings", "File System", "Shared Dictionary", "IndexedDB", "WebStorage", "load_statistics.db",
  "WebAssistDatabase", "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"];
var BROWSERS = { msedge: { name: "Microsoft Edge", short: "Edge" }, chrome: { name: "Google Chrome", short: "Chrome" } };

function plain(message) {
  var error = Object.assign(new Error(message), { plain: true });
  safeErrors.set(error, Object.freeze({ message: message }));
  return error;
}

function safeErrorData(error) {
  if (!error || typeof error !== "object") return undefined;
  return safeErrors.get(error) || authBrowser.safeFailure(error);
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

// Desk's state folder for the browser: $DESK_BROWSER_STATE_DIR, else $XDG_STATE_HOME/ouroboros-skills/desk/browser, else ~/.local/state/ouroboros-skills/desk/browser.
function stateDir(env, homeDir) {
  if (env.DESK_BROWSER_STATE_DIR) return env.DESK_BROWSER_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"), "ouroboros-skills", "desk", "browser");
}

// Screenshots the agent asked for are kept here, one folder per Desk process, outside every context folder, so closing a context keeps them.
// Folders older than a week are removed when a later Desk process starts.
var EVIDENCE_ID = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+$/;
var EVIDENCE_DAYS = 7;
var PICTURE = /\.(?:png|jpe?g)$/i;

function evidenceDir(s) {
  return path.join(s.stateRoot, "evidence", s.evidenceId);
}

function pruneEvidence(s) {
  var root = path.join(s.stateRoot, "evidence");
  if (!fs.existsSync(root)) return;
  fs.readdirSync(root).forEach(function (name) {
    if (!EVIDENCE_ID.test(name) || name === s.evidenceId) return;
    var folder = path.join(root, name);
    if (Date.now() - fs.statSync(folder).mtimeMs > EVIDENCE_DAYS * 86400000) removeDir(folder);
  });
}

// The picture files directly in a folder, by name.
function pictures(folder) {
  return fs.readdirSync(folder).filter(function (name) { return PICTURE.test(name); });
}

// The npm that ships with a Node install: lib/node_modules/npm next to bin/node on macOS and Linux, node_modules\npm beside node.exe on Windows. Both the path as found and its real path are tried, because a version manager or Homebrew may link node from elsewhere.
function npmCli(node, platform, fileExists) {
  var real = node;
  try {
    real = fs.realpathSync(node);
  } catch (error) {
    // keep the path as given
  }
  var candidates = [node, real].map(function (file) {
    return platform === "win32"
      ? path.win32.join(path.win32.dirname(file), "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(path.dirname(file), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  });
  return browserDiscovery.firstExisting(candidates, fileExists);
}

// Where each browser keeps its profiles.
function profileRoot(channel, platform, env, homeDir) {
  var chrome = channel === "chrome";
  if (platform === "win32") {
    var local = env.LOCALAPPDATA || path.win32.join(homeDir, "AppData", "Local");
    return chrome ? path.win32.join(local, "Google", "Chrome", "User Data") : path.win32.join(local, "Microsoft", "Edge", "User Data");
  }
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", chrome ? "Google/Chrome" : "Microsoft Edge");
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), chrome ? "google-chrome" : "microsoft-edge");
}

var DEFAULT_IDLE_MS = 300000;

// How long an open browser may sit unused before it is closed: DESK_WEB_IDLE_MS, 0 for never. A headless Edge holds 100-350 MB.
function idleMs(env, given) {
  var text = given !== undefined ? given : env.DESK_WEB_IDLE_MS;
  if (text === undefined || String(text).trim() === "") return DEFAULT_IDLE_MS;
  var value = Number(text);
  return isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_IDLE_MS;
}

function settings(o) {
  var env = o.env || process.env;
  var homeDir = o.homeDir || os.homedir();
  var platform = o.platform || process.platform;
  var fileExists = o.exists || exists;
  var node = o.node || process.execPath;
  return {
    env: env, homeDir: homeDir, platform: platform, fileExists: fileExists, node: node,
    npmCli: o.npmCli === undefined ? npmCli(node, platform, fileExists) : o.npmCli,
    tmpDir: o.tmpDir || os.tmpdir(),
    pluginRoot: o.pluginRoot || path.resolve(__dirname, ".."),
    stateRoot: stateDir(env, homeDir),
    profileRoots: o.profileRoots || {},
    installMs: o.installMs || 180000,
    openMs: o.openMs || 120000,
    firstOpenMs: o.firstOpenMs || 90000,
    retryMinMs: o.retryMinMs || 30000,
    commandMs: o.commandMs || 120000,
    authDriver: o.authDriver,
    runtimeStateReader: o.runtimeStateReader || function () {
      return { execArgv: process.execArgv, inspectorActive: Boolean(require("node:inspector").url()) };
    },
    contexts: {},
    idleClosed: {},
    aliases: {},
    idleMs: idleMs(env, o.idleMs),
    evidenceId: new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid,
    exitWaitMs: o.exitWaitMs || 5000,
    closeMs: o.closeMs || 40000,
    recordMs: o.recordMs || 15000,
    processTable: o.processTable || function () {
      return readProcessTable(platform, env);
    }
  };
}

// The installed browser to drive: Edge first, then Chrome. For mine, only one whose profile folder exists.
function chooseBrowser(s, mine) {
  var channels = ["msedge", "chrome"];
  for (var i = 0; i < channels.length; i++) {
    var channel = channels[i];
    var selected = browserDiscovery.channelBrowserSelection(channel, s.platform, s.env, s.fileExists);
    if (!selected.executablePath) continue;
    var root = s.profileRoots[channel] || profileRoot(channel, s.platform, s.env, s.homeDir);
    if (mine) {
      try {
        if (!fs.statSync(path.join(root, "Local State")).isFile()) continue;
      } catch (error) {
        if (permissionDenied(error)) throw copyPermissionError(BROWSERS[channel].name);
        continue;
      }
    }
    return { channel: channel, executablePath: selected.executablePath, profileRoot: root };
  }
  if (mine) throw plain("Desk could not find your own Edge or Chrome profile on this computer. Use a fresh browser instead (browser: \"fresh\").");
  throw plain("Desk needs Microsoft Edge or Google Chrome to open a browser, and found neither. Install one, then try again.");
}

function copyPolicyError() {
  return plain("COPY_SOURCE_POLICY: Desk could not qualify a required profile file's identity, single-link ownership or readable bytes. Do not bypass this refusal or control the person's browser or desktop as a fallback. No authenticated copy was opened.");
}

function permissionDenied(error) {
  return !!error && (error.code === "EPERM" || error.code === "EACCES");
}

function copyPermissionError(app) {
  return plain("COPY_SOURCE_PERMISSION: The operating system blocked reading your " + (app || "browser") + " profile" +
    ". The access refusal does not identify the exact permission or policy responsible." +
    (process.platform === "darwin" ? " The operator or administrator can review the host app's file-access settings in System Settings > Privacy & Security; Full Disk Access may be relevant, but is not a guaranteed fix." :
      " The operator or administrator can review the host process's profile-folder access and system policy.") +
    " Desk cannot grant OS access. Retry only after an authorized repair; do not switch identity or transport, or control the person's browser or desktop as a fallback." +
    " No authenticated copy was opened.");
}

function copyDestinationError() {
  return plain("COPY_DESTINATION_FAILED: The private profile destination could not be written completely. No authenticated copy was opened.");
}

function singleFile(stat) {
  return stat.isFile() && typeof stat.ino === "bigint" && stat.ino > 0n &&
    typeof stat.dev === "bigint" && stat.dev >= 0n && stat.nlink === 1n;
}

function sameFile(a, b) {
  return singleFile(a) && singleFile(b) && a.dev === b.dev && a.ino === b.ino;
}

function readProfileFile(file) {
  var fd;
  var bytes;
  try {
    var before = fs.lstatSync(file, { bigint: true });
    if (!singleFile(before)) throw copyPolicyError();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    var opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) throw copyPolicyError();
    bytes = fs.readFileSync(fd);
    var after = fs.fstatSync(fd, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, fs.lstatSync(file, { bigint: true })) ||
      opened.size !== after.size || opened.mtimeNs !== after.mtimeNs) throw copyPolicyError();
    return bytes;
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (permissionDenied(error)) throw Object.assign(copyPolicyError(), { permissionDenied: true });
    throw copyPolicyError();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (error) { if (bytes) bytes.fill(0); throw copyPolicyError(); }
    }
  }
}

// Admission precedes both parsing and copying. The opened descriptor supplies the bytes;
// a later pathname copy would undo identity/link qualification.
function copyProfile(source, dest, app) {
  var state;
  try { state = readProfileFile(path.join(source, "Local State")); } catch (error) {
    if (error && error.permissionDenied) throw copyPermissionError(app);
    throw error;
  }
  var name = "Default";
  try {
    var last = JSON.parse(state.toString("utf8")).profile.last_used;
    if (typeof last === "string" && /^[^/\\]+$/.test(last) && last !== ".." && last !== ".") name = last;
  } catch (error) {
    // no usable last_used: copy Default
  }
  try {
    fs.mkdirSync(dest, { mode: 448 });
    fs.writeFileSync(path.join(dest, "Local State"), state, { mode: 384 });
  } catch (error) {
    throw copyDestinationError();
  } finally { state.fill(0); }
  var skipped = [];
  function copy(from, to, relative) {
    try {
      if (!fs.lstatSync(from).isDirectory()) throw copyPolicyError();
    } catch (error) {
      if (permissionDenied(error)) throw copyPermissionError(app);
      throw error;
    }
    fs.mkdirSync(to);
    var entries;
    try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch (error) {
      if (permissionDenied(error)) throw copyPermissionError(app);
      throw error;
    }
    entries.forEach(function (entry) {
      if (SKIP.indexOf(entry.name) !== -1 || PASSWORD_STORE.test(entry.name)) return;
      var inner = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) return copy(path.join(from, entry.name), path.join(to, entry.name), inner);
      // Following a link could import an excluded store under a different name.
      if (!entry.isFile()) {
        if (entry.name === "Network" || /^(?:Network\/)?Cookies(?:$|[-.])/.test(inner)) throw copyPolicyError();
        skipped.push(inner);
        return;
      }
      var bytes;
      try { bytes = readProfileFile(path.join(from, entry.name)); } catch (error) {
        if (/^(?:Network\/)?Cookies(?:$|[-.])/.test(inner)) throw error && error.permissionDenied ? copyPermissionError(app) : copyPolicyError();
        skipped.push(inner);
        return;
      }
      try { fs.writeFileSync(path.join(to, entry.name), bytes, { mode: 384 }); }
      catch (error) { throw copyDestinationError(); }
      finally { bytes.fill(0); }
    });
  }
  copy(path.join(source, name), path.join(dest, name), "");
  return { name: name, skipped: skipped };
}

function launchConfig(kind, browser, profileDir, profileName, outputDir) {
  var launch = { channel: browser.channel, executablePath: browser.executablePath, headless: true, args: ["--no-first-run", "--no-default-browser-check", "--mute-audio"] };
  if (kind === "mine") {
    // Cookies still need the normal encryption backend; excluding saved-login stores does not change it.
    // Sync stays off so the copy never writes back to the person's account.
    launch.ignoreDefaultArgs = ["--use-mock-keychain", "--password-store=basic"];
    launch.args.push("--profile-directory=" + profileName, "--disable-sync");
  }
  // The Playwright CLI refuses file: addresses, and file paths outside its folders, unless this is set. desk-web runs what the agent asks, so both are allowed.
  return { browser: { browserName: "chromium", isolated: false, userDataDir: profileDir, launchOptions: launch }, outputDir: outputDir, allowUnrestrictedFileAccess: true };
}

// ---- the Playwright CLI ----

function cliPath(s) {
  return path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION, "node_modules", "playwright-core", "lib", "tools", "cli-client", "cli.js");
}

// Run the Playwright CLI in a context folder; resolves { code, text, timedOut }.
// The CLI traps SIGTERM while it starts a daemon and then exits 0, so a stopped open looks like a success to execFile.
// The stop is therefore noted here, and counts as a failure whatever the exit code says.
function runCli(s, cwd, args, timeoutMs) {
  return new Promise(function (resolve) {
    var timedOut = false;
    var timer;
    var child = childProcess.execFile(s.node, [cliPath(s), "--session=" + SESSION].concat(args), {
      cwd: cwd, env: s.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8"
    }, function (error, stdout, stderr) {
      clearTimeout(timer);
      resolve({ code: error || timedOut ? 1 : 0, text: (stdout + "\n" + stderr).trim(), timedOut: timedOut || Boolean(error && error.killed) });
    });
    timer = setTimeout(function () {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

var installing = {};

function installPlaywright(s) {
  if (!s.npmCli) {
    return Promise.reject(plain("Desk could not find npm next to Node (" + s.node + "), so it cannot install the browser driver. Reinstall Node.js with npm, then try again."));
  }
  var dir = path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION);
  fs.mkdirSync(s.stateRoot, { recursive: true });
  var staging = fs.mkdtempSync(path.join(s.stateRoot, "install-"));
  fs.writeFileSync(path.join(staging, "package.json"), "{\"private\":true}\n");
  var env = Object.assign({}, s.env, { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", npm_config_loglevel: "error", npm_config_fetch_retries: "1", npm_config_fetch_timeout: "20000" });
  return new Promise(function (resolve, reject) {
    childProcess.execFile(s.node, [s.npmCli, "install", "--no-save", "--ignore-scripts", "playwright-core@" + PLAYWRIGHT_VERSION], {
      cwd: staging, env: env, timeout: s.installMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8"
    }, function (error, stdout, stderr) {
      var installed = path.join(staging, path.relative(dir, cliPath(s)));
      if (error || !exists(installed)) {
        removeDir(staging);
        reject(plain("Desk could not install the browser driver (playwright-core " + PLAYWRIGHT_VERSION + ") with npm. Check the internet connection, then try again. npm said: " + (stderr.trim().split("\n").filter(function (line) { return line.indexOf("complete log") === -1; }).pop() || "nothing")));
        return;
      }
      try {
        fs.renameSync(staging, dir);
      } catch (renameError) {
        // Another Desk process finished the same install first; its copy is used.
        removeDir(staging);
      }
      resolve();
    });
  });
}

function ensurePlaywright(s) {
  if (exists(cliPath(s))) return Promise.resolve();
  var key = s.stateRoot;
  if (!installing[key]) {
    installing[key] = installPlaywright(s).then(function () {
      delete installing[key];
      if (!exists(cliPath(s))) throw plain("Desk installed the browser driver but could not put it in place in " + s.stateRoot + ". Try again.");
    }, function (error) {
      delete installing[key];
      throw error;
    });
  }
  return installing[key];
}

// ---- contexts ----

function contextDir(s, id) {
  return path.join(s.tmpDir, PREFIX + id);
}

function checkAuthLogging(s) {
  [s.env, process.env].forEach(function (env) {
    if (env.DEBUG || env.DEBUG_FILE || env.NODE_OPTIONS) throw plain("AUTH_LOGGING_REFUSED: Unqualified Node options, preloads or raw logging are incompatible with authenticated output protection.");
    ["PWDEBUG", "npm_config_pwdebug", "npm_package_config_pwdebug"].forEach(function (key) {
      if (env[key] && env[key] !== "0" && env[key] !== "false") throw plain("AUTH_LOGGING_REFUSED: Browser inspection mode is incompatible with authenticated output protection.");
    });
  });
  var runtime;
  try { runtime = s.runtimeStateReader(); } catch (error) { throw plain("AUTH_LOGGING_REFUSED: Node runtime inspection state could not be qualified."); }
  if (!runtime || !Array.isArray(runtime.execArgv) || typeof runtime.inspectorActive !== "boolean" ||
    runtime.inspectorActive || require("node:inspector").url()) {
    throw plain("AUTH_LOGGING_REFUSED: Active or unqualified Node inspection is incompatible with authenticated output protection.");
  }
  if (runtime.execArgv.some(function (arg) {
    return typeof arg !== "string" || !(arg === "--test" || /^--test-(?:name|skip)-pattern=/.test(arg));
  })) throw plain("AUTH_LOGGING_REFUSED: Node runtime flags or preloads are unqualified for authenticated output protection.");
}

function loadAuthDriver(s) {
  checkAuthLogging(s);
  var driver = s.authDriver;
  if (!driver) {
    var root = path.join(s.stateRoot, "playwright-core-" + PLAYWRIGHT_VERSION, "node_modules", "playwright-core");
    var version = require(path.join(root, "package.json")).version;
    driver = { version: version, chromium: require(root).chromium };
  }
  if (driver.version !== PLAYWRIGHT_VERSION || !driver.chromium || typeof driver.chromium.launchPersistentContext !== "function") {
    throw plain("AUTH_DRIVER_REFUSED: The authenticated browser requires the pinned native driver API.");
  }
  return driver;
}

async function openAuth(s) {
  checkAuthLogging(s);
  var browser = chooseBrowser(s, true);
  var id = crypto.randomUUID();
  var dir = contextDir(s, id);
  var outputDir = path.join(dir, "files");
  try {
    await ensurePlaywright(s);
    var driver = loadAuthDriver(s);
    fs.mkdirSync(dir, { mode: 448 });
    s.contexts[id] = { kind: "mine", transport: "auth-api" };
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, browser: "mine", profilePolicy: AUTH_PROFILE_POLICY, transport: "auth-api" }) + "\n");
    fs.mkdirSync(outputDir);
    var profileDir = path.join(dir, "profile");
    var copied = copyProfile(browser.profileRoot, profileDir, BROWSERS[browser.channel].name);
    var config = launchConfig("mine", browser, profileDir, copied.name, outputDir);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
    var launch = Object.assign({}, config.browser.launchOptions, {
      ignoreDefaultArgs: ["--disable-extensions"].concat(config.browser.launchOptions.ignoreDefaultArgs),
      acceptDownloads: false, chromiumSandbox: true, viewport: { width: 1280, height: 720 },
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, env: s.env, timeout: s.openMs
    });
    var context = await driver.chromium.launchPersistentContext(profileDir, launch);
    s.contexts[id].context = context;
    checkAuthLogging(s);
    s.contexts[id].adapter = authBrowser.create(context, outputDir, s.commandMs, function () { checkAuthLogging(s); }, { evidenceDir: evidenceDir(s) });
    var opened = {
      contextId: id, browser: "mine", app: BROWSERS[browser.channel].name, files: outputDir, evidence: evidenceDir(s),
      note: "Owned native output: all input/textarea/editable values are opaque. Pages are read with their child frames, refs act in any frame, and screenshot masks every input/textarea/editable region; every command is yours to run. Screenshots are saved in the evidence folder, which stays after close. Close this context when done."
    };
    if (copied.skipped.length) opened.copyLimitations = "Some nonessential profile files were omitted because their regular-file identity, single-link ownership or readable bytes could not be qualified.";
    return opened;
  } catch (error) {
    var safe = safeErrorData(error);
    var primary = safe && /^(?:AUTH_|COPY_SOURCE_POLICY|COPY_SOURCE_PERMISSION|COPY_DESTINATION_FAILED)/.test(safe.message) ? error :
      plain("AUTH_OPEN_FAILED: The authenticated browser could not be opened safely; no native CLI fallback was attempted.");
    if (s.contexts[id]) {
      try { await close(s, id); } catch (cleanupError) {
        throw plain(safeErrorData(primary).message + " Retained cleanup uncertainty: AUTH_CLEANUP_FAILED; the failed authenticated context remains owned.");
      }
    }
    throw primary;
  }
}

// One start of a fresh browser in its own context folder; resolves { id, outputDir, result } and leaves the judging to open().
function startFresh(s, kind, browser, budgetMs) {
  var id = crypto.randomUUID();
  var dir = contextDir(s, id);
  // Screenshots, snapshots and logs stay inside the private context folder, so they go when the context closes.
  var outputDir = path.join(dir, "files");
  return ensurePlaywright(s).then(function () {
    fs.mkdirSync(dir, { mode: 448 });
    s.contexts[id] = { kind: "fresh", transport: "legacy-cli" };
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.pid, browser: kind, profilePolicy: PROFILE_POLICY, transport: "legacy-cli" }) + "\n");
    fs.mkdirSync(path.join(dir, ".playwright"));
    fs.mkdirSync(outputDir);
    var profileDir = path.join(dir, "profile");
    fs.mkdirSync(profileDir, { mode: 448 });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(launchConfig(kind, browser, profileDir, null, outputDir)));
    return runCli(s, dir, ["open", "--config=config.json"], budgetMs);
  }).then(function (result) {
    return recordProcesses(s, dir, result.text).then(function () {
      return { id: id, outputDir: outputDir, result: result };
    });
  }).catch(function (error) {
    return close(s, id).then(function () {
      throw error;
    });
  });
}

// Replies with the opened context, or closes the failed one and throws. retry is { firstMs } when an earlier try timed out.
function finishFresh(s, kind, browser, attempt, budgetMs, retry) {
  var result = attempt.result;
  if (result.code === 0) {
    var opened = {
      contextId: attempt.id, browser: kind, app: BROWSERS[browser.channel].name, files: attempt.outputDir, evidence: evidenceDir(s),
      note: "Runs in the background and leaves your own browser windows alone. Close it with browser_context action \"close\" when done; closing deletes the files folder, but a screenshot is also copied to the evidence folder, which stays after close."
    };
    if (retry) opened.retried = true;
    return opened;
  }
  var details = result.text ? " Details: " + result.text.slice(-1500) : "";
  var message;
  if (retry) {
    var stalled = "the first try did not start within " + retry.firstMs / 1000 + " seconds and was stopped, and the second try ";
    message = result.timedOut ? "The browser did not start: " + stalled + "did not start within " + budgetMs / 1000 + " seconds and was stopped. Try again, or use a fresh browser." + details :
      "The browser did not start: " + stalled + "failed. Try again, or use a fresh browser. Details: " + result.text.slice(-1500);
  } else {
    message = result.timedOut ? "The browser did not start within " + budgetMs / 1000 + " seconds and was stopped. Try again, or use a fresh browser." + details :
      "The browser did not start. Try again, or use a fresh browser. Details: " + result.text.slice(-1500);
  }
  return close(s, attempt.id).then(function () {
    throw plain(message);
  });
}

function open(s, kind) {
  if (kind !== "fresh" && kind !== "mine") throw plain("browser must be \"fresh\" or \"mine\".");
  if (kind === "mine") return openAuth(s);
  var browser = chooseBrowser(s, false);
  var begun = Date.now();
  var firstMs = Math.min(s.firstOpenMs, s.openMs);
  return startFresh(s, kind, browser, firstMs).then(function (first) {
    // Only a first try that left part of the budget unused is retried, so a start never runs past its budget.
    if (!first.result.timedOut || firstMs >= s.openMs) return finishFresh(s, kind, browser, first, firstMs);
    // A start that stalls is stopped and tried once more, within the same overall budget. Chrome prints warnings (D-Bus on Linux)
    // even while it hangs, so output does not mean progress (#763).
    return close(s, first.id).then(function () {
      var secondMs = Math.max(s.retryMinMs, s.openMs - (Date.now() - begun));
      return startFresh(s, kind, browser, secondMs).then(function (second) {
        return finishFresh(s, kind, browser, second, secondMs, { firstMs: firstMs });
      });
    });
  });
}

// A browser that just exited can hold its files for a moment, most often on Windows, so a refused removal is retried for about two seconds.
function removeDir(dir) {
  for (var attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].indexOf(error.code) === -1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

// ---- the context's own processes ----
//
// The CLI starts a detached daemon, and the daemon starts the browser. A browser running a copy of a real profile can
// outlive the CLI's close, so Desk records the daemon and everything under it when the context opens, and on close
// waits a few seconds, then kills only those processes. Each is matched by PID and start time, so a PID the system
// has since given to another process is never touched; nothing is matched by name.

function processTableCommand(platform, env) {
  if (platform === "win32") {
    var shell = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return [shell, ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }"]];
  }
  return ["ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="]];
}

// Lines of "pid ppid start"; the start is the rest of the line.
function parseProcessTable(text) {
  return text.split(/\r?\n/).map(function (line) {
    var match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    return match && { pid: Number(match[1]), ppid: Number(match[2]), start: match[3] };
  }).filter(Boolean);
}

// Resolves the process table, or null when it cannot be read.
function readProcessTable(platform, env) {
  var command = processTableCommand(platform, env);
  return new Promise(function (resolve) {
    var child = childProcess.execFile(command[0], command[1], { timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, function (error, stdout) {
      resolve(error ? null : parseProcessTable(stdout));
    });
    // PowerShell reads a piped stdin before it exits, so it is closed at once.
    child.stdin.end();
  });
}

// Windows start times are file-time numbers, ps start times are dates.
function startValue(start) {
  return /^\d+$/.test(start) ? Number(start.slice(0, -4)) : Date.parse(start);
}

// The given processes that are still running as themselves, and everything they have started since. A child must have
// started no earlier than its parent, because Windows keeps a parent PID after the parent exits and may reuse it.
function liveTree(table, roots) {
  var live = table.filter(function (row) {
    return roots.some(function (root) { return root.pid === row.pid && root.start === row.start; });
  });
  for (var i = 0; i < live.length; i += 1) {
    var parent = live[i];
    table.forEach(function (row) {
      if (row.ppid === parent.pid && live.indexOf(row) === -1 && startValue(row.start) >= startValue(parent.start)) live.push(row);
    });
  }
  return live.map(function (row) { return { pid: row.pid, start: row.start }; });
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  } catch (error) {
    return {};
  }
}

// The CLI prints the daemon's PID when it opens ("opened with pid N") and when the daemon fails to start ("Daemon pid=N:").
// A cold PowerShell start can outlast its read, so an unreadable table or one without the daemon is read again; if every read
// fails, owner.json says the processes are unknown, so close can say so.
var PROCESS_READS = 3;
var PROCESS_READ_PAUSE_MS = 500;
function recordProcesses(s, dir, text) {
  var match = /(?:opened with pid |Daemon pid=)(\d+)/.exec(text);
  if (!match) return Promise.resolve();
  var daemon = Number(match[1]);
  var until = Date.now() + s.recordMs;
  function read(attempt) {
    return tableBefore(s, until).then(function (table) {
      var row = (table || []).filter(function (entry) { return entry.pid === daemon; })[0];
      var owner = readOwner(dir);
      if (row) {
        owner.processes = liveTree(table, [row]);
      } else if (attempt < PROCESS_READS && Date.now() < until) {
        return pause(PROCESS_READ_PAUSE_MS).then(function () { return read(attempt + 1); });
      } else {
        owner.processesUnknown = true;
      }
      fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner) + "\n");
    });
  }
  return read(1);
}

// One read of the process table that gives up (null) at `until`. A slow read (a cold PowerShell on a busy Windows runner can take
// tens of seconds) must not hold an answer past the host's own call timeout, which is shorter than the table read's own limit.
function tableBefore(s, until) {
  var left = until - Date.now();
  if (left <= 0) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(null); }, left);
    Promise.resolve().then(function () { return s.processTable(); }).then(function (table) {
      clearTimeout(timer);
      resolve(table);
    }, function () {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function pause(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Waits up to exitWaitMs for the recorded processes to exit, asks what is left to stop (SIGTERM), waits up to exitWaitMs again,
// then kills what is still there; resolves the PIDs it killed. The polite stop matters: a Chromium browser removes its ~1 GiB
// code-sign clone ($TMPDIR/../X/<bundle id>.code_sign_clone/) when it exits on its own or on SIGTERM, and leaks it when it is killed.
// It never runs past `until`: when time is out it kills what its last good read showed alive, and gives up on the rest.
function endProcesses(s, recorded, until) {
  if (!recorded || !recorded.length) return Promise.resolve([]);
  var deadline = Date.now() + s.exitWaitMs;
  var asked = false;
  var lastLive = [];
  function signal(entry, name) {
    try {
      process.kill(entry.pid, name);
    } catch (error) {
      // It exited after the table was read.
    }
  }
  function check() {
    return tableBefore(s, until).then(function (table) {
      if (!table) {
        lastLive.forEach(function (entry) { signal(entry, "SIGKILL"); });
        return lastLive.map(function (entry) { return entry.pid; });
      }
      var live = liveTree(table, recorded);
      lastLive = live;
      if (!live.length) return [];
      if (Date.now() < deadline && Date.now() + 250 < until) return pause(250).then(check);
      if (!asked && Date.now() + s.exitWaitMs < until) {
        asked = true;
        live.forEach(function (entry) { signal(entry, "SIGTERM"); });
        deadline = Date.now() + s.exitWaitMs;
        return pause(250).then(check);
      }
      live.forEach(function (entry) { signal(entry, "SIGKILL"); });
      return pause(250).then(function () {
        return live.map(function (entry) { return entry.pid; });
      });
    });
  }
  return check();
}

function close(s, id) {
  var dir = contextDir(s, id);
  var owned = s.contexts[id];
  if (owned && owned.kind === "mine") {
    return Promise.resolve().then(function () {
      if (owned.adapter) return owned.adapter.close();
      if (owned.context) return owned.context.close();
    }).catch(function () {
      throw plain("AUTH_CLOSE_FAILED: Owned authenticated cleanup could not be confirmed; its files were retained.");
    }).then(function () {
      try { removeDir(dir); } catch (error) { throw plain("AUTH_FILES_RETAINED: The owned browser closed, but its private files could not be removed."); }
      delete s.contexts[id];
      return { contextId: id, closed: true };
    });
  }
  var owner = readOwner(dir);
  if (!owned && fs.existsSync(dir) && !(owner.browser === "fresh" && ownerGone(path.join(dir, "owner.json")))) {
    throw plain("AUTH_CONTEXT_REFUSED: An unowned or older context cannot be closed or migrated through this server.");
  }
  if (owner.browser === "mine" || owner.transport === "auth-api" || owner.profilePolicy === AUTH_PROFILE_POLICY) {
    throw plain("AUTH_CONTEXT_REFUSED: No current owned native handle exists for this authenticated context.");
  }
  var recorded = owner.processes;
  // The whole close answers within closeMs: the CLI's own close gets half, and the processes the rest.
  var until = Date.now() + s.closeMs;
  var stop = fs.existsSync(path.join(dir, "config.json")) && exists(cliPath(s)) ? runCli(s, dir, ["close"], Math.min(30000, Math.floor(s.closeMs / 2))) : Promise.resolve();
  return stop.then(function () {
    return endProcesses(s, recorded, until);
  }).then(function () {
    removeDir(dir);
    delete s.contexts[id];
    if (owner.processesUnknown) return { contextId: id, closed: true, processesUnknown: true, hint: "Desk could not record the processes this context started, because three reads of the process table did not list them, so a browser it opened may still be running." };
    return { contextId: id, closed: true };
  });
}

function checkId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw plain("contextId must be the id that browser_context open returned.");
}

// The CLI takes its command from the first argument that is not an option, and reads options anywhere before "--".
function checkArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some(function (arg) { return typeof arg !== "string"; })) {
    throw plain("args must be a list of strings, for example [\"snapshot\"].");
  }
  if (PAGE_COMMANDS.indexOf(args[0]) === -1) {
    throw plain("args must start with a page command such as snapshot, click or goto, and \"" + args[0] + "\" is not one. Open and close browsers with browser_context.");
  }
  var end = args.indexOf("--");
  (end === -1 ? args : args.slice(0, end)).forEach(function (arg) {
    if (/^-[A-Za-z]/.test(arg)) throw plain("Short options such as " + arg + " are not available here. Use the long form, such as --filename, and put text that starts with - after \"--\".");
    var name = /^--/.test(arg) ? arg.slice(2).split("=")[0].replace(/^no-/, "") : null;
    if (REFUSED_OPTIONS.indexOf(name) !== -1) throw plain("The option " + arg.split("=")[0] + " is not available here; the browser is chosen when browser_context opens it.");
  });
}

function command(s, id, args) {
  checkId(id);
  var dir = contextDir(s, id);
  if (!fs.existsSync(path.join(dir, "config.json"))) throw plain("There is no open browser with that contextId. Open one with browser_context.");
  var record = s.contexts[id];
  var owner = readOwner(dir);
  if (record && record.kind === "mine") {
    if (owner.browser !== "mine" || owner.transport !== "auth-api" || owner.profilePolicy !== AUTH_PROFILE_POLICY ||
      owner.pid !== process.pid || !record.adapter) throw plain("AUTH_CONTEXT_POLICY: This context has no current password-store exclusion policy and owned native handle. Open a new context; no profile was migrated.");
    // The reply carries the snapshot's text; its JSON tree says the same at twice the size (a saved artifact keeps it).
    return record.adapter.call(args).then(function (result) {
      if (!result || typeof result !== "object" || !("snapshot" in result)) return result;
      var reply = Object.assign({}, result);
      delete reply.snapshot;
      return reply;
    });
  }
  if (!record || owner.browser !== "fresh" || owner.transport !== "legacy-cli" || owner.pid !== process.pid || owner.profilePolicy !== PROFILE_POLICY) {
    throw plain("This browser context has no current password-store exclusion policy. Close it with browser_context and open a new context; Desk will not scrub or migrate an existing profile.");
  }
  checkArgs(args);
  var folders = [path.join(dir, "files"), dir];
  var known = args[0] === "screenshot" ? folders.map(pictures) : [];
  return runCli(s, dir, args, s.commandMs).then(function (result) {
    if (result.timedOut) throw plain("The command took longer than " + s.commandMs / 1000 + " seconds and was stopped.");
    if (result.code !== 0) throw plain(result.text || "The command failed.");
    if (args[0] !== "screenshot") return result.text + webOptionHint(result.text);
    return result.text + keepPictures(s, folders, known);
  });
}

// A fresh browser's replies are the driver's own text, so a launch cannot be told from it; a page that shows a web option
// (a launcher's "Join from browser") is pointed out, so an agent takes it instead of waiting for an app that never opens.
function webOptionHint(text) {
  var option = launch.webOptionInText(text);
  return option ? "\ndesk-web: this page offers a web option, the " + option.role + " " + JSON.stringify(option.name) + " [ref=" + option.ref + "]; desk-web never opens desktop apps, so click it to continue in the browser." : "";
}

// Copies each picture a screenshot command just wrote to the evidence folder; returns the line that says where, or "".
function keepPictures(s, folders, known) {
  var kept = [];
  folders.forEach(function (folder, index) {
    pictures(folder).filter(function (name) { return known[index].indexOf(name) === -1; }).forEach(function (name) {
      try {
        fs.mkdirSync(evidenceDir(s), { recursive: true, mode: 448 });
        var copy = path.join(evidenceDir(s), crypto.randomUUID() + "-" + name);
        fs.copyFileSync(path.join(folder, name), copy);
        kept.push(copy);
      } catch (error) {
        // The original is still in the files folder; only its survival is unconfirmed.
      }
    });
  });
  return kept.length ? "\nKept after browser_context close: " + kept.join(", ") : "";
}

function ownerGone(file) {
  try {
    process.kill(JSON.parse(fs.readFileSync(file, "utf8")).pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Close what an earlier Desk process left open when it stopped without closing.
function sweep(s) {
  var names = fs.existsSync(s.tmpDir) ? fs.readdirSync(s.tmpDir) : [];
  var stale = names.filter(function (name) {
    var owner = readOwner(path.join(s.tmpDir, name));
    return name.indexOf(PREFIX) === 0 && ID.test(name.slice(PREFIX.length)) && owner.browser === "fresh" &&
      ownerGone(path.join(s.tmpDir, name, "owner.json"));
  });
  try { pruneEvidence(s); } catch (error) { /* old pictures are retried at the next start */ }
  return stale.reduce(function (chain, name) {
    return chain.then(function () {
      return close(s, name.slice(PREFIX.length));
    });
  }, Promise.resolve());
}

// ---- MCP ----

// Who is serving this reply, so a result binds to the code that produced it: the loaded plugin folder and the Desk version in its plugin.json.
function runtimeIdentity(s) {
  var version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(s.pluginRoot, "plugin.json"), "utf8")).version; } catch (error) { /* an unreadable manifest leaves the version unknown */ }
  return { plugin: { name: "desk", version: typeof version === "string" ? version : null }, plugin_root: s.pluginRoot };
}

function createController(options) {
  var s = settings(options || {});
  function answer(work) {
    return Promise.resolve().then(work).then(function (value) {
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError: false };
    }, function (error) {
      var safe = safeErrorData(error);
      return { content: [{ type: "text", text: safe ? safe.message : "Call the browser tool again: Desk's browser hit an unexpected problem: BROWSER_INTERNAL_FAILURE." }], isError: true };
    });
  }
  function context(input) {
    if (input.action === "open") {
      return open(s, input.browser || "fresh").then(function (opened) {
        return Object.assign({}, opened, { runtime: runtimeIdentity(s) });
      });
    }
    if (input.action !== "close") throw plain("action must be \"open\" or \"close\".");
    checkId(input.contextId);
    var id = resolve(input.contextId);
    if (s.idleClosed[id]) { delete s.idleClosed[id]; return { contextId: input.contextId, closed: true }; }
    return close(s, id);
  }
  // Follows a context id that was reopened after an idle close to the context that took its place.
  function resolve(id) {
    var hops = 0;
    while (typeof id === "string" && s.aliases[id] && hops++ < 100) id = s.aliases[id];
    return id;
  }
  // Brings back a browser that was closed for sitting unused: a new one of the same kind, sent to the page it was last on.
  function reopen(id) {
    var gone = s.idleClosed[id];
    if (!gone.reopening) {
      gone.reopening = open(s, gone.kind).then(function (opened) {
        var fresh = opened.contextId;
        s.aliases[id] = fresh;
        delete s.idleClosed[id];
        var back = gone.url ? Promise.resolve().then(function () { return command(s, fresh, ["goto", gone.url]); }).catch(function () { /* the command that follows reports what the page does */ }) : Promise.resolve();
        return back.then(function () {
          if (s.contexts[fresh] && gone.url) s.contexts[fresh].url = gone.url;
          return { id: fresh, text: "Desk reopened this browser, which had been closed after " + Math.round(s.idleMs / 60000) + " minutes unused" + (gone.url ? ", and went back to " + gone.url : "") + ". Page state such as scroll position, form input and open tabs was not kept." };
        });
      }, function (error) { gone.reopening = null; throw error; });
    }
    return gone.reopening;
  }
  // Closes a browser nobody has used for the idle time and no command is running in; a browser still opening is left alone.
  function releaseIdle() {
    var now = Date.now();
    return Promise.all(Object.keys(s.contexts).map(function (id) {
      var record = s.contexts[id];
      if (record.lastUsed === undefined) { record.lastUsed = now; return null; }
      if (record.busy || now - record.lastUsed < s.idleMs) return null;
      if (record.kind === "mine" ? !record.adapter : !fs.existsSync(path.join(contextDir(s, id), "owner.json"))) return null;
      var gone = { kind: record.kind, url: record.url };
      return close(s, id).then(function () { s.idleClosed[id] = gone; }, function () { /* kept; the next pass tries again */ });
    }));
  }
  if (s.idleMs > 0) setInterval(releaseIdle, Math.max(250, Math.min(30000, Math.floor(s.idleMs / 4)))).unref();
  return {
    settings: s,
    releaseIdle: releaseIdle,
    call: function (name, input) {
      var given = input || {};
      if (name === "browser_context") return answer(function () { return context(given); });
      if (name === "browser_command") {
        var id = resolve(given.contextId);
        var back = s.idleClosed[id] ? reopen(id) : Promise.resolve(null);
        return back.then(function (note) {
          var live = note ? note.id : id;
          var record = s.contexts[live];
          if (record) { record.busy = (record.busy || 0) + 1; record.lastUsed = Date.now(); }
          var args = given.args;
          return answer(function () { return command(s, live, args); }).then(function (reply) {
            if (record) {
              record.busy -= 1;
              record.lastUsed = Date.now();
              if (!reply.isError && Array.isArray(args) && (args[0] === "goto" || args[0] === "tab-new") && typeof args[1] === "string" && args[1].charAt(0) !== "-") record.url = args[1];
            }
            if (note) reply.content.push({ type: "text", text: note.text });
            return reply;
          });
        }, function (error) {
          return answer(function () { throw error; });
        });
      }
      return answer(function () { throw plain(unknownToolMessage(name, BROWSER_TOOL_NAMES, "Desk Browser's")); });
    },
    closeAll: function () {
      return Promise.all(Object.keys(s.contexts).map(function (id) {
        return close(s, id);
      }));
    },
    sweep: function () {
      return Promise.resolve().then(function () {
        return sweep(s);
      }).catch(function (error) {
        return error;
      });
    }
  };
}

// ---- staying current ----
//
// The host keeps this server for days and routes every new chat to it, so the code it started with goes stale. On a call, in the
// background, it looks for a newer Desk release (src/runtime/runtime-swap.js, the same watcher the Desk server uses) and builds
// that release's own controller. The next call opens browsers with the newer controller and lists the newer tools; a browser the
// older controller opened stays with it until it is closed, and a call already running finishes on the code it started with.
// A check that fails changes nothing and says so in the `runtime` of browser_context's answer.

function pluginVersion(pluginRoot) {
  try {
    var version = JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch (error) {
    return null;
  }
}

// The newer copy's controller and tool list, or why there is none.
async function prepareNewerBrowser(o) {
  var release = await o.newestRelease({ env: o.env, pluginRoot: o.pluginRoot, running: o.running, homeDir: o.homeDir });
  if (release.state === "not_applicable") return { state: "not_applicable", reason: release.reason };
  if (release.state === "current") return { state: "current", latest: release.latest };
  if (release.state === "fell_back") return { state: "failed", latest: release.latest, reason: release.reason };
  try {
    var newer = require(path.join(release.mcpRoot, "web.cjs"));
    var tools = require(path.join(release.mcpRoot, "web-catalog.json")).tools;
    if (typeof newer.createController !== "function" || !Array.isArray(tools)) return { state: "failed", latest: release.latest, reason: "the " + release.latest + " copy did not load (it has no browser server)" };
    var controller = newer.createController({ env: o.env, homeDir: o.homeDir });
    return { state: "ready", latest: release.latest, loaded: { controller: controller, tools: tools, version: release.latest } };
  } catch (error) {
    return { state: "failed", latest: release.latest, reason: "the " + release.latest + " copy did not load (" + String(error && error.message).split("\n")[0].slice(0, 100) + ")" };
  }
}

/* istanbul ignore next -- the real server builds the watcher; tests hand serve() their own */
async function realRefresher(o) {
  var swap = await import(require("url").pathToFileURL(path.join(__dirname, "src", "runtime", "runtime-swap.js")).href);
  var ensure = (await import(require("url").pathToFileURL(path.join(__dirname, "src", "runtime", "newest-release.js")).href)).ensureNewestRelease;
  var env = o.env || process.env;
  return {
    refresher: swap.createRuntimeRefresher({
      env: env,
      log: function (line) { process.stderr.write("[desk-web] " + line + "\n"); },
      prepare: function (input) {
        return prepareNewerBrowser({ env: env, homeDir: os.homedir(), pluginRoot: path.resolve(__dirname, ".."), running: input.running, newestRelease: ensure });
      }
    })
  };
}

// options: stdin, stdout, signals (an emitter of SIGINT/SIGTERM/SIGHUP), exit, plus the controller's own settings, and
// `refresher` ({ refresher }, as realRefresher builds it) or `refresherFactory` to keep the server current.
function serve(o) {
  var stdin = o.stdin;
  var controller = createController(o);
  // Newest last. A browser stays with the controller that opened it.
  var controllers = [controller];
  var tools = require("./web-catalog.json").tools;
  var pending = [];
  var buffered = "";
  var refresh = o.refresher || null;
  var wanted = o.refresherFactory || null;
  function version() {
    return pluginVersion(controllers[controllers.length - 1].settings.pluginRoot);
  }
  function ownerOf(input) {
    var id = input && input.contextId;
    for (var i = controllers.length - 1; i >= 0; i--) if (typeof id === "string" && (controllers[i].settings.contexts[id] || controllers[i].settings.idleClosed[id] || controllers[i].settings.aliases[id])) return controllers[i];
    return controllers[controllers.length - 1];
  }
  function keepCurrent(opening) {
    if (!refresh && wanted) {
      var factory = wanted;
      wanted = null;
      factory().then(function (made) { refresh = made; keepCurrent(opening); }, function () { /* the server keeps what it has */ });
      return;
    }
    if (!refresh) return;
    var watcher = refresh.refresher;
    watcher.poke({ running: version(), soon: opening });
    var next = watcher.ready ? watcher.take() : null;
    if (next) {
      var from = version();
      controllers.push(next.loaded.controller);
      tools = next.loaded.tools;
      watcher.swapped({ from: from, to: next.loaded.version });
    }
  }
  function dress(name, input, body) {
    if (!refresh || name !== "browser_context" || !input || input.action !== "open" || body.isError) return body;
    try {
      var parsed = JSON.parse(body.content[0].text);
      if (parsed && typeof parsed === "object" && parsed.runtime) {
        parsed.runtime = Object.assign({}, parsed.runtime, refresh.refresher.describe());
        return Object.assign({}, body, { content: [{ type: "text", text: JSON.stringify(parsed) }] });
      }
    } catch (error) { /* the answer is the browser's own, unchanged */ }
    return body;
  }
  function send(id, body) {
    o.stdout.write(JSON.stringify(Object.assign({ jsonrpc: "2.0", id: id }, body)) + "\n");
  }
  function handle(line) {
    var message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(null, { error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!message || message.id === undefined) return;
    var params = message.params || {};
    if (message.method === "initialize") {
      send(message.id, { result: { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "desk-web", version: "2.0.0" } } });
    } else if (message.method === "ping") {
      send(message.id, { result: {} });
    } else if (message.method === "tools/list") {
      send(message.id, { result: { tools: tools } });
    } else if (message.method === "tools/call") {
      var input = params.arguments;
      keepCurrent(params.name === "browser_context" && input && input.action === "open");
      var served = ownerOf(input);
      pending.push(served.call(params.name, input).then(function (body) {
        send(message.id, { result: dress(params.name, input, body) });
      }));
    } else {
      send(message.id, { error: { code: -32601, message: "Method not found: " + message.method } });
    }
  }
  var swept = controller.sweep();
  return new Promise(function (resolve) {
    var finishing = null;
    function finish() {
      if (!finishing) {
        finishing = Promise.all(pending.concat([swept])).then(function () {
          return Promise.all(controllers.map(function (each) { return each.closeAll(); }));
        });
      }
      return finishing;
    }
    function stop() {
      o.exit(0);
    }
    ["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (signal) {
      o.signals.once(signal, function () {
        finish().then(stop, stop);
      });
    });
    stdin.setEncoding("utf8");
    stdin.on("data", function (chunk) {
      buffered += chunk;
      var lines = buffered.split("\n");
      buffered = lines.pop();
      lines.forEach(function (line) {
        if (line.trim()) handle(line);
      });
    });
    stdin.on("end", function () {
      finish().then(resolve, resolve);
    });
    stdin.resume();
  });
}

module.exports = {
  BROWSER_TOOL_NAMES: BROWSER_TOOL_NAMES,
  PLAYWRIGHT_VERSION: PLAYWRIGHT_VERSION,
  npmCli: npmCli,
  profileRoot: profileRoot,
  copyProfile: copyProfile,
  processTableCommand: processTableCommand,
  parseProcessTable: parseProcessTable,
  readProcessTable: readProcessTable,
  liveTree: liveTree,
  createController: createController,
  prepareNewerBrowser: prepareNewerBrowser,
  serve: serve,
  run: run
};

/* istanbul ignore next -- the hosts start this with the real process; tests call serve() with their own streams */
function run() {
  var real = { stdin: process.stdin, stdout: process.stdout, signals: process, exit: function (code) { process.exit(code); } };
  real.refresherFactory = function () { return realRefresher(real); };
  return serve(real);
}

/* istanbul ignore next -- Copilot starts this file directly */
if (require.main === module) run();
