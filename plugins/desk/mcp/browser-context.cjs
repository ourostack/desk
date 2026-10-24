"use strict";
var fs = require("fs");
var os = require("os");
var common = require("./browser-context-common.cjs");
var legacy = require("./browser-native.cjs");
function nativeOwner(input, options) {
  if (input.action === "create") return false;
  var source = options.env || process.env;
  var state = require("./web.cjs").stateDir(source,source.HOME || source.USERPROFILE || os.homedir());
  if (fs.existsSync(state)) state = fs.realpathSync(state);
  var l = common.layout(state,input.contextId,"signed-in",options.socketRoot);
  try { fs.lstatSync(l.root); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  common.ownedDir(l.parent,false); common.ownedDir(l.root,false);
  common.checkOwned(require("path").join(l.root,l.markerName),false);
  var owner = JSON.parse(fs.readFileSync(require("path").join(l.root,l.markerName),"utf8"));
  if (owner.backend === "managed") {
    common.marker(l.root,common.layout(state,input.contextId,"signed-in",options.socketRoot,"managed").owner,false,l.markerName);
    return false;
  }
  common.marker(l.root,l.owner,false,l.markerName);
  common.checkOwned(l.configFile,false);
  return Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(l.configFile,"utf8")),"deskNativeContext");
}
function invoke(input, options, isCommand) {
  var o = options || {};
  return Promise.resolve().then(function() {
    var mode = legacy.validate(input,isCommand,true);
    var native = mode === "signed-in" && nativeOwner(input,o);
    if (native && input.action === "finish-sign-in")
      common.fail("invalid_context_state","Sign-in completion is only available for a new managed interactive context");
    if (mode === "private" || native)
      return isCommand ? legacy.command(input,o) : legacy.context(input,o);
    var args = isCommand ? ["run",input.contextId,"--"].concat(input.args) :
      input.action === "create" ? ["create"] : [input.action,input.contextId];
    var local = require("./browser-local.cjs");
    return local.run(args,Object.assign({},o,{interactive:input.interactive === true}),"signed-in");
  }).catch(function(error) {
    return {exitCode:1,payload:common.scrub(common.errorPayload(error),o.env || process.env)};
  });
}
function context(input, options) { return invoke(input,options,false); }
function command(input, options) { return invoke(input,options,true); }
function run(argv, options) {
  try {
    var parsed = legacy.parseArgv(argv);
    return invoke(parsed.input,options,parsed.isCommand);
  } catch (error) { return Promise.resolve({exitCode:1,payload:common.errorPayload(error)}); }
}
module.exports = {run:run,context:context,command:command};
if (require.main === module) legacy.runMain(run,__filename,{process:process,require:require,homeDir:os.homedir()});
