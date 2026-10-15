"use strict";

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var REVISION = 1;
// Audited createServer from playwright-core 1.64.0-alpha-1790635538000.
// Match the lifecycle, not a package version: newer packages may retain this implementation.
var ORIGINAL_SHA256 = "0a0d6cd9bfae79dbda66509b6d01fad89fdc37629cc729e26db7b97d80b8fc4b";
var START = "function createServer(name, version3, factory, transportInitialized, runHeartbeat) {";
var END = "\nfunction addServerListener(";
var ANCHOR = "    try {\n";
var IDLE_CLOSE = [
  '      if (!backendPromise && request2.params.name === "browser_close") {',
  '        const closeTool = factory.toolSchemas.find((tool) => tool.name === "browser_close");',
  "        if (closeTool) {",
  "          const args = request2.params.arguments || {};",
  "          const json = !!args._meta?.json;",
  "          try {",
  "            closeTool.inputSchema.parse(args);",
  "          } catch (error) {",
  "            if (!(error instanceof zod.ZodError))",
  "              throw error;",
  '            const message = `Invalid arguments for tool "browser_close":\\n${zod.prettifyError(error)}`;',
  '            return { content: [{ type: "text", text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : "### Error\\n" + message }], isError: true };',
  "          }",
  '          const result = "No browser session is open.";',
  '          const text = json ? JSON.stringify({ result }, null, 2) : args._meta?.raw ? result : "### Result\\n" + result;',
  '          return { content: [{ type: "text", text }] };',
  "        }",
  "      }"
].join("\n") + "\n";

function unsupported() {
  var error = new Error("Unsupported Playwright MCP server lifecycle; the staged browser install was not published.");
  error.code = "PLAYWRIGHT_PATCH_UNSUPPORTED";
  return error;
}

function patchSource(source) {
  var start = source.indexOf(START);
  var end = source.indexOf(END, start);
  if (start < 0 || end < 0 || source.indexOf(START, start + START.length) !== -1) throw unsupported();
  var lifecycle = source.slice(start, end);
  var original = lifecycle;
  var alreadyPatched = lifecycle.indexOf(IDLE_CLOSE) !== -1;
  if (alreadyPatched) {
    original = lifecycle.replace(IDLE_CLOSE, "");
    if (original.indexOf(IDLE_CLOSE) !== -1) throw unsupported();
  }
  if (crypto.createHash("sha256").update(original).digest("hex") !== ORIGINAL_SHA256) throw unsupported();
  if (alreadyPatched) return source;
  var patched = original.replace(ANCHOR, ANCHOR + IDLE_CLOSE);
  return source.slice(0, start) + patched + source.slice(end);
}

function bundleFile(dir) {
  return path.join(dir, "node_modules", "playwright-core", "lib", "coreBundle.js");
}

function hash(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function apply(installed) {
  var file = bundleFile(installed.dir);
  var source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw unsupported();
    throw error;
  }
  var patched = patchSource(source);
  fs.writeFileSync(file, patched);
  fs.writeFileSync(path.join(installed.dir, "playwright-patch.json"), JSON.stringify({
    revision: REVISION, mcpVersion: installed.version, coreVersion: installed.core, bundleSha256: hash(patched)
  }) + "\n");
}

function readRevision(installed) {
  var receipt;
  var source;
  try {
    receipt = JSON.parse(fs.readFileSync(path.join(installed.dir, "playwright-patch.json"), "utf8"));
    if (!receipt || receipt.revision !== REVISION || receipt.mcpVersion !== installed.version || receipt.coreVersion !== installed.core) return 0;
    source = fs.readFileSync(bundleFile(installed.dir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return 0;
    throw error;
  }
  return hash(source) === receipt.bundleSha256 ? REVISION : 0;
}

// Do not follow package symlinks into profiles, credentials or another generation.
// Promise-based copying also works when an older host Node selected a compatible child Node.
function copyPackages(fromRoot, toRoot) {
  var canonicalRoot = fs.realpathSync(fromRoot);
  function copy(from, to) {
    return fs.promises.lstat(from).then(function (stat) {
      if (stat.isDirectory()) {
        return fs.promises.mkdir(to).then(function () {
          return fs.promises.readdir(from);
        }).then(function (entries) {
          return entries.reduce(function (previous, entry) {
            return previous.then(function () { return copy(path.join(from, entry), path.join(to, entry)); });
          }, Promise.resolve());
        });
      }
      if (stat.isSymbolicLink()) {
        return Promise.all([fs.promises.readlink(from), fs.promises.realpath(from), fs.promises.stat(from)]).then(function (values) {
          var relative = path.relative(canonicalRoot, values[1]);
          if (relative === ".." || relative.indexOf(".." + path.sep) === 0 || path.isAbsolute(relative)) {
            throw new Error("Cannot migrate a browser package symlink outside its installed package tree.");
          }
          var target = path.isAbsolute(values[0]) ? path.join(toRoot, relative) : values[0];
          return fs.promises.symlink(target, to, values[2].isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file");
        });
      }
      if (stat.isFile()) return fs.promises.copyFile(from, to);
      throw new Error("Cannot migrate a non-file entry in the installed browser package tree.");
    });
  }
  return copy(fromRoot, toRoot);
}

module.exports = { REVISION: REVISION, apply: apply, copyPackages: copyPackages, patchSource: patchSource, readRevision: readRevision };
