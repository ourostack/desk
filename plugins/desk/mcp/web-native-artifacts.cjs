"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-x64", "win32-arm64", "win32-ia32", "win32-x64"];

function artifactFamily(family, sourceFiles) {
  if (["browser-launch", "browser-messaging"].indexOf(family) === -1) throw new Error("invalid_native_artifact_family");
  var prefix = family.replace(/-/g, "_");
  function integrity() { return new Error(prefix.replace("browser_", "browser_native_") + "_integrity"); }
  function sourceHash(root) {
    var hash = crypto.createHash("sha256");
    (sourceFiles || ["go.mod", "main.go"]).forEach(function (name) {
      hash.update(name + "\n");
      hash.update(fs.readFileSync(path.join(root, "native", family, name)));
    });
    return hash.digest("hex");
  }
  function manifest(root) {
    var value = JSON.parse(fs.readFileSync(path.join(root, "artifacts", family, "manifest.json"), "utf8"));
    if (value.version !== 1 || value.sourceSha256 !== sourceHash(root) || !value.assets ||
        JSON.stringify(Object.keys(value.assets).sort()) !== JSON.stringify(TARGETS.slice().sort())) throw integrity();
    return value;
  }
  function checkAsset(file, sha256) {
    var info = fs.lstatSync(file);
    if (!info.isFile() || !/^[a-f0-9]{64}$/.test(sha256) ||
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== sha256) throw integrity();
  }
  function selectAsset(root, platform, arch) {
    var target = platform + "-" + arch;
    if (TARGETS.indexOf(target) === -1) throw new Error(prefix.replace("browser_", "browser_native_") + "_unsupported");
    var value = manifest(root);
    var file = path.join(root, "artifacts", family, target, "desk-" + family + (platform === "win32" ? ".exe" : ""));
    checkAsset(file, value.assets[target].sha256);
    return { file: file, sha256: value.assets[target].sha256 };
  }
  function verifyAssets(root) {
    TARGETS.forEach(function (target) {
      var parts = target.split("-");
      selectAsset(root, parts[0], parts[1]);
    });
    return { targets: TARGETS.slice() };
  }
  function copyPrivateAsset(root, platform, arch, destination) {
    var asset = selectAsset(root, platform, arch);
    fs.copyFileSync(asset.file, destination, fs.constants.COPYFILE_EXCL);
    try {
      fs.chmodSync(destination, 448);
      checkAsset(destination, asset.sha256);
    } catch (failure) {
      fs.unlinkSync(destination);
      throw failure;
    }
    return { file: destination, sha256: asset.sha256 };
  }
  return {
    TARGETS: TARGETS.slice(), sourceHash: sourceHash, checkAsset: checkAsset,
    selectAsset: selectAsset, verifyAssets: verifyAssets, copyPrivateAsset: copyPrivateAsset
  };
}

module.exports = { artifactFamily: artifactFamily };
