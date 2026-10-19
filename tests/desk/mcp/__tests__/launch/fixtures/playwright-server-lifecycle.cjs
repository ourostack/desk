// SPDX-License-Identifier: Apache-2.0
// License: LICENSE.playwright.txt beside this fixture.
// Extracted from Microsoft Playwright's packages/playwright-core/src/tools/utils/mcp/server.ts,
// as distributed in playwright-core 1.64.0-alpha-1790635538000, lib/coreBundle.js.
// Unmodified createServer lifecycle; dependency functions are supplied by the test harness.
function createServer(name, version3, factory, transportInitialized, runHeartbeat) {
  const server = new Server({ name, version: version3 }, {
    capabilities: {
      tools: { listChanged: true }
    }
  });
  let backendPromise;
  let heartbeatStarted = false;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    serverDebug("listTools");
    const tools = factory.toolSchemas.map((s) => toMcpTool(s));
    const backend = await backendPromise?.catch(() => void 0);
    tools.push(...backend?.dynamicTools?.() ?? []);
    return { tools };
  });
  const onClose = () => backendPromise?.then((b) => b.dispose?.()).catch(serverDebug);
  addServerListener(server, "close", onClose);
  server.setRequestHandler(CallToolRequestSchema, async (request2, extra) => {
    serverDebug("callTool", request2);
    try {
      if (!backendPromise) {
        const promise = initializeServer(server, factory, transportInitialized).then((backend2) => {
          backend2.on?.("dynamictoolschange", () => {
            if (backendPromise === promise)
              void server.sendToolListChanged().catch(serverDebug);
          });
          backend2.once("disconnected", () => {
            if (backendPromise === promise)
              backendPromise = void 0;
            void backend2.dispose?.().catch(serverDebug);
          });
          if (runHeartbeat && !heartbeatStarted) {
            heartbeatStarted = true;
            void transportInitialized.then(() => startHeartbeat(server));
          }
          return backend2;
        }).catch((e) => {
          if (backendPromise === promise)
            backendPromise = void 0;
          throw e;
        });
        backendPromise = promise;
      }
      const backend = await backendPromise;
      const toolResult = await backend.callTool(request2.params.name, request2.params.arguments || {}, extra.signal);
      const mergedResult = mergeTextParts(toolResult);
      serverDebugResponse("callResult", mergedResult);
      return mergedResult;
    } catch (error) {
      return {
        content: [{ type: "text", text: "### Error\n" + String(error) }],
        isError: true
      };
    }
  });
  return server;
}
function addServerListener(server, event, listener) {
  const oldListener = server[`on${event}`];
  server[`on${event}`] = () => {
    oldListener?.();
    listener();
  };
}

// Unmodified packages/playwright-core/src/tools/mcp/extensionContextFactory.ts,
// from the same bundle. External browser effects are supplied by the harness.
async function createExtensionBrowser(channel, executablePath, customUserDataDir, profileDirName, clientName) {
  customUserDataDir ??= process.env.PWTEST_EXTENSION_USER_DATA_DIR;
  const userDataDir = customUserDataDir ?? (executablePath ? void 0 : defaultUserDataDirForChannel(channel));
  const profileDirectory = profileDirName ?? (userDataDir ? await findPlaywrightExtensionProfile(userDataDir) : void 0);
  if (userDataDir && !executablePath && (!profileDirectory || !await isExtensionInstalledInProfile(import_path60.default.join(userDataDir, profileDirectory))))
    throw new Error(`Playwright Extension not found in "${profileDirectory ? import_path60.default.join(userDataDir, profileDirectory) : userDataDir}". Install it from ${playwrightExtensionInstallUrl}, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable to use a browser at a custom location.`);
  const relay = new CDPRelayServer(channel, executablePath, customUserDataDir, profileDirectory);
  await relay.start();
  debugLogger3(`CDP relay server started, extension endpoint: ${relay.extensionEndpoint()}.`);
  try {
    await relay.establishExtensionConnection(clientName);
    const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true });
    browser.on("disconnected", () => relay.stop());
    return browser;
  } catch (error) {
    relay.stop();
    throw error;
  }
}
var import_path60, debug16, debugLogger3;

