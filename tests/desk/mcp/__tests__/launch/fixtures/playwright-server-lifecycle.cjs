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
