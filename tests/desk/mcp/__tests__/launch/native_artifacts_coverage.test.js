import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import platformPath from "node:path";
import vm from "node:vm";
import Module, { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { different } from "../_file_identity.js";

const require = createRequire(import.meta.url);
const path = platformPath.posix; // The in-memory filesystem has a POSIX namespace on every host.
const filename = platformPath.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/web-native-artifacts.cjs");
require(filename); // Ordinary canonical load initializes the normal collector.
const sha = value => createHash("sha256").update(value).digest("hex");

// Use Node's existing CJS extension loader, including its ordinary NYC hook.
// Only the fs resource boundary is virtual; canonical source is never edited.
function load(io) {
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(platformPath.dirname(filename));
  module.require = name => name === "fs" ? io : name === "path" ? path : require(name);
  module._compile = (source, file) => {
    const wrapper = vm.runInNewContext(Module.wrap(source), {
      Buffer, __coverage__: global.__coverage__,
    }, { filename: file });
    wrapper.call(module.exports, module.exports, module.require, module, file, platformPath.dirname(file));
  };
  (Module._extensions[".cjs"] || Module._extensions[".js"])(module, filename);
  return module.exports;
}

function fixture(familyName = "browser-messaging") {
  const root = "/owned/artifacts-fixture", nodes = new Map(), modes = [], reads = [];
  let next = 1, statHook;
  function put(file, value, directory = false) {
    nodes.set(file, { bytes: Buffer.from(value), directory, ino: next++, dev: 1,
      mtimeNs: 1n, ctimeNs: 1n, nlink: 1, link: false });
  }
  function dirs(file) {
    if (nodes.has(file)) return;
    const parent = path.dirname(file);
    if (parent !== file) dirs(parent);
    put(file, "", true);
  }
  const io = {
    lstatSync(file, options) {
      const node = nodes.get(file);
      if (!node) throw Object.assign(Error("owned missing node"), { code: "ENOENT" });
      const stat = { dev: BigInt(node.dev), ino: BigInt(node.ino), size: BigInt(node.bytes.length),
        mtimeNs: node.mtimeNs, ctimeNs: node.ctimeNs, nlink: node.nlink,
        isDirectory: () => node.directory && !node.link, isFile: () => !node.directory && !node.link, isSymbolicLink: () => node.link };
      return statHook?.(file, options, stat) || stat;
    },
    readdirSync(directory) {
      return [...nodes.keys()].filter(file => path.dirname(file) === directory).map(file => path.basename(file));
    },
    readFileSync(file) { reads.push(file); return Buffer.from(nodes.get(file).bytes); },
    copyFileSync(from, to, flags) {
      assert.equal(flags, fs.constants.COPYFILE_EXCL);
      if (nodes.has(to)) throw Object.assign(Error("owned destination exists"), { code: "EEXIST" });
      put(to, nodes.get(from).bytes);
    },
    chmodSync(file, mode) { modes.push({ file, mode }); },
    constants: fs.constants,
  };
  const api = load(io), names = ["go.mod", "main.go"], family = api.artifactFamily(familyName, names);
  dirs(path.join(root, "native", familyName));
  for (const name of names) put(path.join(root, "native", familyName, name), name === "go.mod" ? "module owned\n" : "package main\n");
  const sourceHash = sha("go.mod\nmodule owned\nmain.go\npackage main\n");
  const assets = {};
  for (const target of family.TARGETS) {
    const file = path.join(root, "artifacts", familyName, target, "desk-" + familyName + (target.startsWith("win32") ? ".exe" : ""));
    dirs(path.dirname(file)); put(file, target);
    assets[target] = { sha256: sha(target) };
  }
  const manifestFile = path.join(root, "artifacts", familyName, "manifest.json");
  const manifest = { version: 1, goVersion: "1.27.1", sourceSha256: sourceHash, assets, provenance: family.provenance };
  const writeManifest = value => put(manifestFile, JSON.stringify(value));
  writeManifest(manifest);
  return { root, api, family, names, nodes, reads, modes, io, put, dirs, manifest, manifestFile, writeManifest,
    statHook(value) { statHook = value; } };
}

test("artifact families reject unsupported names and ambiguous production input sets", () => {
  const { api } = fixture();
  for (const [family, names] of [
    ["other", ["main.go"]], ["browser-launch", null], ["browser-messaging", []],
    ["browser-messaging", ["nested/main.go"]], ["browser-launch", ["main.go", "main.go"]],
  ]) assert.throws(() => api.artifactFamily(family, names), /invalid_native_artifact_family/);
});

for (const familyName of ["browser-launch", "browser-messaging"]) {
  test(`${familyName} selects all real target shapes and copies exclusively with verified readback`, () => {
    const f = fixture(familyName);
    assert.equal(f.family.sourceHash(f.root), f.manifest.sourceSha256);
    assert.deepEqual(Array.from(f.family.verifyAssets(f.root).targets), [
      "darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-x64", "win32-arm64", "win32-ia32", "win32-x64",
    ]);
    const destination = "/owned/private-copy";
    const copied = f.family.copyPrivateAsset(f.root, "linux", "x64", destination);
    assert.equal(copied.sha256, sha("linux-x64"));
    assert.equal(f.nodes.get(destination).bytes.toString(), "linux-x64");
    assert.deepEqual(f.modes, [{ file: destination, mode: 0o700 }], "mode operation is virtual, never a real permission edit");
    assert.throws(() => f.family.copyPrivateAsset(f.root, "linux", "x64", destination), { code: "EEXIST" });
    assert.equal(f.nodes.get(destination).bytes.toString(), "linux-x64");
    assert.equal(f.modes.length, 1, "exclusive refusal never changes the existing destination mode");
    assert.throws(() => f.family.selectAsset(f.root, "linux", "ia32"), /unsupported/);
  });
}

test("artifact manifest schema, provenance, target entries and size bounds cannot certify a payload", () => {
  for (const change of ["version", "compiler", "source", "assets", "target", "provenance", "null-entry", "bad-digest", "large", "json", "null"]) {
    const f = fixture(), value = JSON.parse(JSON.stringify(f.manifest));
    if (change === "version") value.version = 2;
    if (change === "compiler") value.goVersion = "wrong";
    if (change === "source") value.sourceSha256 = "0".repeat(64);
    if (change === "assets") value.assets = null;
    if (change === "target") delete value.assets["linux-arm"];
    if (change === "provenance") value.provenance.compiler = "unverified";
    if (change === "null-entry") value.assets["linux-x64"] = null;
    if (change === "bad-digest") value.assets["linux-x64"].sha256 = "not-a-sha";
    f.writeManifest(value);
    if (change === "large") f.put(f.manifestFile, " ".repeat(16385));
    if (change === "json") f.put(f.manifestFile, "{");
    if (change === "null") f.writeManifest(null);
    assert.throws(() => f.family.selectAsset(f.root, "linux", "x64"), /browser_native_messaging_integrity/, change);
    assert.throws(() => f.family.verifyAssets(f.root), /browser_native_messaging_integrity/, change);
  }
});

test("artifact reads refuse root/ancestor/file links, hardlinks, wrong types and unknown build inputs", () => {
  for (const change of ["root-link", "root-file", "parent-file", "file-link", "hardlink", "directory", "extra", "extra-link", "test-only"]) {
    const f = fixture(), source = path.join(f.root, "native/browser-messaging/main.go");
    if (change === "root-link") f.nodes.get(f.root).link = true;
    if (change === "root-file") f.nodes.get(f.root).directory = false;
    if (change === "parent-file") f.nodes.get(path.dirname(source)).directory = false;
    if (change === "file-link") f.nodes.get(source).link = true;
    if (change === "hardlink") f.nodes.get(source).nlink = 2;
    if (change === "directory") f.nodes.get(source).directory = true;
    if (change === "extra") f.put(path.join(path.dirname(source), "extra.syso"), "unhashed");
    if (change === "extra-link") { f.put(path.join(path.dirname(source), "extra_test.go"), "test"); f.nodes.get(path.join(path.dirname(source), "extra_test.go")).link = true; }
    if (change === "test-only") f.put(path.join(path.dirname(source), "owned_test.go"), "owned test");
    if (change === "test-only") assert.equal(f.family.sourceHash(f.root), f.manifest.sourceSha256);
    else assert.throws(() => f.family.sourceHash(f.root), /integrity/, change);
  }
  const f = fixture();
  f.names.push("caller-mutation.go");
  assert.equal(f.family.sourceHash(f.root), f.manifest.sourceSha256, "caller input array was copied");
  f.family.provenance.sourceFiles.push("../../../../outside");
  assert.throws(() => f.family.sourceHash(f.root), /integrity/);
  assert.equal(f.reads.some(file => file === "/outside"), false, "mutable provenance cannot admit an escaping source path");
});

test("artifact stat identity and byte-size races reject all changed snapshot fields", () => {
  for (const change of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "length"]) {
    const f = fixture(), target = path.join(f.root, "native/browser-messaging/main.go");
    let observations = 0;
    f.statHook((file, options, stat) => {
      if (file === target && options?.bigint && ++observations === 2) {
        if (change === "length") return stat;
        return { ...stat, [change]: different(stat[change]) };
      }
    });
    // The length arm requires an actual different read length, not a fabricated
    // coverage condition: change the read result without changing stat size.
    if (change === "length") f.io.readFileSync = file => file === target ? Buffer.from("short") : Buffer.from(f.nodes.get(file).bytes);
    assert.throws(() => f.family.sourceHash(f.root), /integrity/, change);
  }
});

