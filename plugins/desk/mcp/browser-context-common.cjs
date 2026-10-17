"use strict";
// Shared parent operations. No native, CLI or SDK initialization on import.
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var childProcess = require("child_process");
var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var SIGNED = new RegExp("^" + UUID + "$");
var PRIVATE = new RegExp("^private-" + UUID + "$");
var COMMANDS = ("goto type click dblclick fill drag drop hover select upload check uncheck snapshot find eval console dialog-accept dialog-dismiss resize run-code go-back go-forward reload press keydown keyup mousemove mousedown mouseup mousewheel screenshot pdf tab-list tab-new tab-close tab-select state-save cookie-list cookie-get cookie-set cookie-delete cookie-clear localstorage-list localstorage-get localstorage-set localstorage-delete localstorage-clear sessionstorage-list sessionstorage-get sessionstorage-set sessionstorage-delete sessionstorage-clear set-color-scheme set-reduced-motion set-forced-colors set-contrast set-media clear-color-scheme clear-reduced-motion clear-forced-colors clear-contrast clear-media requests request request-headers request-body response-headers response-body route route-list unroute network-state-set recording-start recording-stop tracing-start tracing-stop webmcp-list webmcp-call").split(" ");
function fail(code, message) { throw Object.assign(new Error(message), { code: code }); }
function modeOf(id) {
  if (typeof id === "string" && SIGNED.test(id)) return "signed-in";
  if (typeof id === "string" && PRIVATE.test(id)) return "private";
  fail("invalid_arguments", "Expected an explicit generated context handle");
}
function generateId(mode) {
  var bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  var hex = bytes.toString("hex");
  return (mode === "private" ? "private-" : "") + hex.slice(0,8) + "-" + hex.slice(8,12) + "-" +
    hex.slice(12,16) + "-" + hex.slice(16,20) + "-" + hex.slice(20);
}
function layout(stateRoot, id, mode, socketRoot) {
  if (modeOf(id) !== mode) fail("invalid_arguments", "Context namespace does not match its mode");
  var parent = path.join(stateRoot, mode === "private" ? "private" : "signed-in");
  var root = path.join(parent, id);
  var owner = JSON.stringify({contextId:id,directory:root});
  var shortBase = socketRoot || (process.platform === "win32" ? os.tmpdir() : "/tmp");
  return { parent:parent, root:root, owner:owner,
    markerName:mode === "private" ? ".desk-private-owner" : ".desk-context-owner",
    configFile:path.join(root,"config","browser.json"),
    socketDir:path.join(shortBase,"dp-"+(process.getuid ? process.getuid() : "win")+"-"+
      crypto.createHash("sha256").update(owner).digest("hex").slice(0,16)) };
}
function validatePageArgs(args, mode) {
  if (!Array.isArray(args) || !args.length || args.some(function(a) { return typeof a !== "string" || a.indexOf("\0") !== -1; }) ||
      COMMANDS.indexOf(args[0]) === -1) fail("invalid_arguments", "Only ordinary maintained page commands are allowed");
  for (var i = 1; i < args.length && args[i] !== "--"; i += 1) {
    if (/^-[^-]/.test(args[i]) ||
        /^--(?:no-)?(?:s|g|h|v|session|global|all|cdp(?:-endpoint)?|endpoint|extension|persistent|profile(?:-dir-name)?|user-data-dir|storage-state|config|browser|executable-path|headed|headless|isolated|device|mobile|idle-timeout|help|version)(?:=|$)/.test(args[i]) ||
        (mode === "signed-in" && /^--(?:no-)?(?:raw|json)(?:=|$)/.test(args[i]))) {
      fail("reserved_option", "Session, lifecycle, profile, configuration and connection overrides are not allowed");
    }
  }
}
function checkOwned(target, directory) {
  var stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 63) !== 0)) ||
      (!directory && stat.nlink !== 1)) fail("unsafe_path", "Context path is not owner-private: " + target);
}
function ownedDir(target, create) {
  if (create) {
    try { fs.mkdirSync(target, {mode:448}); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  checkOwned(target,true);
}
function marker(dir, value, create, markerName) {
  var file = path.join(dir,markerName || ".desk-private-owner");
  if (create) fs.writeFileSync(file,value,{flag:"wx",mode:384});
  checkOwned(file,false);
  if (fs.readFileSync(file,"utf8") !== value) fail("unsafe_path","Context ownership marker does not match");
}
function environment(source, root, socketDir, node) {
  var env = {};
  Object.keys(source).forEach(function(key) {
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USER|USERNAME|LANG|LC_[A-Z_]+)$/i.test(key)) env[key] = source[key];
  });
  env.HOME = path.join(root,"home"); env.USERPROFILE = env.HOME;
  env.XDG_CONFIG_HOME = path.join(root,"config"); env.XDG_CACHE_HOME = path.join(root,"cache");
  env.XDG_DATA_HOME = path.join(root,"data"); env.XDG_STATE_HOME = path.join(root,"state");
  env.XDG_RUNTIME_DIR = path.join(root,"runtime");
  env.LOCALAPPDATA = process.platform === "win32" ? path.join(env.HOME,"AppData","Local") : path.join(root,"local");
  env.APPDATA = process.platform === "win32" ? path.join(env.HOME,"AppData","Roaming") : path.join(root,"roaming");
  env.TMPDIR = socketDir; env.TMP = socketDir; env.TEMP = socketDir;
  return require("./web.cjs").withNodeFirst(env,node,process.platform);
}
function scrub(value, source) {
  if (typeof value === "string") {
    Object.keys(source).forEach(function(key) {
      if (/token|password|credential|authorization|secret/i.test(key) && typeof source[key] === "string" && source[key].length > 2)
        value = value.split(source[key]).join("<redacted>");
    });
    return value.replace(/(?:https?|wss?):\/\/[^\s"\\<>]+/gi,function(url) {
      return /@|[?&#](?:[^=&#]*(?:token|password|secret|auth|key|code)[^=&#]*)=/i.test(url) ? "<redacted-url>" : url;
    }).replace(/\b(Bearer|Basic)\s+[^\s"\\]+/gi,"$1 <redacted>")
      .replace(/((?:token|password|authorization|secret)["']*\s*[:=]\s*["']*)[^"'\\\s,&}]+/gi,"$1<redacted>");
  }
  if (Array.isArray(value)) return value.map(function(item) { return scrub(item,source); });
  if (value && typeof value === "object") {
    var copy = {};
    Object.keys(value).forEach(function(key) {
      Object.defineProperty(copy,key,{enumerable:true,value:/token|password|credential|authorization|secret/i.test(key) ? "<redacted>" : scrub(value[key],source)});
    });
    return copy;
  }
  return value;
}
function errorPayload(error) {
  var value = {isError:true,code:error.code || "upstream_failed",message:error.message || String(error)};
  ["resources","nativeTransport","relatedErrors"].forEach(function(key) { if (error[key] !== undefined) value[key] = error[key]; });
  return value;
}
function execute(node, args, options) {
  return new Promise(function(resolve,reject) {
    childProcess.execFile(node,args,{cwd:options.cwd,env:options.env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024},function(error,stdout,stderr) {
      var payload;
      try { payload = JSON.parse(stdout); } catch (_) {
        var diagnostic = options.mode === "private" ? ": "+(stderr || stdout || (error && (error.code || error.signal)) || "empty output") : "";
        reject(Object.assign(new Error("Browser runner did not return confirmed JSON"+diagnostic+"; owned effects remain unknown"),{code:"runner_failed"}));
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        reject(Object.assign(new Error("Browser runner returned an invalid result; cleanup remains unconfirmed"),{code:"runner_failed"})); return;
      }
      if (error || payload.isError) {
        payload.message = payload.message || payload.error || (options.mode === "private" && stderr) || "Upstream command failed";
        var projected = errorPayload(payload);
        reject(Object.assign(new Error(projected.message),projected));
      } else resolve(payload);
    });
  });
}
module.exports = {generateId:generateId,modeOf:modeOf,layout:layout,validatePageArgs:validatePageArgs,
  checkOwned:checkOwned,ownedDir:ownedDir,marker:marker,environment:environment,scrub:scrub,
  execute:execute,errorPayload:errorPayload,fail:fail};
