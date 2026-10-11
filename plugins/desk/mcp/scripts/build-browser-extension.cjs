"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

function run(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--verify")) {
    throw new Error("Usage: build-browser-extension.cjs [--verify]");
  }
  var plugin = path.resolve(__dirname, "../..");
  var source = path.join(plugin, "browser-context-broker", "src", "markers.mjs");
  var destination = path.join(plugin, "browser-extension", "markers.js");
  if (!fs.lstatSync(source).isFile()) throw new Error("browser_extension_source_invalid");
  if (args.length === 0) fs.copyFileSync(source, destination);
  if (!fs.lstatSync(destination).isFile() || !fs.readFileSync(source).equals(fs.readFileSync(destination))) {
    throw new Error("browser_extension_generated_source_mismatch");
  }
  var extension = path.dirname(destination);
  var files = [];
  function inventory(directory, prefix) {
    fs.readdirSync(directory).sort().forEach(function (name) {
      var relative = prefix + name;
      if (relative === "source-digest.js") return;
      var file = path.join(directory, name);
      var info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw new Error("browser_extension_source_invalid");
      if (info.isDirectory()) inventory(file, relative + "/");
      else if (info.isFile()) files.push([relative, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
      else throw new Error("browser_extension_source_invalid");
    });
  }
  inventory(extension, "");
  var digest = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  var digestFile = path.join(extension, "source-digest.js");
  var generated = 'export const SOURCE_DIGEST = "' + digest + '";\n';
  if (args.length === 0) fs.writeFileSync(digestFile, generated);
  if (!fs.existsSync(digestFile) || !fs.lstatSync(digestFile).isFile() || fs.readFileSync(digestFile, "utf8") !== generated) {
    throw new Error("browser_extension_generated_source_mismatch");
  }
}

module.exports = { run: run };
/* istanbul ignore next */
if (require.main === module) run(process.argv.slice(2));