test("artifact copy/readback refusal retains its exact destination, never unlinks a replacement", () => {
  const f = fixture(), destination = "/owned/private-copy";
  f.io.copyFileSync = (_from, to) => { f.put(to, "changed after exclusive copy"); };
  assert.throws(() => f.family.copyPrivateAsset(f.root, "linux", "x64", destination), /integrity/);
  assert.equal(f.nodes.get(destination).bytes.toString(), "changed after exclusive copy");
  f.nodes.get(destination).link = true;
  assert.throws(() => f.family.checkAsset(destination, sha("changed after exclusive copy")), /integrity/);
  const denied = fixture();
  denied.io.copyFileSync = () => { throw Object.assign(Error("owned copy refusal"), { code: "EACCES" }); };
  assert.throws(() => denied.family.copyPrivateAsset(denied.root, "linux", "x64", destination), { code: "EACCES" });
  assert.equal(denied.nodes.has(destination), false);
  assert.deepEqual(denied.modes, []);
  const retained = fixture();
  retained.io.chmodSync = () => { throw Object.assign(Error("owned mode refusal"), { code: "EACCES" }); };
  assert.throws(() => retained.family.copyPrivateAsset(retained.root, "linux", "x64", destination), { code: "EACCES" });
  assert.equal(retained.nodes.get(destination).bytes.toString(), "linux-x64");
});

