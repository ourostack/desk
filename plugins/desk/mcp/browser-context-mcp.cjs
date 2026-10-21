"use strict";
// Old-Node-compatible entry. Normal locked SDK restoration only, never browser
// preparation/acquisition or full Desk controller startup during MCP handshake.
var path = require("path");
var os = require("os");
var childProcess = require("child_process");
var bootstrap = require("./bootstrap.cjs");
function load(file) { return new Function("url","return import(url)")(require("url").pathToFileURL(file).href); }
function run(options) {
  var o = options || {}, env = o.env || process.env;
  var io = {stdin:o.stdin || process.stdin,stdout:o.stdout || process.stdout,stderr:o.stderr || process.stderr};
  return Promise.resolve().then(function() {
    var current = o.current || {path:process.execPath,version:process.version,abi:process.versions.modules};
    var choice = bootstrap.selectNode({mcpRoot:__dirname,env:env,homeDir:o.homeDir || env.HOME || env.USERPROFILE || os.homedir(),
      platform:o.platform || process.platform,arch:o.arch || process.arch,current:current,
      systemPrefix:o.systemPrefix === undefined ? env.DESK_NODE_SYSTEM_PREFIX || "" : o.systemPrefix,
      probe:o.probe,now:o.now});
    if (!choice.node) throw Object.assign(new Error("Desk needs Node.js "+choice.range+" to start the browser; this one is "+current.version),
      {code:"node_missing",fix:"Install Node "+choice.range+", then reconnect the desk-web MCP server"});
    if (!choice.node.current) {
      return bootstrap.reexec({node:choice.node.path,indexFile:__filename,args:[],env:env,
        spawn:o.spawn || childProcess.spawn,signals:o.signals || process,stderr:io.stderr,
        exit:o.exit || function(code) { process.exitCode = code; },kill:o.kill || process.kill,
        onSpawnError:function(error) { return Promise.reject(Object.assign(new Error("Could not start the compatible browser frontend: "+error.message),{code:"node_spawn_failed"})); }});
    }
    return load(path.join(__dirname,"src/runtime/bootstrap.js")).then(function(runtime) {
      var prepared = runtime.prepareRuntime({mcpRoot:__dirname,env:env,
        sourceIdentity:"sha256:"+runtime.hashCurrentSource(__dirname)});
      return load(path.join(prepared.sourceMirrorPath,"src/browser/context-mcp.js"));
    }).then(function(frontend) {
      return frontend.startContextMcpServer({tools:require("./web-catalog.json").tools,
        controller:require("./browser-context.cjs"),stdin:io.stdin,stdout:io.stdout});
    });
  }).catch(function(error) {
    var code = error && error.code || "browser_frontend_unavailable";
    var message = error && error.message || String(error);
    io.stderr.write("[web] "+message+"; serving degraded:"+code+"\n");
    return require("./web.cjs").serveDegraded({stdin:io.stdin,stdout:io.stdout,payload:{
      status:"degraded",state:"degraded:"+code,code:code,
      summary:message,fix:error && error.fix || "Preserve existing contexts and repair the declared runtime before reconnecting"
    }});
  });
}
module.exports = {run:run};
if (require.main === module) run();
