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
    var choice = bootstrap.selectNode({mcpRoot:__dirname,env:env,homeDir:os.homedir(),
      platform:process.platform,arch:process.arch,
      current:{path:process.execPath,version:process.version,abi:process.versions.modules}});
    if (!choice.node) throw Object.assign(new Error("A compatible Node runtime is unavailable"),{code:"node_missing"});
    if (!choice.node.current) {
      return new Promise(function(resolve,reject) {
        var child = childProcess.spawn(choice.node.path,[__filename],{env:env,stdio:["pipe","pipe","pipe"],windowsHide:true});
        io.stdin.pipe(child.stdin); child.stdout.pipe(io.stdout); child.stderr.pipe(io.stderr);
        child.on("error",reject); child.on("close",resolve);
      });
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
    io.stderr.write("[desk-web] "+(error.code || "browser_frontend_unavailable")+"; serving explicit-context degraded tools\n");
    return require("./web.cjs").serveDegraded({stdin:io.stdin,stdout:io.stdout,payload:{
      status:"degraded",code:error.code || "browser_frontend_unavailable",
      summary:"The explicit browser frontend is unavailable",fix:"Preserve existing contexts and repair the declared runtime before reconnecting"
    }});
  });
}
module.exports = {run:run};
if (require.main === module) run();
