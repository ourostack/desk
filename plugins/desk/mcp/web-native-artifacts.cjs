"use strict";

// Generic artifact-family mechanics ported from ourostack/desk
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f, web-native-artifacts.cjs.
// No browser launcher, provider or dependency acquisition is imported.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-x64", "win32-arm64", "win32-ia32", "win32-x64"];
var GO_LICENSE = "Copyright 2009 The Go Authors.\n\n" +
  "Redistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are\nmet:\n\n" +
  "   * Redistributions of source code must retain the above copyright\nnotice, this list of conditions and the following disclaimer.\n" +
  "   * Redistributions in binary form must reproduce the above\ncopyright notice, this list of conditions and the following disclaimer\nin the documentation and/or other materials provided with the\ndistribution.\n" +
  "   * Neither the name of Google LLC nor the names of its\ncontributors may be used to endorse or promote products derived from\nthis software without specific prior written permission.\n\n" +
  "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS\n\"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT\nLIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR\nA PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT\nOWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,\nSPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT\nLIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,\nDATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY\nTHEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT\n(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE\nOF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n";

function artifactFamily(family, sourceFiles) {
  if (["browser-launch", "browser-messaging"].indexOf(family) === -1 ||
      !Array.isArray(sourceFiles) || !sourceFiles.length ||
      sourceFiles.some(function (name) { return !/^[a-zA-Z0-9_.-]+$/.test(name); }) ||
      new Set(sourceFiles).size !== sourceFiles.length) throw new Error("invalid_native_artifact_family");
  sourceFiles = sourceFiles.slice();
  var prefix = family.replace("browser-", "browser_native_").replace(/-/g, "_");
  function integrity() { return new Error(prefix + "_integrity"); }
  function plain(root, file) {
    var relative = path.relative(root, file);
    if (relative.indexOf(".." + path.sep) === 0 || path.isAbsolute(relative)) throw integrity();
    var current = root;
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw integrity();
    relative.split(path.sep).forEach(function (part, index, parts) {
      current = path.join(current, part);
      var info = fs.lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw integrity();
    });
  }
  function bytes(root, file) {
    plain(root, file);
    var before = fs.lstatSync(file, { bigint: true });
    var value = fs.readFileSync(file);
    var after = fs.lstatSync(file, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(function (key) { return before[key] !== after[key]; }) ||
        after.size.toString() !== String(value.length)) throw integrity();
    return value;
  }
  function sourceHash(root) {
    try {
      var directory = path.join(root, "native", family);
      fs.readdirSync(directory).forEach(function (name) {
        var info = fs.lstatSync(path.join(directory, name));
        // go build also consumes extra .go/.syso inputs. A four-file hash
        // cannot certify those bytes. Only regular test sources are excluded.
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
            (sourceFiles.indexOf(name) === -1 && !/_test\.go$/.test(name))) throw integrity();
      });
      var hash = crypto.createHash("sha256");
      sourceFiles.forEach(function (name) {
        hash.update(name + "\n");
        hash.update(bytes(root, path.join(root, "native", family, name)));
      });
      return hash.digest("hex");
    } catch (error) { throw integrity(); }
  }
  var provenance = {
    source: "ourostack/desk", predecessor: "60adac5ff6f14fbef6e371fa2983f84e0f7eba9f",
    sourceFiles: sourceFiles, compiler: "Go 1.27.1", goLicense: GO_LICENSE
  };
  function manifest(root) {
    try {
      var input = bytes(root, path.join(root, "artifacts", family, "manifest.json"));
      if (input.length > 16384) throw integrity();
      var value = JSON.parse(input.toString("utf8"));
      if (value.version !== 1 || value.goVersion !== "1.27.1" || value.sourceSha256 !== sourceHash(root) ||
          !value.assets || JSON.stringify(Object.keys(value.assets).sort()) !== JSON.stringify(TARGETS.slice().sort()) ||
          JSON.stringify(value.provenance) !== JSON.stringify(provenance)) throw integrity();
      return value;
    } catch (error) { throw integrity(); }
  }
  function checkAsset(file, sha256) {
    try {
      if (!/^[a-f0-9]{64}$/.test(sha256) ||
          crypto.createHash("sha256").update(bytes(path.dirname(file), file)).digest("hex") !== sha256) throw integrity();
    } catch (error) { throw integrity(); }
  }
  function selectAsset(root, platform, arch) {
    var target = platform + "-" + arch;
    if (TARGETS.indexOf(target) === -1) throw new Error(prefix + "_unsupported");
    var value = manifest(root);
    var file = path.join(root, "artifacts", family, target, "desk-" + family + (platform === "win32" ? ".exe" : ""));
    plain(root, file);
    checkAsset(file, value.assets[target] && value.assets[target].sha256);
    return { file: file, sha256: value.assets[target].sha256 };
  }
  function verifyAssets(root) {
    try {
      TARGETS.forEach(function (target) {
        var parts = target.split("-");
        selectAsset(root, parts[0], parts[1]);
      });
      return { targets: TARGETS.slice() };
    } catch (error) { throw integrity(); }
  }
  function copyPrivateAsset(root, platform, arch, destination) {
    var asset = selectAsset(root, platform, arch);
    fs.copyFileSync(asset.file, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 448);
    checkAsset(destination, asset.sha256);
    // A failed copy/readback remains an owned staging obligation. Do not
    // unlink an uncorroborated/replaced destination on an error path.
    return { file: destination, sha256: asset.sha256 };
  }
  return { TARGETS: TARGETS.slice(), sourceHash: sourceHash, checkAsset: checkAsset,
    selectAsset: selectAsset, verifyAssets: verifyAssets, copyPrivateAsset: copyPrivateAsset,
    provenance: provenance };
}

exports.artifactFamily = artifactFamily;
