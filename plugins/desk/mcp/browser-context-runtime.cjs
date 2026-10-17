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
  if (entry.file !== path.join(info.daemonProfilesDir,request.contextId+".session") ||
      entry.daemonDir !== info.daemonProfilesDir || entry.config.name !== request.contextId ||
      !entry.config.browser || entry.config.browser.userDataDir != null || !entry.config.cli ||
      entry.config.cli.persistent || entry.config.attached || entry.config.workspaceDir !== request.root)
    fail("unsafe_registry","Session metadata does not describe this in-memory context");
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
  var minimist = require(path.join(request.cliDir,"minimist.js")).minimist;
  var args = minimist(request.args,{boolean:help.booleanOptions.concat(["all","g","help","json","raw","version"]),string:["_"]});
  var command = help.commands[args._[0]];
  if (request.mode === "signed-in") {
    if (!command || !command.flags || !Array.isArray(command.args)) fail("unsupported_cli","Unknown maintained command schema");
    Object.keys(args).forEach(function(key) {
      if (key !== "_" && !Object.prototype.hasOwnProperty.call(command.flags,key) &&
          !(args[key] === false && Object.prototype.hasOwnProperty.call(command.flags,"no-"+key)))
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
    if (!response || response.isError) fail("upstream_failed",response && response.text || "Upstream command failed");
    var result;
    try { result = JSON.parse(response.text); } catch (_) { result = response.text; }
    return {state:"running",result:result};
  });
}
function privateMain(request, registryModule, Session, program, SocketConnection, info) {
  var entry,session;
  function load() {
    var expected = path.join(info.daemonProfilesDir,request.contextId+".session");
    noLinks(expected,request.root);
    if (typeof registryModule.baseDaemonDir === "function") validateRegistry(registryModule.baseDaemonDir(),request.root);
    return registryModule.Registry.load().then(function(registry) {
      entry = registry.entry(info,request.contextId);
      if (!entry && fs.existsSync(expected)) fail("session_metadata_invalid","Private session metadata is present but unreadable");
      if (entry) { validatePrivate(entry,info,request); session = new Session(entry); }
    });
  }
  function live() {
    if (!entry) fail("context_absent","Private browser is absent; it was not recreated");
    if (!session.isCompatible(info)) fail("session_incompatible","Private session is incompatible with selected CLI");
    return connect(entry.config.socketPath);
  }
  return load().then(function() {
    if (request.operation === "create") {
      if (entry) fail("context_exists","A private context with this ID already exists");
      var captured = "",write = process.stdout.write;
      process.argv = [process.execPath,"playwright-cli","--session="+request.contextId,"--json","open","--idle-timeout=0"].concat(request.browserArgs || []);
      process.stdout.write = function(chunk) { captured += String(chunk); return true; };
      return Promise.resolve().then(function() { return program(); }).then(function() {
        process.stdout.write = write;
        var result;
        try { result = JSON.parse(captured); } catch (_) { result = captured; }
        if (process.exitCode || (result && result.isError)) fail("upstream_failed",typeof result === "object" ? result.error || "Upstream command failed" : captured);
        return load().then(live).then(function(socket) { socket.destroy(); return {state:"running",result:result}; });
      },function(error) { process.stdout.write = write; throw error; });
    }
    if (request.operation === "discard") {
      if (!entry) return {state:"absent"};
      return live().then(function(socket) { return send(socket,SocketConnection,"stop",{}); }).then(function(ack) {
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
        return {state:"discarded"};
      });
    }
    return live().then(function(socket) {
      if (request.operation === "run") return runPage(request,socket,SocketConnection);
      socket.destroy(); return {state:"running"};
    });
  });
}
async function signedMain(request, registryModule, Session, SocketConnection, info) {
  var clientModule = require("./web-native-messaging.cjs");
  if (require("./web-playwright-patch.cjs").readRevision(request.installed) !== 4) fail("unsupported_cli","Native generation is not qualified");
  var codec = require(path.join(request.installed.dir,"node_modules","playwright-core","lib","desk-native-error-transport.cjs"));
  var inventoryModule = await import(require("url").pathToFileURL(path.join(__dirname,"src/browser/native-owner-inventory.mjs")).href);
  var inventory = inventoryModule.createNativeOwnerInventory({browserStateRoot:request.stateRoot,cliDir:request.cliDir,binding:request.selection});
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
    await client.request("context.resume",{});
    var socket = await connect(entry.config.socketPath);
    if (request.operation === "run") return runPage(request,socket,SocketConnection,{codec:codec,contextId:request.contextId,stamp:stamp});
    socket.destroy(); return {state:"running"};
  }
  await client.request("context.status",{});
  var nativeResult = await client.request("context.discard",{});
  if (!nativeResult || nativeResult.contextId !== request.contextId || nativeResult.discarded !== true)
    fail("cleanup_unconfirmed","Native discard was not confirmed");
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
}
function main(request) {
  return Promise.resolve().then(function() {
    if (!request || ["private","signed-in"].indexOf(request.mode) === -1) fail("invalid_arguments","Expected an explicit context mode");
    if (common.modeOf(request.contextId) !== request.mode) fail("invalid_arguments","Handle namespace mismatch");
    if (request.mode === "signed-in" && process.platform !== "win32") process.umask(63);
    var registry = require(path.join(request.cliDir,"registry.js"));
    var Session = require(path.join(request.cliDir,"session.js")).Session;
    var program = require(path.join(request.cliDir,"program.js")).program;
    var SocketConnection = require(path.join(request.cliDir,"..","utils","socketConnection.js")).SocketConnection;
    if (typeof registry.createClientInfo !== "function" || !registry.Registry || typeof registry.Registry.load !== "function" ||
        typeof Session !== "function" || typeof program !== "function" || typeof SocketConnection !== "function")
      fail("unsupported_cli","Installed maintained CLI module interface is unsupported");
    var info = registry.createClientInfo(); noLinks(info.daemonProfilesDir,request.root);
    return request.mode === "private" ? privateMain(request,registry,Session,program,SocketConnection,info) :
      signedMain(request,registry,Session,SocketConnection,info);
  });
}
module.exports = {main:main};
if (require.main === module) main(JSON.parse(process.argv[2])).then(function(result) {
  process.stdout.write(JSON.stringify(result)+"\n");
},function(error) {
  process.stdout.write(JSON.stringify(common.errorPayload(error))+"\n"); process.exitCode = 1;
});
