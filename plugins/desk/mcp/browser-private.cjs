// Explicit private facade. Its public argv, namespace and marker remain stable.
"use strict";
var fs = require("fs");
var path = require("path");
var os = require("os");
var web = require("./web.cjs");
var common = require("./browser-context-common.cjs");
function validate(argv) {
  if (!Array.isArray(argv) || argv.some(function(a) { return typeof a !== "string" || a.indexOf("\0") !== -1; }))
    common.fail("invalid_arguments","Expected string arguments");
  var verb = argv[0];
  if (verb === "create" && argv.length === 1) return;
  if (["keep","resume","discard","run"].indexOf(verb) === -1 || common.modeOf(argv[1]) !== "private")
    common.fail("invalid_arguments","Use create, keep/resume/discard <context-id>, or run <context-id> -- <page-command>");
  if (verb !== "run") {
    if (argv.length !== 2) common.fail("invalid_arguments","Unexpected control arguments");
  } else {
    if (argv[2] !== "--") common.fail("invalid_arguments","Expected run <context-id> -- <page-command>");
    common.validatePageArgs(argv.slice(3),"private");
  }
}
function run(argv, options) {
  var o = options || {}, source = o.env || process.env, id, resources, absent = false;
  return Promise.resolve().then(function() {
    validate(argv);
    id = argv[0] === "create" ? (o.contextId ? o.contextId() : common.generateId("private")) : argv[1];
    if (common.modeOf(id) !== "private") common.fail("invalid_arguments","Invalid generated context ID");
    if (argv[0] !== "create") {
      var state = web.stateDir(source,source.HOME || source.USERPROFILE || os.homedir());
      var l = common.layout(state,id,"private",o.socketRoot);
      try { common.ownedDir(l.parent,false); } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { fs.lstatSync(l.root); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (argv[0] !== "discard") common.fail("context_absent","Private context is absent; it was not recreated");
        absent = true; return null;
      }
      common.ownedDir(l.parent,false); common.ownedDir(l.root,false);
      common.marker(l.root,JSON.stringify({contextId:id,directory:path.join(fs.realpathSync(state),"private",id)}),false);
    }
    return (o.prepareBrowserRuntime || web.prepareBrowserRuntime)(o);
  }).then(function(runtime) {
    if (absent) return {state:"absent"};
    var cliDir = path.join(runtime.installed.dir,"node_modules","playwright-core","lib","tools","cli-client");
    ["program","registry","session"].forEach(function(name) {
      if (!fs.existsSync(path.join(cliDir,name+".js"))) common.fail("unsupported_cli","Installed generation does not support the maintained private CLI");
    });
    var l = common.layout(fs.realpathSync(runtime.stateRoot),id,"private",o.socketRoot);
    var creating = argv[0] === "create";
    resources = {contextDirectory:l.root,disposition:"owner-private directories retained; exports are never erased"};
    if (!creating && (!fs.existsSync(l.parent) || !fs.existsSync(l.root)))
      common.fail("context_absent","Private context disappeared while preparing the runtime; cleanup remains unconfirmed");
    common.ownedDir(l.parent,creating);
    if (creating) fs.mkdirSync(l.root,{mode:448});
    common.ownedDir(l.root,false);
    common.marker(l.root,l.owner,creating);
    [".playwright","home","config","cache","data","state","runtime","local","roaming"].forEach(function(dir) {
      common.ownedDir(path.join(l.root,dir),creating);
    });
    if (process.platform === "win32") {
      ["AppData",path.join("AppData","Local"),path.join("AppData","Roaming")].forEach(function(dir) {
        common.ownedDir(path.join(l.root,"home",dir),creating);
      });
    }
    resources.configFile = l.configFile;
    var choice = [];
    if (creating) {
      var selected = web.browserSelection([],process.platform,source,o.browserExists || function(file) {
        try { return fs.statSync(file).isFile(); } catch (_) { return false; }
      });
      choice = selected.args;
      var config = {browser:{isolated:true,launchOptions:{headless:true}}};
      if (selected.executablePath) config.browser.launchOptions.executablePath = selected.executablePath;
      fs.writeFileSync(l.configFile,JSON.stringify(config),{flag:"wx",mode:384});
    }
    common.checkOwned(l.configFile,false);
    resources.socketDirectory = l.socketDir;
    if (creating) fs.mkdirSync(l.socketDir,{mode:448});
    common.ownedDir(l.socketDir,false); common.marker(l.socketDir,l.owner,creating);
    var env = common.environment(source,l.root,l.socketDir,runtime.nodePath);
    var request = {operation:argv[0],contextId:id,cliDir:cliDir,root:l.root,socketDir:l.socketDir,args:argv.slice(3)};
    if (creating) request.browserArgs = (choice.indexOf("--browser") === -1 ? [] : ["--browser",choice[choice.indexOf("--browser")+1]]).concat(["--config="+l.configFile]);
    return Promise.resolve((o.execute || common.execute)(runtime.nodePath,
      [path.join(__dirname,"private-browser-runtime.cjs"),JSON.stringify(request)],{cwd:l.root,env:env,mode:"private"})).then(function(result) {
      if (!result || typeof result !== "object" || result.isError ||
          (argv[0] === "discard" ? ["discarded","absent"].indexOf(result.state) === -1 : result.state !== "running"))
        common.fail("runner_failed","Private browser runner did not confirm "+argv[0]+"; cleanup remains unconfirmed");
      return result;
    });
  }).then(function(result) {
    return {exitCode:0,payload:common.scrub({contextId:id,mode:"private",state:result.state,result:result.result,resources:resources},source)};
  },function(error) {
    var payload = common.errorPayload(error);
    payload.code = error.code || "private_browser_failed"; payload.contextId = id;
    if (payload.resources !== undefined) payload.resources = Object.assign({},resources,{operation:payload.resources});
    else payload.resources = resources;
    return {exitCode:1,payload:common.scrub(payload,source)};
  });
}
module.exports = {run:run};
if (require.main === module) run(process.argv.slice(2)).then(function(result) {
  process.stdout.write(JSON.stringify(result.payload)+"\n"); process.exitCode = result.exitCode;
});
