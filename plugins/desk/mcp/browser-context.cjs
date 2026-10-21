"use strict";
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var common = require("./browser-context-common.cjs");
var web = require("./web.cjs");
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(function(key) { return keys.indexOf(key) === -1; }))
    common.fail("invalid_arguments","Unexpected context arguments");
}
function label(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value))
    common.fail("invalid_arguments","A useful label of at most 120 characters without controls is required");
}
function validate(input, command) {
  object(input,command ? ["contextId","args"] : ["action","mode","label","contextId"]);
  if (Buffer.byteLength(JSON.stringify(input)) > 1048576) common.fail("invalid_arguments","Context request is too large");
  if (command) {
    var mode = common.modeOf(input.contextId);
    if (!Array.isArray(input.args) || !input.args.length || input.args.length > 256 ||
        input.args.some(function(arg) { return typeof arg !== "string" || arg.indexOf("\0") !== -1 || Buffer.byteLength(arg) > 65536; }))
      common.fail("invalid_arguments","Expected bounded string page arguments");
    common.validatePageArgs(input.args,mode); return mode;
  }
  if (input.action === "create") {
    if (Object.prototype.hasOwnProperty.call(input,"contextId") ||
        (input.mode !== undefined && ["signed-in","private"].indexOf(input.mode) === -1))
      common.fail("invalid_arguments","Create generates its handle and accepts only a declared mode");
    var creatingMode = input.mode || "signed-in";
    if (creatingMode === "signed-in" || input.label !== undefined) label(input.label);
    return creatingMode;
  }
  if (["keep","resume","discard"].indexOf(input.action) === -1 ||
      Object.prototype.hasOwnProperty.call(input,"mode") || Object.prototype.hasOwnProperty.call(input,"label"))
    common.fail("invalid_arguments","Expected create, keep, resume or discard with explicit contextId");
  return common.modeOf(input.contextId);
}
function moduleImport(file) {
  return new Function("url","return import(url)")(require("url").pathToFileURL(file).href);
}
function nativeSelection(runtime, source, input) {
  var installer;
  return Promise.resolve().then(function() {
  var profile = require("./web-real-profile.cjs"), discovery = require("./web-browser-discovery.cjs");
  var home = os.userInfo().homedir;
  var declaration = profile.readDeclaration({env:source,homeDir:home});
  if (declaration.state !== "declared") common.fail("browser_declaration_unavailable","An existing browser declaration is required for signed-in mode");
  var selected = discovery.channelBrowserSelection(declaration.channel,process.platform,source,function(file) {
    try { return fs.statSync(file).isFile(); } catch (_) { return false; }
  },{nativeHome:home});
  if (!selected.executablePath) common.fail("NATIVE_BROWSER_UNAVAILABLE","Declared browser executable is unavailable");
  var executable = fs.realpathSync(selected.executablePath);
  var userDataDir = fs.realpathSync(profile.userDataDir(declaration.channel,process.platform,source,home));
  var profileDirName = profile.findProfileDir(path.join(userDataDir,"Local State"),declaration.domain);
  if (!profileDirName) common.fail("browser_profile_unavailable","Declared existing profile is unavailable");
  return moduleImport(path.join(__dirname,"native-messaging-install.mjs")).then(function(distribution) {
    installer = distribution;
    return distribution.verifyNativeDistribution(path.dirname(__dirname));
  }).then(function(verified) {
  var nativeReadyFile = path.join(runtime.stateRoot,"native-owned","state","native-provider-"+
    crypto.createHash("sha256").update(executable+"\0"+path.join(userDataDir,profileDirName)).digest("hex")+".json");
  var client = require("./web-native-messaging.cjs");
  var selection = {channel:declaration.channel,userDataDir:userDataDir,profileDirName:profileDirName,
    nativeReadyFile:nativeReadyFile,extensionId:verified.extensionId,sourceDigest:verified.extensionSourceDigest,browserExecutable:executable};
  var ready, missing = false;
  try { ready = client.readPrivateJson(nativeReadyFile); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    missing = true;
  }
  if (missing && input.action !== "create")
    common.fail("NATIVE_READY_UNAVAILABLE","Existing native browser readiness is unavailable; no context was allocated");
  return Promise.resolve().then(function() {
    if (!missing) return ready;
    // Registration/capsule setup is not extension enrollment or native health.
    // The normal installer owns its existing lock, source and conflict checks.
    return installer.installNativeMessagingBootstrap({env:source,homeDir:home}).then(function() {
      try { return client.readPrivateJson(nativeReadyFile); }
      catch (error) {
        if (error.code === "ENOENT")
          common.fail("NATIVE_READY_UNAVAILABLE","Native host setup did not establish enrolled browser readiness; no context was allocated");
        throw error;
      }
    });
  }).then(function(current) {
  ready = current;
  if (!ready || ready.profileRoot !== path.join(userDataDir,profileDirName) || ready.extensionId !== selection.extensionId ||
      ready.sourceDigest !== selection.sourceDigest || !ready.browser || ready.browser.executable !== executable)
    common.fail("NATIVE_READY_INVALID","Existing native readiness does not match the selected profile/source");
  if (input.action === "create") label(input.label);
  if (input.action !== "create") return selection;
  // Existing C performs fresh ancestry/provider/profile admission. This record
  // is memory-only; no owner directory, context or config exists at this point.
  return client.attestNativeContext({version:1,contextId:common.generateId("signed-in"),
    label:input.label,channel:selection.channel,userDataDir:selection.userDataDir,
    profileDirName:selection.profileDirName,nativeReadyFile:selection.nativeReadyFile,
    extensionId:selection.extensionId,sourceDigest:selection.sourceDigest},selection).then(function() { return selection; });
  });
  });
  });
}
function protectSigned(l, stateRoot, creating) {
  var client = require("./web-native-messaging.cjs");
  return moduleImport(path.join(__dirname,"src/factory/os-protect.js")).then(function(protection) {
  var directories = [stateRoot,l.parent,l.root].concat([".playwright","home","config","cache","data","state","runtime","local","roaming"].map(function(dir) { return path.join(l.root,dir); }));
  if (process.platform === "win32") directories = directories.concat(["AppData","AppData/Local","AppData/Roaming"].map(function(dir) {
    return path.join(l.root,"home",dir);
  }));
  var naming = {label:"desk_browser_context",subject:"browser context"};
  return directories.reduce(function(pending, dir) {
    return pending.then(function() {
    var ensure = Promise.resolve();
    if (creating) {
      if (dir === l.root) fs.mkdirSync(dir,{mode:448});
      else ensure = protection.ensureOwnerOnlyDirectory(dir,process.platform,naming);
    }
    return ensure.then(function() {
    if (process.platform === "win32" && creating) {
      return moduleImport(path.join(__dirname,"src/factory/windows-acl.js")).then(function(acl) {
        return acl.protectWindowsPaths([{path:dir,kind:"directory",created:true}],{label:naming.label});
      });
    }
    }).then(function() { client.privatePath(dir,true); });
    });
  },Promise.resolve());
  });
}
function retirementGuard(request, l, resources) {
  var native = require("./web-native-messaging.cjs"), inventory, before, retained = [];
  var paths = [request.stateRoot,l.parent,l.root,l.configFile,path.join(l.root,l.markerName),request.selection.nativeReadyFile];
  var identities = paths.map(function(file) { return native.fileIdentity(file); });
  var ready = JSON.stringify(native.readPrivateJson(request.selection.nativeReadyFile));
  function evidence(file, root) {
    native.readPrivateJson(file,{anchor:root});
    return {identity:native.fileIdentity(file),digest:crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")};
  }
  function retainedUnchanged(root) {
    retained.forEach(function(pin) {
      var current = evidence(path.join(root,pin.relative),root);
      if (current.identity !== pin.identity || current.digest !== pin.digest)
        common.fail("cleanup_unconfirmed","Owner evidence changed during retirement");
    });
  }
  function unchanged() {
    common.marker(l.root,l.owner,false,l.markerName);
    if (paths.some(function(file,index) { return native.fileIdentity(file) !== identities[index]; }) ||
        JSON.stringify(native.readPrivateJson(request.selection.nativeReadyFile)) !== ready)
      common.fail("cleanup_unconfirmed","Owner or native generation changed during discard");
    inventory.descriptor(request.contextId);
    retainedUnchanged(l.root);
  }
  return moduleImport(path.join(__dirname,"src/browser/native-owner-inventory.mjs")).then(function(module) {
    inventory = module.createNativeOwnerInventory({browserStateRoot:request.stateRoot,cliDir:request.cliDir,
      binding:request.selection,socketRoot:request.socketRoot});
    unchanged();
    return inventory.inspectOwner(request.contextId);
  }).then(function(observed) {
    if (!observed.configured || observed.cli === "unknown" || !observed.fingerprint)
      common.fail("cleanup_unconfirmed","Owner evidence is unavailable before discard");
    before = observed;
    retained = [l.configFile,path.join(l.root,l.markerName),inventory.descriptor(request.contextId).sessionFile].map(function(file) {
      var pin = evidence(file,l.root);
      pin.relative = path.relative(l.root,file);
      return pin;
    });
    unchanged();
    return function(nativeResult) {
      if (!nativeResult || nativeResult.contextId !== request.contextId || nativeResult.discarded !== true)
        common.fail("cleanup_unconfirmed","Exact native discard disposition is unavailable");
      resources.nativeDisposition = nativeResult;
      unchanged();
      return inventory.inspectOwner(request.contextId).then(function(current) {
        if (!current.configured || current.cli !== "absent" || current.fingerprint !== before.fingerprint)
          common.fail("cleanup_unconfirmed","Exact unchanged CLI absence is unavailable after discard");
        unchanged();
        return moduleImport(path.join(__dirname,"src/factory/os-protect.js"));
      }).then(function(protection) {
        var naming = {label:"desk_browser_context",subject:"retained browser evidence"};
        var artifacts = path.join(request.stateRoot,"artifacts");
        var reservation = path.join(artifacts,"signed-in-"+request.contextId+"-"+common.generateId("signed-in"));
        var destination = path.join(reservation,"owner");
        var artifactIdentity, reservationIdentity;
        function protectCreatedDirectory(dir, created) {
          if (process.platform === "win32" && created) {
            return moduleImport(path.join(__dirname,"src/factory/windows-acl.js")).then(function(acl) {
              return acl.protectWindowsPaths([{path:dir,kind:"directory",created:true}],{label:naming.label});
            });
          }
        }
        function destinationUnchanged() {
          if (native.fileIdentity(request.stateRoot) !== identities[0] ||
              native.fileIdentity(artifacts) !== artifactIdentity ||
              native.fileIdentity(reservation) !== reservationIdentity)
            common.fail("cleanup_unconfirmed","Retirement artifact parent changed");
          native.privatePaths([{file:request.stateRoot,directory:true},{file:artifacts,directory:true},{file:reservation,directory:true}]);
        }
        return protection.assertOutsideGitWorkspace(artifacts,naming).then(function() {
          return protection.ensureOwnerOnlyDirectory(artifacts,process.platform,naming);
        }).then(function(created) {
          return protectCreatedDirectory(artifacts,created);
        }).then(function() {
          native.privatePath(artifacts,true);
          return fs.promises.mkdir(reservation,{mode:448});
        }).then(function() {
          resources.retirementArtifactDirectory = reservation;
          return protection.ensureOwnerOnlyDirectory(reservation,process.platform,naming);
        }).then(function() {
          return protectCreatedDirectory(reservation,true);
        }).then(function() {
          native.privatePaths([{file:request.stateRoot,directory:true},{file:artifacts,directory:true},{file:reservation,directory:true}]);
          artifactIdentity = native.fileIdentity(artifacts);
          reservationIdentity = native.fileIdentity(reservation);
          unchanged();
          return inventory.inspectOwner(request.contextId);
        }).then(function(current) {
          if (!current.configured || current.cli !== "absent" || current.fingerprint !== before.fingerprint)
            common.fail("cleanup_unconfirmed","Owner changed before evidence retirement");
          unchanged();
          destinationUnchanged();
          return fs.promises.rename(l.root,destination);
        }).then(function() {
          resources.retiredDirectory = destination;
          resources.previousContextDirectory = l.root;
          resources.contextDirectory = destination;
          resources.configFile = path.join(destination,"config","browser.json");
          resources.disposition = "owner moved; retirement confirmation pending";
          destinationUnchanged();
          native.privatePath(destination,true);
          if (native.fileIdentity(destination) !== identities[2] ||
              native.fileIdentity(resources.configFile) !== identities[3] ||
              native.fileIdentity(path.join(destination,l.markerName)) !== identities[4] ||
              native.fileIdentity(request.selection.nativeReadyFile) !== identities[5] ||
              JSON.stringify(native.readPrivateJson(request.selection.nativeReadyFile)) !== ready)
            common.fail("cleanup_unconfirmed","Retired owner or native generation changed");
          common.marker(destination,l.owner,false,l.markerName);
          retainedUnchanged(destination);
          try {
            fs.lstatSync(l.root);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            resources.disposition = "discarded owner evidence retained outside active inventory; socket artifacts retained";
            return;
          }
          common.fail("cleanup_unconfirmed","Active owner path reappeared after retirement");
        });
      });
    };
  });
}
function executeSigned(input, options, request, l, source, resources, nodePath) {
  var retire;
  return moduleImport(path.join(__dirname,"src/util/broker-lock.mjs")).then(function(locks) {
    return locks.withBrokerLock(request.stateRoot,function() {
      return Promise.resolve().then(function() {
        common.marker(l.root,l.owner,false,l.markerName);
        if (input.action === "discard") return retirementGuard(request,l,resources).then(function(guard) { retire = guard; });
      }).then(function() {
        return (options.execute || common.execute)(nodePath,
          [path.join(__dirname,"browser-context-runtime.cjs"),JSON.stringify(request)],
          {cwd:l.root,env:common.environment(source,l.root,l.socketDir,nodePath),mode:"signed-in"});
      }).then(function(result) {
        if (!result || result.isError || (input.action === "discard" ? result.state !== "discarded" : result.state !== "running"))
          common.fail("runner_failed","Native worker did not confirm the requested operation");
        if (!retire) return result;
        return retire(result.result).then(function() { return result; });
      });
    },{name:"native-context-"+request.contextId});
  });
}
function signed(input, options, isCommand) {
  var source = options.env || process.env, id = input.contextId, contextResources, runtime, selection, l, native, acl;
  var creating = input.action === "create";
  return Promise.resolve().then(function() {
    // This facade must execute in the normal parent, before environment().
    return (options.prepareBrowserRuntime || web.prepareBrowserRuntime)(options);
  }).then(function(prepared) {
    runtime = prepared;
    if (require("./web-playwright-patch.cjs").readRevision(runtime.installed) !== 4)
      common.fail("unsupported_cli","A complete verified native browser generation is required");
    return nativeSelection(runtime,source,input);
  }).then(function(selected) {
    selection = selected;
    if (creating) id = common.generateId("signed-in");
    l = common.layout(fs.realpathSync(runtime.stateRoot),id,"signed-in",options.socketRoot);
    contextResources = {contextDirectory:l.root,configFile:l.configFile,socketDirectory:l.socketDir,
      disposition:"owner state and exports retained"};
    return protectSigned(l,runtime.stateRoot,creating);
  }).then(function() {
    native = require("./web-native-messaging.cjs");
    if (creating) {
      common.marker(l.root,l.owner,true,l.markerName);
      var record = {version:1,contextId:id,label:input.label,channel:selection.channel,userDataDir:selection.userDataDir,
        profileDirName:selection.profileDirName,nativeReadyFile:selection.nativeReadyFile,extensionId:selection.extensionId,sourceDigest:selection.sourceDigest};
      native.validateNativeRecord(record);
      fs.writeFileSync(l.configFile,JSON.stringify({extension:true,browser:{browserName:"chromium",
        launchOptions:{channel:selection.channel},userDataDir:selection.userDataDir},deskNativeContext:record}),{flag:"wx",mode:384});
    } else common.marker(l.root,l.owner,false,l.markerName);
    if (creating) fs.mkdirSync(l.socketDir,{mode:448});
    if (process.platform === "win32" && creating) {
      return moduleImport(path.join(__dirname,"src/factory/windows-acl.js")).then(function(protection) {
        acl = protection;
        return acl.protectWindowsPaths([{path:l.socketDir,kind:"directory",created:true},{path:path.join(l.root,l.markerName),kind:"file",created:true},
          {path:l.configFile,kind:"file",created:true}],{label:"desk_browser_context"});
      });
    }
  }).then(function() {
    common.marker(l.socketDir,l.owner,creating,l.markerName);
    if (process.platform === "win32" && creating) {
      return acl.protectWindowsPaths([{path:path.join(l.socketDir,l.markerName),kind:"file",created:true}],{label:"desk_browser_context"});
    }
  }).then(function() {
    native.privatePath(l.socketDir,true);
    var current = native.readPrivateJson(l.configFile);
    native.validateNativeRecord(current.deskNativeContext);
    if (current.deskNativeContext.contextId !== id || ["channel","userDataDir","profileDirName","nativeReadyFile","extensionId","sourceDigest"].some(function(key) {
      return current.deskNativeContext[key] !== selection[key];
    })) common.fail("NATIVE_OWNER_BINDING_MISMATCH","Immutable owner binding differs from selected native profile");
    var request = {mode:"signed-in",operation:isCommand ? "run" : input.action,contextId:id,
      stateRoot:runtime.stateRoot,root:l.root,socketDir:l.socketDir,socketRoot:path.dirname(l.socketDir),
      installed:runtime.installed,selection:selection,
      cliDir:path.join(runtime.installed.dir,"node_modules","playwright-core","lib","tools","cli-client"),args:input.args || []};
    return executeSigned(input,options,request,l,source,contextResources,runtime.nodePath);
  }).then(function(result) {
    return {exitCode:0,payload:common.scrub({contextId:id,mode:"signed-in",state:result.state,result:result.result,contextResources:contextResources},source)};
  }).catch(function(error) {
    var payload = common.errorPayload(error);
    payload.contextId = id; payload.mode = "signed-in";
    if (contextResources || payload.contextResources)
      payload.contextResources = Object.assign({},contextResources,payload.contextResources);
    return {exitCode:1,payload:common.scrub(payload,source)};
  });
}
function invoke(input, options, isCommand) {
  var o = options || {};
  return Promise.resolve().then(function() {
    var mode = validate(input,isCommand);
    if (mode === "private") {
      var args = isCommand ? ["run",input.contextId,"--"].concat(input.args) :
        input.action === "create" ? ["create"] : [input.action,input.contextId];
      return require("./browser-private.cjs").run(args,o);
    }
    return signed(input,o,isCommand);
  }).catch(function(error) { return {exitCode:1,payload:common.scrub(common.errorPayload(error),o.env || process.env)}; });
}
function context(input, options) { return invoke(input,options,false); }
function command(input, options) { return invoke(input,options,true); }
function run(argv, options) {
  try {
    if (!Array.isArray(argv) || argv.some(function(arg) { return typeof arg !== "string" || arg.indexOf("\0") !== -1; }))
      common.fail("invalid_arguments","Expected string arguments");
    if (argv[0] === "create") {
      var input = {action:"create"};
      for (var i = 1; i < argv.length; i += 2) {
        var key = argv[i] === "--mode" ? "mode" : argv[i] === "--label" ? "label" : null;
        if (!key || input[key] !== undefined || argv[i+1] === undefined) common.fail("invalid_arguments","Unexpected or duplicate create option");
        input[key] = argv[i+1];
      }
      return context(input,options);
    }
    if (argv[0] === "run") {
      if (argv[2] !== "--") common.fail("invalid_arguments","Expected run <contextId> -- <page argv>");
      return command({contextId:argv[1],args:argv.slice(3)},options);
    }
    if (argv.length !== 2) common.fail("invalid_arguments","Expected action and explicit contextId");
    return context({action:argv[0],contextId:argv[1]},options);
  } catch (error) { return Promise.resolve({exitCode:1,payload:common.errorPayload(error)}); }
}
module.exports = {run:run,context:context,command:command};
if (require.main === module) {
  var bootstrap = require("./bootstrap.cjs");
  var choice = bootstrap.selectNode({mcpRoot:__dirname,env:process.env,homeDir:os.homedir(),
    platform:process.platform,arch:process.arch,systemPrefix:process.env.DESK_NODE_SYSTEM_PREFIX || "",
    current:{path:process.execPath,version:process.version,abi:process.versions.modules}});
  if (!choice.node) {
    process.stdout.write(JSON.stringify({isError:true,code:"node_missing",message:"A compatible browser controller runtime is unavailable"})+"\n");
    process.exitCode = 1;
  } else if (!choice.node.current) {
    bootstrap.reexec({node:choice.node.path,indexFile:__filename,args:process.argv.slice(2),env:process.env,
      spawn:require("child_process").spawn,signals:process,stderr:process.stderr,kill:process.kill,
      exit:function(code) { process.exitCode = code; },
      onSpawnError:function() {
        process.stdout.write(JSON.stringify({isError:true,code:"node_spawn_failed",message:"The compatible browser controller could not start; no context was allocated"})+"\n");
        process.exitCode = 1;
      }});
  } else run(process.argv.slice(2)).then(function(result) {
    process.stdout.write(JSON.stringify(result.payload)+"\n"); process.exitCode = result.exitCode;
  });
}