// Unmodified CLI daemon/monitor and process-exit functions from the same bundle.
async function monitorSocketPath(socketPath) {
  if (process.platform === "win32")
    return;
  const socketStat = await import_fs67.default.promises.stat(socketPath);
  async function checkSocketPath() {
    const currentStat = await import_fs67.default.promises.stat(socketPath).catch(() => void 0);
    if (!currentStat || !currentStat.isSocket() || currentStat.dev !== socketStat.dev || currentStat.ino !== socketStat.ino) {
      gracefullyProcessExitDoNotHang(0);
      return;
    }
    scheduleSocketCheck();
  }
  function scheduleSocketCheck() {
    const timer = setTimeout(() => void checkSocketPath(), 1e3);
    timer.unref();
  }
  scheduleSocketCheck();
}
async function startCliDaemonServer(sessionName, browserContext, browserInfo2, contextConfig, clientInfo, mcpClientInfo, options) {
  const sessionConfig = createSessionConfig(clientInfo, sessionName, browserInfo2, options);
  const { socketPath } = sessionConfig;
  if (process.platform !== "win32" && await socketExists(socketPath)) {
    try {
      await import_fs67.default.promises.unlink(socketPath);
    } catch (error) {
      throw error;
    }
  }
  const backend = new BrowserBackend(contextConfig, browserContext, browserTools, { idleTimer: options.idleTimer });
  await backend.initialize(mcpClientInfo);
  if (browserContext.isClosed())
    throw new Error("Browser context was closed before the daemon could start");
  const server = import_net10.default.createServer((socket) => {
    const connection = new SocketConnection(socket);
    const abortController = new AbortController();
    connection.onclose = () => abortController.abort();
    connection.onmessage = async (message) => {
      const { id, method, params: params2 } = message;
      try {
        if (method === "stop") {
          await deleteSessionFile(clientInfo, sessionConfig);
          const sendAck = async () => connection.send({ id, result: "ok" }).catch(() => {
          });
          if (options?.exitOnClose)
            gracefullyProcessExitDoNotHang(0, () => sendAck());
          else
            await sendAck();
        } else if (method === "run") {
          const { toolName, toolParams } = parseCliCommand(params2.args);
          toolParams._meta = { cwd: params2.cwd, raw: params2.raw || params2.json, json: !!params2.json };
          const response2 = await backend.callTool(toolName, toolParams, abortController.signal);
          await connection.send({ id, result: formatResult(response2) });
        } else {
          throw new Error(`Unknown method: ${method}`);
        }
      } catch (e) {
        const error = process.env.PWDEBUGIMPL ? e.stack || e.message : e.message;
        connection.send({ id, error }).catch(() => {
        });
      }
    };
  });
  decorateServer(server);
  browserContext.on("close", () => Promise.resolve().then(async () => {
    await deleteSessionFile(clientInfo, sessionConfig);
    if (options?.exitOnClose)
      gracefullyProcessExitDoNotHang(0);
  }));
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await saveSessionFile(clientInfo, sessionConfig);
  options.idleTimer?.poke();
  await monitorSocketPath(socketPath);
  return socketPath;
}
async function saveSessionFile(clientInfo, sessionConfig) {
  await import_fs67.default.promises.mkdir(clientInfo.daemonProfilesDir, { recursive: true });
  const sessionFile = import_path63.default.join(clientInfo.daemonProfilesDir, `${sessionConfig.name}.session`);
  await import_fs67.default.promises.writeFile(sessionFile, JSON.stringify(sessionConfig, null, 2));
}
async function deleteSessionFile(clientInfo, sessionConfig) {
  await import_fs67.default.promises.unlink(sessionConfig.socketPath).catch(() => {
  });
  if (!sessionConfig.cli.persistent) {
    const sessionFile = import_path63.default.join(clientInfo.daemonProfilesDir, `${sessionConfig.name}.session`);
    await import_fs67.default.promises.rm(sessionFile).catch(() => {
    });
  }
}

async function gracefullyCloseAll() {
  await Promise.all(Array.from(gracefullyCloseSet).map((gracefullyClose) => gracefullyClose().catch((e) => {
  })));
}
function gracefullyProcessExitDoNotHang(code, onExit2) {
  const beforeExit = onExit2 ? () => onExit2().catch(() => {
  }) : () => Promise.resolve();
  const callback = () => beforeExit().then(() => process.exit(code));
  setTimeout(callback, 3e4);
  gracefullyCloseAll().then(callback);
}