// On-device setup needs only this computer's helper. Antivirus removed the
// Windows helper from an installed Mac plugin, and the all-targets check then
// refused browser setup on the Mac too.
const windowsHelper = "artifacts/browser-messaging/win32-x64/desk-browser-messaging.exe";
test("host check accepts another platform's missing helper and names it", () => {
  for (const removed of ["file", "directory"]) {
    const f = fixture(), file = path.join(f.root, windowsHelper);
    f.nodes.delete(file);
    if (removed === "directory") f.nodes.delete(path.dirname(file));
    const result = f.family.verifyHostAssets(f.root, "linux", "x64");
    assert.deepEqual(Array.from(result.missing, entry => ({ ...entry })), [{ target: "win32-x64", file: windowsHelper }], removed);
    assert.equal(result.targets.includes("win32-x64"), false, removed);
    assert.equal(result.targets.length, 7, removed);
    assert.throws(() => f.family.verifyAssets(f.root), /browser_native_messaging_integrity/, "the release check still needs every helper");
  }
  const complete = fixture();
  assert.deepEqual(Array.from(complete.family.verifyHostAssets(complete.root, "linux", "x64").missing), []);
});

test("host check refuses this computer's missing or changed helper and any changed helper", () => {
  for (const [change, target] of [["host-missing", "linux-x64"], ["host-bytes", "linux-x64"], ["other-bytes", "win32-x64"],
    ["other-link", "win32-x64"], ["other-directory-file", "win32-x64"], ["other-directory-link", "win32-x64"], ["other-unreadable", "win32-x64"]]) {
    const f = fixture();
    const file = path.join(f.root, "artifacts/browser-messaging", target, "desk-browser-messaging" + (target.startsWith("win32") ? ".exe" : ""));
    if (change === "host-missing") f.nodes.delete(file);
    if (change.endsWith("bytes")) f.put(file, "changed helper bytes");
    if (change === "other-link") f.nodes.get(file).link = true;
    if (change === "other-directory-file") { f.nodes.delete(file); f.nodes.get(path.dirname(file)).directory = false; }
    if (change === "other-directory-link") { f.nodes.delete(file); f.nodes.get(path.dirname(file)).link = true; }
    if (change === "other-unreadable") f.statHook(name => {
      if (name === file) throw Object.assign(Error("owned unreadable helper"), { code: "EACCES" });
    });
    assert.throws(() => f.family.verifyHostAssets(f.root, "linux", "x64"),
      error => /browser_native_messaging_integrity/.test(error.message) && error.target === target, change);
  }
  const manifest = fixture();
  manifest.writeManifest({ ...manifest.manifest, goVersion: "wrong" });
  assert.throws(() => manifest.family.verifyHostAssets(manifest.root, "linux", "x64"),
    error => /browser_native_messaging_integrity/.test(error.message) && error.target === undefined);
});

test("host check on a computer with no shipped helper treats every helper as another platform's", () => {
  const f = fixture();
  f.nodes.delete(path.join(f.root, windowsHelper));
  const result = f.family.verifyHostAssets(f.root, "linux", "ia32");
  assert.deepEqual(Array.from(result.missing, entry => entry.target), ["win32-x64"]);
});
