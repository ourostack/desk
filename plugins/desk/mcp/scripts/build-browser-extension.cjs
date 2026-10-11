"use strict";

var fs = require("fs");
var path = require("path");

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
}

module.exports = { run: run };
/* istanbul ignore next */
if (require.main === module) run(process.argv.slice(2));
