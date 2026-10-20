"use strict";

// One-family port of the reproducible Go loop from ourostack/desk
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f. No absent launch wrapper.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var spawnSync = require("child_process").spawnSync;
var native = require("../web-native-artifacts.cjs").artifactFamily("browser-messaging",
  ["go.mod", "main.go", "private_unix.go", "private_windows.go"]);
var goArch = { x64: "amd64", ia32: "386", arm64: "arm64", arm: "arm" };
var goOS = { darwin: "darwin", linux: "linux", win32: "windows" };
function present(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function regularOutput(file) {
  var info = present(file);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error("browser_native_messaging_integrity");
}

function run(args, options) {
  var o = options || {}, root = path.resolve(o.root || path.join(__dirname, ".."));
  var spawn = o.spawn || spawnSync, stdout = o.stdout || process.stdout;
  if (args.length === 1 && args[0] === "--verify") {
    native.verifyAssets(root);
    stdout.write("browser-messaging assets verified for all eight targets.\n");
    return;
  }
  if (args.length !== 0) throw new Error("Usage: build-browser-messaging-assets.cjs [--verify]");
  var baseEnv = Object.assign({}, process.env, { GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOFLAGS: "", GOWORK: "off" });
  var version = spawn("go", ["version"], { env: baseEnv, encoding: "utf8", shell: false, timeout: 30000 });
  if (version.status !== 0 || !/^go version go1\.27\.1 /.test(version.stdout)) throw new Error("Build browser messaging assets with Go 1.27.1");
  var value = { version: 1, goVersion: "1.27.1", sourceSha256: native.sourceHash(root), assets: {}, provenance: native.provenance };
  var manifest = path.join(root, "artifacts/browser-messaging/manifest.json");
  regularOutput(manifest);
  native.TARGETS.forEach(function (target) {
    var parts = target.split("-"), directory = path.join(root, "artifacts/browser-messaging", target);
    var current = root;
    ["artifacts", "browser-messaging", target].forEach(function (part) {
      current = path.join(current, part);
      var info = present(current);
      if (!info) { fs.mkdirSync(current); info = fs.lstatSync(current); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("browser_native_messaging_integrity");
    });
    var file = path.join(directory, "desk-browser-messaging" + (parts[0] === "win32" ? ".exe" : ""));
    regularOutput(file);
    var built = spawn("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid=", "-o", file, "."], {
      cwd: path.join(root, "native/browser-messaging"), encoding: "utf8", shell: false, timeout: 180000,
      env: Object.assign({}, baseEnv, { GOOS: goOS[parts[0]], GOARCH: goArch[parts[1]], GOARM: "7" })
    });
    if (built.status !== 0) throw new Error("browser_native_messaging_build_failed_" + target);
    fs.chmodSync(file, 493);
    value.assets[target] = { sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    stdout.write("Built " + target + "\n");
  });
  if (native.sourceHash(root) !== value.sourceSha256) throw new Error("browser_native_messaging_integrity");
  regularOutput(manifest);
  fs.writeFileSync(manifest, JSON.stringify(value, null, 2) + "\n");
  native.verifyAssets(root);
}
module.exports = { run: run };
/* istanbul ignore next */
if (require.main === module) run(process.argv.slice(2));
