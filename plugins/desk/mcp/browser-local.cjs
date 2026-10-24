// One maintained local CLI controller for isolated and owned-profile contexts.
"use strict";
var fs = require("fs");
var path = require("path");
var os = require("os");
var web = require("./web.cjs");
var common = require("./browser-context-common.cjs");
function validate(argv, mode) {
  if (!Array.isArray(argv) || argv.some(function(a) { return typeof a !== "string" || a.indexOf("\0") !== -1; }))
    common.fail("invalid_arguments","Expected string arguments");
  var verb = argv[0];
  if (verb === "create" && argv.length === 1) return;
  if (["keep","resume","discard","run","finish-sign-in"].indexOf(verb) === -1 || common.modeOf(argv[1]) !== mode ||
      (verb === "finish-sign-in" && mode !== "signed-in"))
    common.fail("invalid_arguments","Use create, keep/resume/discard <context-id>, or run <context-id> -- <page-command>");
  if (verb !== "run") {
    if (argv.length !== 2) common.fail("invalid_arguments","Unexpected control arguments");
  } else {
    if (argv[2] !== "--") common.fail("invalid_arguments","Expected run <context-id> -- <page-command>");
    common.validatePageArgs(argv.slice(3),mode);
  }
}
function run(argv, options, mode) {
  var o = options || {}, source = o.env || process.env, id, resources, absent = false;
  var managed = mode === "signed-in";
  return Promise.resolve().then(function() {
    if (mode !== "private" && !managed) common.fail("invalid_arguments","Unknown local browser mode");
    validate(argv,mode);
    id = argv[0] === "create" ? (o.contextId ? o.contextId() : common.generateId(mode)) : argv[1];
    if (common.modeOf(id) !== mode) common.fail("invalid_arguments","Invalid generated context ID");
    if (argv[0] !== "create") {
      var state = web.stateDir(source,source.HOME || source.USERPROFILE || os.homedir());
      var l = common.layout(fs.existsSync(state) ? fs.realpathSync(state) : state,id,mode,o.socketRoot,managed ? "managed" : undefined);
      try { common.ownedDir(l.parent,false); } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { fs.lstatSync(l.root); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (argv[0] !== "discard" || managed) common.fail("context_absent","Browser context is absent; it was not recreated");
        absent = true; return null;
      }
      common.ownedDir(l.parent,false); common.ownedDir(l.root,false);
      common.marker(l.root,l.owner,false,l.markerName);
      if (managed && retired(l)) {
        if (argv[0] !== "discard") common.fail("context_discarded","This browser context was discarded; create a new handle for new work");
      }
    }
    return (o.prepareBrowserRuntime || web.prepareBrowserRuntime)(o);
  }).then(function(runtime) {
    if (absent) return {state:"absent"};
    var cliDir = path.join(runtime.installed.dir,"node_modules","playwright-core","lib","tools","cli-client");
    ["program","registry","session"].forEach(function(name) {
      if (!fs.existsSync(path.join(cliDir,name+".js"))) common.fail("unsupported_cli","Installed generation does not support the maintained private CLI");
    });
    var l = common.layout(fs.realpathSync(runtime.stateRoot),id,mode,o.socketRoot,managed ? "managed" : undefined);
    var creating = argv[0] === "create";
    resources = {contextDirectory:l.root,disposition:"owner-private directories retained; exports are never erased"};
    if (!creating && (!fs.existsSync(l.parent) || !fs.existsSync(l.root)))
      common.fail("context_absent","Private context disappeared while preparing the runtime; cleanup remains unconfirmed");
    return (managed ? require("./browser-native.cjs").protectSigned(l,runtime.stateRoot,creating) : Promise.resolve()).then(function() {
    common.ownedDir(l.parent,creating);
    if (creating && !managed) fs.mkdirSync(l.root,{mode:448});
    common.ownedDir(l.root,false);
    common.marker(l.root,l.owner,creating,l.markerName);
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
      var exists = o.browserExists || function(file) {
        try { return fs.statSync(file).isFile(); } catch (_) { return false; }
      };
      var selected = managed ? managedBrowser(source,o,exists) : web.browserSelection([],process.platform,source,exists);
      choice = selected.args;
      var config = {browser:{isolated:true,launchOptions:{headless:true}}};
      if (selected.executablePath) config.browser.launchOptions.executablePath = selected.executablePath;
      if (managed) {
        config.browser.browserName = "chromium";
        config.browser.isolated = false;
        config.browser.userDataDir = path.join(l.root,"profile");
        config.browser.launchOptions.chromiumSandbox = true;
        config.browser.launchOptions.channel = selected.channel;
        config.browser.launchOptions.headless = o.interactive !== true;
        common.ownedDir(config.browser.userDataDir,true);
      }
      fs.writeFileSync(l.configFile,JSON.stringify(config),{flag:"wx",mode:384});
    }
    common.checkOwned(l.configFile,false);
    if (managed) common.validateManagedConfig(JSON.parse(fs.readFileSync(l.configFile,"utf8")),l.root);
    resources.socketDirectory = l.socketDir;
    if (creating) fs.mkdirSync(l.socketDir,{mode:448});
    common.ownedDir(l.socketDir,false); common.marker(l.socketDir,l.owner,creating,l.markerName);
    var env = common.environment(source,l.root,l.socketDir,runtime.nodePath,
      managed ? {nativeHome:o.nativeHome || os.userInfo().homedir} : undefined);
    var request = {mode:mode,operation:argv[0],contextId:id,cliDir:cliDir,root:l.root,socketDir:l.socketDir,args:argv.slice(3)};
    if (managed) request.backend = "managed";
    if (creating) request.browserArgs = (choice.indexOf("--browser") === -1 ? [] : ["--browser",choice[choice.indexOf("--browser")+1]])
      .concat(managed ? ["--persistent","--profile="+path.join(l.root,"profile")] : [])
      .concat(managed && o.interactive ? ["--headed"] : []).concat(["--config="+l.configFile]);
    if (argv[0] === "finish-sign-in") {
      var launch = JSON.parse(fs.readFileSync(l.configFile,"utf8")).browser.launchOptions;
      request.browserArgs = ["--browser",launch.channel,"--persistent","--profile="+path.join(l.root,"profile"),"--config="+l.configFile];
    }
    return (managed ? protectManagedFiles(l,creating) : Promise.resolve()).then(function() {
      function execute() {
        var identity;
        if (managed) {
          common.marker(l.root,l.owner,false,l.markerName);
          if (retired(l) && argv[0] !== "discard") common.fail("context_discarded","This browser context was discarded; no command was replayed");
          var pending = common.readManagedState(l.root,".managed-sign-in-handoff.json",id);
          if (pending && pending.phase !== "completed" && ["discard","finish-sign-in"].indexOf(argv[0]) === -1)
            common.fail("sign_in_incomplete","Complete or discard the explicit sign-in handoff before ordinary page work");
          common.validateManagedConfig(JSON.parse(fs.readFileSync(l.configFile,"utf8")),l.root);
          if (argv[0] === "discard") {
            var cleanup = common.readManagedState(l.root,".managed-discard.json",id);
            if (!cleanup) {
              cleanup = {version:1,contextId:id,profile:common.profileIdentity(l.root)};
              common.atomicJson(path.join(l.root,".managed-discard.json"),cleanup);
            }
            identity = cleanup.profile;
            // Validate identity before shutdown; singleton use is checked after
            // fresh daemon-exit proof, when the browser has released its locks.
            var current;
            try { current = common.profileIdentity(l.root); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (current && JSON.stringify(current) !== JSON.stringify(identity))
              common.fail("cleanup_unconfirmed","Authentication-profile identity changed; cleanup retained");
            var tombstone = path.join(l.root,".desk-context-discarded");
            common.marker(l.root,l.owner,!fs.existsSync(tombstone),".desk-context-discarded");
          } else identity = common.profileIdentity(l.root);
        }
        return Promise.resolve((o.execute || common.execute)(runtime.nodePath,
        [path.join(__dirname,managed ? "browser-context-runtime.cjs" : "private-browser-runtime.cjs"),JSON.stringify(request)],
        {cwd:l.root,env:env,mode:mode})).then(function(result) {
          if (!result || typeof result !== "object" || result.isError ||
              (argv[0] === "discard" ? ["discarded","absent"].indexOf(result.state) === -1 : result.state !== "running"))
            common.fail("runner_failed","Browser runner did not confirm "+argv[0]+"; cleanup remains unconfirmed");
          if (managed && argv[0] === "discard") {
            if (result.state !== "discarded") common.fail("cleanup_unconfirmed","Session metadata absence does not prove authentication-profile disposal");
            return retireManaged(l,identity).then(function() {
              resources.profileDisposition = "removed";
              resources.disposition = "discarded; authentication profile removed and exports retained";
              return result;
            });
          }
          return result;
        });
      }
      return managed ? new Function("url","return import(url)")(require("url").pathToFileURL(path.join(__dirname,"src/util/broker-lock.mjs")).href)
        .then(function(locks) { return locks.withBrokerLock(runtime.stateRoot,execute,{name:"browser-context-"+id}); }) : execute();
    });
    });
  }).then(function(result) {
    var payload = {contextId:id,mode:mode,state:result.state,result:result.result};
    payload[managed ? "contextResources" : "resources"] = resources;
    return {exitCode:0,payload:common.scrub(payload,source)};
  },function(error) {
    var payload = common.errorPayload(error);
    payload.code = error.code || (managed ? "managed_browser_failed" : "private_browser_failed"); payload.contextId = id;
    if (managed) { payload.mode = mode; if (resources !== undefined) payload.contextResources = resources; }
    else if (payload.resources !== undefined) payload.resources = Object.assign({},resources,{operation:payload.resources});
    else payload.resources = resources;
    return {exitCode:1,payload:common.scrub(payload,source)};
  });
}
function retired(l) {
  if (common.readManagedState(l.root,".managed-discard.json",JSON.parse(l.owner).contextId)) return true;
  try { fs.lstatSync(path.join(l.root,".desk-context-discarded")); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  common.marker(l.root,l.owner,false,".desk-context-discarded"); return true;
}
function retireManaged(l, identity) {
  var profile = path.join(l.root,"profile");
  if (!common.profileUnused(l.root,identity,true)) return Promise.resolve();
  common.marker(l.root,l.owner,false,l.markerName);
  return fs.promises.rm(profile,{recursive:true}).then(function() {
    try { fs.lstatSync(profile); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    common.fail("cleanup_unconfirmed","Authentication-profile removal is unconfirmed");
  });
}
function protectManagedFiles(l, creating) {
  var paths = [{path:l.socketDir,kind:"directory"},
    {path:l.configFile,kind:"file"},{path:path.join(l.root,l.markerName),kind:"file"},
    {path:path.join(l.socketDir,l.markerName),kind:"file"}];
  if (creating || fs.existsSync(path.join(l.root,"profile"))) paths.push({path:path.join(l.root,"profile"),kind:"directory"});
  function load(file) { return new Function("url","return import(url)")(require("url").pathToFileURL(path.join(__dirname,file)).href); }
  var prepared = Promise.resolve();
  if (creating && process.platform === "win32") prepared = load("src/factory/windows-acl.js").then(function(acl) {
    return acl.protectWindowsPaths(paths.map(function(item) { return {path:item.path,kind:item.kind,created:true}; }),
      {label:"desk_browser_context"});
  });
  else if (creating) prepared = load("src/factory/os-protect.js").then(function(protection) {
    return paths.reduce(function(pending,item) {
      return pending.then(function() {
        var naming = {label:"desk_browser_context",subject:"browser context"};
        return item.kind === "directory" ? protection.ensureOwnerOnlyDirectory(item.path,process.platform,naming) :
          protection.protectLeafFile(item.path,process.platform,naming);
      });
    },Promise.resolve());
  });
  return prepared.then(function() {
    require("./web-native-messaging.cjs").privatePaths(paths.map(function(item) {
      return {file:item.path,directory:item.kind === "directory"};
    }));
  });
}
function managedBrowser(source, options, exists) {
  var home = options.nativeHome || os.userInfo().homedir;
  var declaration = require("./web-real-profile.cjs").readDeclaration({env:source,homeDir:home});
  if (declaration.state !== "none" && declaration.state !== "declared")
    common.fail("browser_declaration_unavailable",declaration.summary || "The configured browser declaration is unavailable");
  var channels = declaration.state === "declared" ? [declaration.channel] : ["msedge","chrome"];
  for (var i = 0; i < channels.length; i += 1) {
    var selected = require("./web-browser-discovery.cjs").channelBrowserSelection(channels[i],process.platform,source,exists,{nativeHome:home});
    if (selected.executablePath) {
      selected.channel = channels[i];
      selected.args = ["--browser",channels[i]];
      return selected;
    }
  }
  common.fail("browser_missing","Install the declared Edge or Chrome browser; no signed-out substitute was launched");
}
module.exports = {run:run};
