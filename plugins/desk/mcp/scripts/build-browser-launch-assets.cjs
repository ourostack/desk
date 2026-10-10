"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var spawnSync = require("child_process").spawnSync;
var native = require("../web-native-launch.cjs");
var goArch = { x64: "amd64", ia32: "386", arm64: "arm64", arm: "arm" };
var goOS = { darwin: "darwin", linux: "linux", win32: "windows" };

function run(args, options) {
  var o = options || {};
  var root = o.root || path.resolve(__dirname, "..");
  var output = path.join(root, "artifacts", "browser-launch");
  var spawn = o.spawn || spawnSync;
  var stdout = o.stdout || process.stdout;
  if (args.length === 1 && args[0] === "--verify") {
    native.verifyAssets(root);
    stdout.write("Browser launch assets verified for all eight targets.\n");
  } else if (args.length !== 0) {
    throw new Error("Usage: build-browser-launch-assets.cjs [--verify]");
  } else {
    var version = spawn("go", ["version"], { encoding: "utf8", shell: false });
    if (version.status !== 0 || !/^go version go1\.27\.1 /.test(version.stdout)) throw new Error("Build browser launch assets with Go 1.27.1");
    var value = { version: 1, goVersion: "1.27.1", sourceSha256: native.sourceHash(root), assets: {} };
    native.TARGETS.forEach(function (target) {
      var parts = target.split("-");
      var dir = path.join(output, target);
      fs.mkdirSync(dir, { recursive: true });
      var file = path.join(dir, "desk-browser-launch" + (parts[0] === "win32" ? ".exe" : ""));
      var env = Object.assign({}, process.env, { GOOS: goOS[parts[0]], GOARCH: goArch[parts[1]], CGO_ENABLED: "0", GOARM: "7", GOTOOLCHAIN: "local" });
      var built = spawn("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid=", "-o", file, "."], {
        cwd: path.join(root, "native", "browser-launch"), env: env, encoding: "utf8", shell: false, timeout: 180000
      });
      if (built.status !== 0) throw new Error("Build failed for " + target + ": " + built.stderr);
      fs.chmodSync(file, 493);
      value.assets[target] = { sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
      stdout.write("Built " + target + "\n");
    });
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(value, null, 2) + "\n");
    native.verifyAssets(root);
  }
}

module.exports = { run: run };
/* istanbul ignore next */
if (require.main === module) run(process.argv.slice(2));
