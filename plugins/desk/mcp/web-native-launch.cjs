"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var childProcess = require("child_process");
var artifacts = require("./web-native-artifacts.cjs").artifactFamily("browser-launch");
var TARGETS = artifacts.TARGETS;

function error(code) {
  return new Error(code);
}

var sourceHash = artifacts.sourceHash;
var checkAsset = artifacts.checkAsset;
var selectAsset = artifacts.selectAsset;
var verifyAssets = artifacts.verifyAssets;

function ownerName(env, host) {
  var session = env.DESK_SESSION_ID || env.COPILOT_AGENT_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || "";
  var name = typeof host === "string" ? host : "agent";
  name = name.replace(/[^A-Za-z0-9 ._-]/g, " ").slice(0, 40);
  session = String(session).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  return "Desk " + name + (session ? " " + session : "") + " " + crypto.randomBytes(6).toString("hex");
}

function prepare(o) {
  var asset = selectAsset(o.mcpRoot, o.platform, o.arch);
  var dir = fs.mkdtempSync(path.join(o.root, "launch-"));
  fs.chmodSync(dir, 448);
  var file = path.join(dir, "receipt.json");
  var executable = path.join(dir, "desk-browser-launch" + (o.platform === "win32" ? ".exe" : ""));
  var nonce = crypto.randomBytes(16).toString("hex");
  var env = {
    DESK_BROWSER_EXECUTABLE: o.executable,
    DESK_BROWSER_PROFILE: o.profile,
    DESK_BROWSER_OWNER: o.owner,
    DESK_BROWSER_RECEIPT: file,
    DESK_BROWSER_NONCE: nonce
  };
  function read() {
    var info;
    try {
      info = fs.lstatSync(file);
    } catch (failure) {
      if (failure.code !== "ENOENT") throw error("browser_native_launch_receipt_invalid");
      var parent;
      try { parent = fs.lstatSync(dir); }
      catch (parentError) { throw error("browser_native_launch_receipt_invalid"); }
      if (!parent.isDirectory()) throw error("browser_native_launch_receipt_invalid");
      return null;
    }
    if (!info.isFile() || info.size > 4096) throw error("browser_native_launch_receipt_invalid");
    var value;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (failure) {
      throw error("browser_native_launch_receipt_invalid");
    }
    if (!value || typeof value !== "object") throw error("browser_native_launch_receipt_invalid");
    if (value.version !== 1 || value.nonce !== nonce ||
        ["ready", "starting", "spawned", "refused"].indexOf(value.status) === -1 ||
        (value.status === "spawned" && (!Number.isSafeInteger(value.pid) || value.pid <= 0))) {
      throw error("browser_native_launch_receipt_invalid");
    }
    return value;
  }
  function removeReceipt() {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  function dispose() {
    removeReceipt();
    if (fs.existsSync(executable)) fs.unlinkSync(executable);
    fs.rmdirSync(dir);
  }
  var checkEnv = {};
  Object.keys(o.env).forEach(function (key) {
    if (key !== "PLAYWRIGHT_MCP_EXTENSION_TOKEN") checkEnv[key] = o.env[key];
  });
  Object.keys(env).forEach(function (key) { checkEnv[key] = env[key]; });
  try {
    fs.copyFileSync(asset.file, executable, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(executable, 448);
    checkAsset(executable, asset.sha256);
    var checked = childProcess.spawnSync(executable, ["--check"], { env: checkEnv, encoding: "utf8", timeout: 5000, windowsHide: true, shell: false });
    if (checked.status !== 0 || checked.error || !read() || read().status !== "ready") throw error("browser_native_launch_refused");
  } catch (failure) {
    dispose();
    throw failure;
  }
  removeReceipt();
  return {
    file: executable,
    env: env,
    owner: o.owner,
    read: read,
    before: function () {
      var previous = read();
      if (previous && previous.status === "starting") throw error("browser_native_launch_unknown");
      removeReceipt();
      return null;
    },
    dispose: dispose
  };
}

module.exports = {
  TARGETS: TARGETS,
  checkAsset: checkAsset,
  ownerName: ownerName,
  prepare: prepare,
  selectAsset: selectAsset,
  sourceHash: sourceHash,
  verifyAssets: verifyAssets
};
