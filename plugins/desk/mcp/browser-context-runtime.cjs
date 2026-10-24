"use strict";
// One fresh compatible child per operation. Never change the MCP parent's HOME.
var fs = require("fs");
var path = require("path");
var net = require("net");
var common = require("./browser-context-common.cjs");
var fail = common.fail;
function noLinks(file, root) {
  var relative = path.relative(root,file);
  if (relative === ".." || relative.indexOf(".."+path.sep) === 0 || path.isAbsolute(relative))
    fail("unsafe_registry","Registry path escaped its private context");
  var current = root;
  [""].concat(relative.split(path.sep).filter(Boolean)).forEach(function(part) {
    if (part) current = path.join(current,part);
    try {
      var stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
        fail("unsafe_registry","Registry/socket path is not owned");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  });
}
function validatePrivate(entry, info, request) {
  var managed = request.backend === "managed";
  if (entry.file !== path.join(info.daemonProfilesDir,request.contextId+".session") ||
      entry.daemonDir !== info.daemonProfilesDir || entry.config.name !== request.contextId ||
      !entry.config.browser || !entry.config.cli || entry.config.attached || entry.config.workspaceDir !== request.root ||
      (managed ? entry.config.browser.userDataDir !== path.join(request.root,"profile") || entry.config.cli.persistent !== true :
        entry.config.browser.userDataDir != null || entry.config.cli.persistent))
    fail("unsafe_registry","Session metadata does not describe this exact owned browser context");
  if (managed) {
    var expected = JSON.parse(fs.readFileSync(path.join(request.root,"config","browser.json"),"utf8")).browser;
    var actual = entry.config.browser.launchOptions;
    if (!actual || actual.executablePath !== expected.launchOptions.executablePath ||
        actual.channel !== expected.launchOptions.channel || actual.headless !== expected.launchOptions.headless ||
        actual.chromiumSandbox !== true || entry.config.browser.cdpEndpoint || entry.config.browser.remoteEndpoint)
      fail("unsafe_registry","Persistent session browser binding changed");
    noLinks(path.join(request.root,"profile"),request.root);
  }
  noLinks(entry.file,request.root);
  if (process.platform === "win32") {
    if (typeof entry.config.socketPath !== "string" || entry.config.socketPath.indexOf("\\\\.\\pipe\\pw-") !== 0 ||
        entry.config.socketPath.indexOf(request.contextId) === -1) fail("unsafe_registry","Unexpected private named pipe");
  } else {
    if (typeof entry.config.socketPath !== "string" || !/\.sock$/.test(entry.config.socketPath)) fail("unsafe_registry","Invalid private socket");
    noLinks(entry.config.socketPath,request.socketDir);
    try { if (!fs.lstatSync(entry.config.socketPath).isSocket()) fail("unsafe_registry","Private socket is not a socket"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function validateRegistry(base, root) {
  noLinks(base,root);
  if (!fs.existsSync(base)) return;
  fs.readdirSync(base).forEach(function(name) {
    var dir = path.join(base,name); noLinks(dir,root);
    if (fs.lstatSync(dir).isDirectory()) fs.readdirSync(dir).forEach(function(file) { noLinks(path.join(dir,file),root); });
  });
}
function connect(socketPath) {
  return new Promise(function(resolve,reject) {
    var socket = net.createConnection(socketPath,function() { clearTimeout(timer); resolve(socket); });
    var timer = setTimeout(function() {
      socket.destroy(); reject(Object.assign(new Error("Browser connection timed out; session metadata retained"),{code:"session_unreachable"}));
    },10000);
    socket.on("error",function(error) { clearTimeout(timer); socket.destroy(); reject(error); });
  });
}
function send(socket, SocketConnection, method, params, native) {
  return new Promise(function(resolve,reject) {
    var connection = new SocketConnection(socket), finished = false;
    var timer = setTimeout(function() { finish(Object.assign(new Error("Browser reply timed out"),{code:"session_unreachable"})); },90000);
    function finish(error,result) {
      if (finished) return; finished = true; clearTimeout(timer); connection.close();
      if (error) reject(error); else resolve(result);
    }
    socket.on("error",function(error) { finish(error); });
    connection.onclose = function() { finish(Object.assign(new Error("Browser closed without acknowledgement"),{code:"cleanup_unconfirmed"})); };
    connection.onmessage = function(message) {
      try {
        if (!message || message.id !== 1) fail("cleanup_unconfirmed","Unexpected browser response");
        if (Object.prototype.hasOwnProperty.call(message,"error")) {
          if (Object.prototype.hasOwnProperty.call(message,"result")) fail("cleanup_unconfirmed","Ambiguous browser response");
          if (!native) return finish(new Error(message.error));
          return finish(native.codec.decodeError(message.error,{contextId:native.contextId,
            sourceGeneration:native.stamp.sourceGeneration,stage:method === "stop" ? "stop" : "command",requestId:1}));
        }
        if (!Object.prototype.hasOwnProperty.call(message,"result")) fail("cleanup_unconfirmed","Missing browser result");
        finish(null,message.result);
      } catch (error) { finish(error); }
    };
    connection.send({id:1,method:method,params:params}).catch(finish);
  });
}
function parsePage(request) {
  common.validatePageArgs(request.args,request.mode);
  var help = require(path.join(request.cliDir,"help.json"));
  if (request.mode === "signed-in" && (!help || !Array.isArray(help.booleanOptions) ||
      !help.commands || typeof help.commands !== "object"))
    fail("unsupported_cli","Unknown maintained page parser schema");
  var minimist = require(path.join(request.cliDir,"minimist.js")).minimist;
  var args = minimist(request.args,{boolean:help.booleanOptions.concat(["all","g","help","json","raw","version"]),string:["_"]});
  var command = help.commands[args._[0]];
  if (request.mode === "signed-in") {
    if (!command || !command.flags || !Array.isArray(command.args)) fail("unsupported_cli","Unknown maintained command schema");
    Object.keys(args).forEach(function(key) {
      if (key !== "_" && !Object.prototype.hasOwnProperty.call(command.flags,key))
        fail("invalid_arguments","Unknown maintained command option");
    });
    if (!command.variadicArg && args._.length-1 > command.args.length) fail("invalid_arguments","Too many page arguments");
  }
  var raw = !!args.raw || !!(command && command.raw);
  delete args.raw; delete args.json; delete args.session;
  return {args:args,cwd:request.root,raw:raw,json:true};
}
function runPage(request, socket, SocketConnection, native) {
  var params;
  try { params = parsePage(request); } catch (error) { socket.destroy(); throw error; }
  return send(socket,SocketConnection,"run",params,native).then(function(response) {
    if (request.mode === "signed-in" && (!response || typeof response.text !== "string"))
      fail("runner_failed","Maintained page result is unconfirmed; the context remains retained");
    if (!response || response.isError) fail("upstream_failed",response && response.text || "Upstream command failed");
    var result;
    try { result = JSON.parse(response.text); } catch (_) { result = response.text; }
    return {state:"running",result:result};
  });
}
function privateMain(request, registryModule, Session, program, SocketConnection, info) {
  var entry,session,handoff,entryContents;
  function load() {
    var expected = path.join(info.daemonProfilesDir,request.contextId+".session");
    noLinks(expected,request.root);
    if (typeof registryModule.baseDaemonDir === "function") validateRegistry(registryModule.baseDaemonDir(),request.root);
    return registryModule.Registry.load().then(function(registry) {
      entry = registry.entry(info,request.contextId);
      if (!entry && fs.existsSync(expected)) fail("session_metadata_invalid","Private session metadata is present but unreadable");
      if (entry) {
        validatePrivate(entry,info,request); session = new Session(entry);
        if (request.backend === "managed") entryContents = fs.readFileSync(entry.file,"utf8");
      }
    });
  }
  function live() {
    if (!entry) fail("context_absent","Private browser is absent; it was not recreated");
    if (!session.isCompatible(info)) fail("session_incompatible","Private session is incompatible with selected CLI");
    return connect(entry.config.socketPath);
  }
  return load().then(function() {
  function start() {
      if (entry) fail("context_exists","A private context with this ID already exists");
      var captured = "",write = process.stdout.write, originalStart = Session.startDaemon, invoked = false, recorded;
      if (handoff && typeof originalStart === "function") Session.startDaemon = function() {
        invoked = true;
        return Promise.resolve(originalStart.apply(this,arguments)).then(function(result) {
          // Record the maintained daemon before its caller opens the browser.
          return recordManagedDaemon(request,result).then(function() { recorded = result.pid; return result; });
        });
      };
      process.argv = [process.execPath,"playwright-cli","--session="+request.contextId,"--json","open","--idle-timeout=0"].concat(request.browserArgs || []);
      process.stdout.write = function(chunk) { captured += String(chunk); return true; };
      return Promise.resolve().then(function() { return program(); }).then(function() {
        process.stdout.write = write;
        var result;
        try { result = JSON.parse(captured); } catch (_) { result = captured; }
        if (process.exitCode || (result && result.isError)) fail("upstream_failed",typeof result === "object" ? result.error || "Upstream command failed" : captured);
        return load().then(live).then(function(socket) {
          socket.destroy();
          if (recorded && (!result || result.pid !== recorded)) fail("startup_unconfirmed","Replacement daemon acknowledgement changed");
          return (request.backend === "managed" && !recorded ? recordManagedDaemon(request,result) : Promise.resolve())
            .then(function() { return {state:"running",result:result}; });
        });
      }).then(function(result) {
        Session.startDaemon = originalStart; return result;
      },function(error) {
        process.stdout.write = write; Session.startDaemon = originalStart;
        // Only a positively observed pre-spawn rejection is retryable.
        // A lost/pending start without an exact daemon receipt stays unknown.
        if (handoff && typeof originalStart === "function" && !invoked) {
          handoff.phase = "ready";
          handoff.lastFailure = {stage:"before-daemon-start",code:error.code || "upstream_failed"};
          common.atomicJson(path.join(request.root,".managed-sign-in-handoff.json"),handoff);
        }
        throw error;
      });
  }
  function stop() {
      if (request.backend === "managed") {
        var pending = common.readManagedState(request.root,".managed-sign-in-handoff.json",request.contextId);
        if (pending && pending.phase === "starting" &&
            JSON.stringify(common.readManagedState(request.root,".managed-daemon.json",request.contextId)) === JSON.stringify(pending.launchPreviousDaemon))
          fail("cleanup_unconfirmed","Replacement startup has no confirmed daemon identity; authentication profile retained");
      }
      if (!entry) return request.backend === "managed" ? managedDaemonExited(request)
        .then(function() { return {state:"discarded"}; }) : {state:"absent"};
      var reconciled = false;
      return live().then(function(socket) { return send(socket,SocketConnection,"stop",{}); },function(error) {
        if (request.backend !== "managed" || (error.code !== "ENOENT" && error.code !== "ECONNREFUSED")) throw error;
        return managedDaemonExited(request).then(function() {
          var cleanup = common.readManagedState(request.root,".managed-discard.json",request.contextId) ||
            common.readManagedState(request.root,".managed-sign-in-handoff.json",request.contextId);
          if (!cleanup || !cleanup.profile) fail("cleanup_unconfirmed","Retained profile identity is unavailable");
          common.profileUnused(request.root,cleanup.profile,false);
          if (process.platform !== "win32" && fs.existsSync(entry.config.socketPath))
            fail("cleanup_unconfirmed","Private socket disposition remains unconfirmed");
          noLinks(entry.file,request.root); common.checkOwned(entry.file,false);
          if (fs.readFileSync(entry.file,"utf8") !== entryContents)
            fail("cleanup_unconfirmed","Session metadata changed during daemon-exit reconciliation");
          return session.deleteSessionConfig();
        }).then(function() { reconciled = true; });
      }).then(function(ack) {
        if (reconciled) return;
        if (ack !== "ok") fail("cleanup_unconfirmed","Private browser did not confirm stop");
        if (process.platform !== "win32" && fs.existsSync(entry.config.socketPath)) fail("cleanup_unconfirmed","Private socket remains after stop");
        if (fs.existsSync(entry.file)) return connect(entry.config.socketPath).then(function(socket) {
          socket.destroy(); fail("cleanup_unconfirmed","Private browser still responds after stop");
        },function(error) {
          if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") throw error;
          return session.deleteSessionConfig();
        });
      }).then(function() {
        if (fs.existsSync(entry.file)) fail("cleanup_unconfirmed","Private session metadata remains after stop");
        return (request.backend === "managed" ? managedDaemonExited(request) : Promise.resolve())
          .then(function() { return {state:"discarded"}; });
      });
  }
    if (request.operation === "create") return start();
    if (request.operation === "discard") return stop();
    if (request.operation === "finish-sign-in") return finishSignIn();
    async function finishSignIn() {
      var configFile = path.join(request.root,"config","browser.json");
      var config = JSON.parse(fs.readFileSync(configFile,"utf8"));
      var handoffFile = path.join(request.root,".managed-sign-in-handoff.json");
      handoff = common.readManagedState(request.root,".managed-sign-in-handoff.json",request.contextId);
      if (request.backend !== "managed" || (!handoff && config.browser.launchOptions.headless !== false) ||
          (handoff && handoff.phase === "completed"))
        fail("invalid_context_state","Only an explicitly interactive sign-in context can be finished; no work context was restarted");
      if (!handoff) {
        handoff = {version:1,contextId:request.contextId,phase:"stopping",profile:common.profileIdentity(request.root),
          originalDaemon:common.readManagedState(request.root,".managed-daemon.json",request.contextId)};
        if (!handoff.originalDaemon) fail("cleanup_unconfirmed","Interactive daemon identity is unavailable");
        common.atomicJson(handoffFile,handoff);
      }
      if (["stopping","ready","starting"].indexOf(handoff.phase) === -1 ||
          JSON.stringify(common.profileIdentity(request.root)) !== JSON.stringify(handoff.profile))
        fail("cleanup_unconfirmed","Incomplete sign-in handoff or profile identity is invalid");
      function completed() {
        handoff.phase = "completed"; common.atomicJson(handoffFile,handoff);
        return {state:"running",result:{interactive:false,authentication:"inspect-page",previousPages:"closed-without-replay"}};
      }
      if (handoff.phase === "stopping") {
        await stop();
        common.profileUnused(request.root,handoff.profile,false);
        var archived = common.readManagedState(request.root,".managed-sign-in-daemon.json",request.contextId);
        if (archived && JSON.stringify(archived) !== JSON.stringify(handoff.originalDaemon))
          fail("cleanup_unconfirmed","Original sign-in receipt changed");
        if (!archived) common.atomicJson(path.join(request.root,".managed-sign-in-daemon.json"),handoff.originalDaemon);
        handoff.phase = "ready"; common.atomicJson(handoffFile,handoff);
      }
      await load();
      var current = common.readManagedState(request.root,".managed-daemon.json",request.contextId);
      if (handoff.phase === "starting") {
        if (!current || JSON.stringify(current) === JSON.stringify(handoff.launchPreviousDaemon))
          fail("cleanup_unconfirmed","Replacement startup remains unconfirmed; no start was replayed");
        if (entry) {
          if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || typeof current.started !== "string" || !current.started)
            fail("cleanup_unconfirmed","Replacement daemon receipt is invalid");
          var reader = await processReader();
          if (await reader.readProcessStart(current.pid) !== current.started)
            fail("cleanup_unconfirmed","Replacement daemon generation is not confirmed");
          var socket = await live(); socket.destroy();
          return completed();
        }
        await managedDaemonExited(request,current);
        common.profileUnused(request.root,handoff.profile,false);
        handoff.phase = "ready"; common.atomicJson(handoffFile,handoff);
      }
      if (entry) fail("cleanup_unconfirmed","Unexpected session remains during sign-in handoff");
      await managedDaemonExited(request,current);
      await managedDaemonExited(request,handoff.originalDaemon);
      common.profileUnused(request.root,handoff.profile,false);
      config.browser.launchOptions.headless = true;
      common.atomicJson(configFile,config);
      handoff.launchPreviousDaemon = current;
      handoff.phase = "starting"; common.atomicJson(handoffFile,handoff);
      await start();
      return completed();
    }
    function processReader() {
      return import(require("url").pathToFileURL(path.join(__dirname,"src/readiness/process-start.js")).href);
    }
    async function recordManagedDaemon(request, result) {
      if (!result || !Number.isSafeInteger(result.pid) || result.pid <= 0)
        fail("startup_unconfirmed","Browser started without a confirmed daemon identity; retain this context");
      var reader = await processReader(), started = await reader.readProcessStart(result.pid);
      if (typeof started !== "string" || !started) fail("startup_unconfirmed","Browser daemon generation could not be confirmed; retain this context");
      var file = path.join(request.root,".managed-daemon.json");
      var record = {version:1,contextId:request.contextId,pid:result.pid,started:started};
      if (handoff) {
        if (JSON.stringify(common.readManagedState(request.root,".managed-daemon.json",request.contextId)) !== JSON.stringify(handoff.launchPreviousDaemon))
          fail("cleanup_unconfirmed","Previous daemon receipt changed during replacement launch");
        common.atomicJson(file,record);
      } else fs.writeFileSync(file,JSON.stringify(record),{flag:"wx",mode:384});
    }
    async function managedDaemonExited(request, supplied) {
      var file = path.join(request.root,".managed-daemon.json");
      noLinks(file,request.root); common.checkOwned(file,false);
      var record = supplied || JSON.parse(fs.readFileSync(file,"utf8"));
      if (record.version !== 1 || record.contextId !== request.contextId ||
          !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.started !== "string" || !record.started)
        fail("cleanup_unconfirmed","Owned browser daemon identity is unavailable");
      var reader = await processReader(), deadline = Date.now()+15000;
      do {
        var observed = await reader.readProcessStart(record.pid);
        if (typeof observed === "string" && observed) {
          if (observed !== record.started) return;
        } else {
          try { process.kill(record.pid,0); }
          catch (error) {
            if (error.code === "ESRCH") return;
            throw Object.assign(new Error("Owned daemon inspection failed; authentication profile retained"),
              {code:"cleanup_unconfirmed",resources:{daemonDisposition:"unknown",inspectionCode:error.code || "unavailable"}});
          }
        }
        await new Promise(function(resolve) { setTimeout(resolve,100); });
      } while (Date.now() < deadline);
      fail("cleanup_unconfirmed","Owned browser daemon exit remains unconfirmed; authentication profile retained");
    }
    return live().then(function(socket) {
      if (request.operation === "run") return runPage(request,socket,SocketConnection);
      socket.destroy(); return {state:"running"};
    });
  });
}
async function signedMain(request, registryModule, Session, SocketConnection, info) {
  var clientModule = require("./web-native-messaging.cjs");
  var codec = require(path.join(request.installed.dir,"node_modules","playwright-core","lib","desk-native-error-transport.cjs"));
  var inventoryModule = await import(require("url").pathToFileURL(path.join(__dirname,"src/browser/native-owner-inventory.mjs")).href);
  var inventory = inventoryModule.createNativeOwnerInventory({browserStateRoot:request.stateRoot,cliDir:request.cliDir,
    binding:request.selection,socketRoot:request.socketRoot});
  var descriptor = inventory.descriptor(request.contextId), entry,stamp;
  if (descriptor.directory !== request.root || descriptor.socketDirectory !== request.socketDir) fail("NATIVE_OWNER_INVALID","Owner layout mismatch");
  async function load() {
    var inspected = await inventory.inspectOwner(request.contextId);
    if (!inspected.configured || inspected.cli === "unknown") fail("NATIVE_OWNER_INVALID","Maintained native session evidence is unknown");
    var registry = new registryModule.Registry(new Map());
    entry = await registry.loadEntry({daemonProfilesDir:descriptor.daemonProfilesDir,workspaceDir:request.root,workspaceDirHash:descriptor.workspaceDirHash},request.contextId);
    if (!new Session(entry).isCompatible(info)) fail("session_incompatible","Native session is incompatible");
    stamp = entry.config.deskNativeErrorTransport;
    if (!stamp || Object.keys(stamp).sort().join(",") !== "contextId,sourceGeneration,version" ||
        stamp.version !== 1 || stamp.contextId !== request.contextId || !/^[a-f0-9]{64}$/.test(stamp.sourceGeneration))
      fail("NATIVE_ERROR_TRANSPORT_UNCONFIRMED","Native session stamp is unavailable");
    return inspected;
  }
  var client = await clientModule.attestNativeContext(descriptor.record,request.selection);
  if (request.operation === "create") {
    if (fs.existsSync(descriptor.sessionFile)) fail("context_exists","Native context metadata already exists");
    var started = await Session.startDaemon(info,{session:request.contextId,browser:descriptor.record.channel,extension:true,
      persistent:true,"idle-timeout":0,config:path.join(request.root,"config","browser.json")},"attach");
    await load(); await client.request("context.resume",{});
    var snapshot = Object.assign({},request,{args:["snapshot"]});
    var result = await runPage(snapshot,await connect(entry.config.socketPath),SocketConnection,
      {codec:codec,contextId:request.contextId,stamp:stamp});
    result.result = {pid:started.pid,result:result.result}; return result;
  }
  var before = await load();
  if (request.operation !== "discard") {
    var recovered = false;
    if (before.cli !== "active") {
      if (request.operation !== "resume") fail("context_absent","Native CLI is absent; its retained context was not recreated");
      var retained = await client.request("context.status",{});
      if (!retained || retained.contextId !== request.contextId || retained.state !== "disconnected" ||
          retained.pendingEffects !== 0 || retained.unconfirmedCreates !== 0 || !Array.isArray(retained.tabs) || !retained.tabs.length ||
          ["revokedTabIds","uncertainTabs","groupingObligations","effectObligations","admittingTabIds","debuggerCustody"].some(function(key) {
            return !Array.isArray(retained[key]) || retained[key].length !== 0;
          })) fail("native_context_unavailable","Retained browser effects are not reconciled for recovery");
      if (JSON.stringify(inventory.descriptor(request.contextId).record) !== JSON.stringify(descriptor.record))
        fail("NATIVE_OWNER_BINDING_MISMATCH","Owner binding changed before recovery");
      if (process.env.DESK_BROWSER_RECOVERY_CONTEXT !== undefined)
        fail("NATIVE_CONFIG_INVALID","Unexpected inherited recovery intent");
      process.env.DESK_BROWSER_RECOVERY_CONTEXT = request.contextId;
      try {
        await Session.startDaemon(info,{session:request.contextId,browser:descriptor.record.channel,extension:true,
          persistent:true,"idle-timeout":0,config:path.join(request.root,"config","browser.json")},"attach");
      } finally { delete process.env.DESK_BROWSER_RECOVERY_CONTEXT; }
      var resumed = await load();
      if (resumed.cli !== "active" || JSON.stringify(inventory.descriptor(request.contextId).record) !== JSON.stringify(descriptor.record))
        fail("NATIVE_OWNER_BINDING_MISMATCH","Recovered CLI did not confirm the same owner binding");
      recovered = true;
    }
    await client.request("context.resume",{});
    var socket = await connect(entry.config.socketPath);
    if (request.operation === "run") return runPage(request,socket,SocketConnection,{codec:codec,contextId:request.contextId,stamp:stamp});
    socket.destroy(); return {state:"running",...(recovered ? {result:{recovered:true,previousCommandOutcome:"unknown",
      nextAction:"Inspect the retained pages before retrying an action whose result was not received"}} : {})};
  }
  await client.request("context.status",{});
  var nativeResult = await client.request("context.discard",{});
  if (!nativeResult || nativeResult.contextId !== request.contextId || nativeResult.discarded !== true)
    fail("cleanup_unconfirmed","Native discard was not confirmed");
  try {
  var after = await load();
  if (after.fingerprint !== before.fingerprint) fail("cleanup_unconfirmed","Native metadata changed during discard");
  if (after.cli === "active") {
    var ack = await send(await connect(entry.config.socketPath),SocketConnection,"stop",{},
      {codec:codec,contextId:request.contextId,stamp:stamp});
    if (ack !== "ok") fail("cleanup_unconfirmed","Native CLI did not acknowledge stop");
  }
  for (var i = 0; i < 10; i += 1) {
    var final = await inventory.inspectOwner(request.contextId);
    if (final.fingerprint !== before.fingerprint) break;
    if (final.cli === "absent") return {state:"discarded",result:nativeResult};
    await new Promise(function(resolve) { setTimeout(resolve,50); });
  }
  throw Object.assign(new Error("Native disposition acknowledged but CLI absence is unconfirmed"),
    {code:"cleanup_unconfirmed",resources:{native:nativeResult,cli:{disposition:"unknown"}}});
  } catch (error) {
    error.contextResources = Object.assign({},error.contextResources,
      {nativeDisposition:nativeResult,cliDisposition:"unknown"});
    throw error;
  }
}
function main(request) {
  return Promise.resolve().then(function() {
    if (!request || ["private","signed-in"].indexOf(request.mode) === -1) fail("invalid_arguments","Expected an explicit context mode");
    if (common.modeOf(request.contextId) !== request.mode) fail("invalid_arguments","Handle namespace mismatch");
    if (request.mode === "signed-in" && process.platform !== "win32") process.umask(63);
    if (request.backend !== undefined && (request.backend !== "managed" || request.mode !== "signed-in"))
      fail("invalid_arguments","Unknown browser backend binding");
    if (request.mode === "signed-in" && request.backend !== "managed" && require("./web-playwright-patch.cjs").readRevision(request.installed) !== 4)
      fail("unsupported_cli","Native generation is not qualified");
    if (request.backend === "managed") {
      common.marker(request.root,JSON.stringify({contextId:request.contextId,directory:request.root,backend:"managed"}),false,".desk-context-owner");
      noLinks(path.join(request.root,"config","browser.json"),request.root);
      common.checkOwned(path.join(request.root,"config","browser.json"),false);
      common.validateManagedConfig(JSON.parse(fs.readFileSync(path.join(request.root,"config","browser.json"),"utf8")),request.root);
      var pending = common.readManagedState(request.root,".managed-sign-in-handoff.json",request.contextId);
      if (pending && pending.phase !== "completed" && ["discard","finish-sign-in"].indexOf(request.operation) === -1)
        fail("sign_in_incomplete","Complete or discard the explicit sign-in handoff before ordinary page work");
    }
    var registry = require(path.join(request.cliDir,"registry.js"));
    var Session = require(path.join(request.cliDir,"session.js")).Session;
    var program = require(path.join(request.cliDir,"program.js")).program;
    var SocketConnection = require(path.join(request.cliDir,"..","utils","socketConnection.js")).SocketConnection;
    if (typeof registry.createClientInfo !== "function" || !registry.Registry || typeof registry.Registry.load !== "function" ||
        typeof Session !== "function" || typeof program !== "function" || typeof SocketConnection !== "function")
      fail("unsupported_cli","Installed maintained CLI module interface is unsupported");
    var info = registry.createClientInfo(); noLinks(info.daemonProfilesDir,request.root);
    return request.mode === "private" || request.backend === "managed" ? privateMain(request,registry,Session,program,SocketConnection,info) :
      signedMain(request,registry,Session,SocketConnection,info);
  });
}
module.exports = {main:main};
if (require.main === module) main(JSON.parse(process.argv[2])).then(function(result) {
  process.stdout.write(JSON.stringify(result)+"\n");
},function(error) {
  process.stdout.write(JSON.stringify(common.errorPayload(error))+"\n"); process.exitCode = 1;
});
