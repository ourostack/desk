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
