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

// Additional exact maintained Core regions, acquired playwright-core source above.
// createBrowser SHA256 b4976bd9fda5aa82d853428acf2ff586fa16dae44b605649bd2652dd89759d0e
async function createBrowser(config, clientInfo, cliOptions, bindOptions) {
  if (config.browser.remoteEndpoint)
    return await createRemoteBrowser(config);
  let browser;
  let ownership = "own";
  if (config.browser.cdpEndpoint) {
    browser = await createCDPBrowser(config, clientInfo);
    ownership = "attached";
  } else if (config.browser.isolated) {
    browser = await createIsolatedBrowser(config, clientInfo);
    ownership = "own";
  } else if (config.extension) {
    const { channel, executablePath, profileDirName } = resolveExtensionOptions(cliOptions);
    browser = await createExtensionBrowser(channel, executablePath, config.browser.userDataDir, profileDirName, clientInfo.clientName);
    ownership = "attached";
  } else {
    browser = await createPersistentBrowser(config, clientInfo);
    ownership = "own";
  }
  try {
    const { endpoint } = await browser.bind(bindOptions.title, { workspaceDir: bindOptions.workspaceDir });
    return { browser, browserInfo: browserInfo(browser, config), endpoint, ownership };
  } catch (error) {
    await browser.close().catch(() => {
    });
    throw error;
  }
}
async function connectToBrowserEndpoint(config, browser, endpoint) {
  const options = config.browser.remoteEndpoint ? remoteConnectOptions(config).options : {};
  return await browser.browserType().connect(endpoint, options);
}

// Relay/ExtensionConnection assignments are initialized only by the actual-relay VM harness.
// CDPRelayServer SHA256 dafd64e309eb5239f83f4e690879a8829b0abe642e5907208f1d9c5a6e445b6f
function initOwnedRelayFixture() {
    CDPRelayServer = class {
      constructor(browserChannel, executablePath, customUserDataDir, profileDirectory) {
        this._cdpConnection = null;
        this._extensionConnection = null;
        this._extensionConnectionPromise = new ManualPromise();
        this._browserChannel = browserChannel;
        this._executablePath = executablePath;
        this._customUserDataDir = customUserDataDir;
        this._profileDirectory = profileDirectory;
        this._protocolVersion = parseInt(process.env.PWTEST_EXTENSION_PROTOCOL ?? VERSION.toString(), 10);
        this._token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
        const sendCommand = (method, params2) => {
          if (!this._extensionConnection)
            throw new Error("Extension not connected");
          return this._extensionConnection.send(method, params2);
        };
        this._handler = new ExtensionProtocolV2(sendCommand);
        const uuid = crypto.randomUUID();
        this._cdpPath = `/cdp/${uuid}`;
        this._extensionPath = `/extension/${uuid}`;
        void this._extensionConnectionPromise.catch(logUnhandledError);
        this._wsServer = new WSServer({
          onRequest: (request2, response2) => {
            response2.statusCode = 404;
            response2.end();
          },
          onHeaders: () => {
          },
          onUpgrade: () => void 0,
          isAllowedPathname: (pathname) => pathname === this._cdpPath || pathname === this._extensionPath,
          onConnection: (request2, url3, ws4) => {
            debugLogger2(`New connection to ${url3.pathname}`);
            if (url3.pathname === this._cdpPath)
              this._handlePlaywrightConnection(ws4);
            else
              this._handleExtensionConnection(ws4);
            return void 0;
          }
        });
      }
      async start() {
        this._wsHost = await this._wsServer.listen(0, void 0, "");
      }
      cdpEndpoint() {
        return `${this._wsHost}${this._cdpPath}`;
      }
      extensionEndpoint() {
        return `${this._wsHost}${this._extensionPath}`;
      }
      async establishExtensionConnection(clientName) {
        debugLogger2("Establishing extension connection");
        await this._openConnectPageInBrowser(clientName);
        debugLogger2("Waiting for incoming extension connection");
        const deadline = this._token ? monotonicTime() + extensionConnectionTimeout : 0;
        const { timedOut } = await raceAgainstDeadline(async () => {
          await this._extensionConnectionPromise;
          await this._handler.ready();
        }, deadline);
        if (timedOut) {
          const profile = this._profileDirectory ? ` "${this._profileDirectory}"` : "";
          throw new Error(`Playwright extension did not connect within ${extensionConnectionTimeout / 1e3}s after opening the connect page. Make sure the extension is installed in the Chrome profile${profile} and PLAYWRIGHT_MCP_EXTENSION_TOKEN matches its token.`);
        }
        debugLogger2("Extension connection established");
      }
      async _openConnectPageInBrowser(clientName) {
        const mcpRelayEndpoint = `${this._wsHost}${this._extensionPath}`;
        const url3 = new URL(`chrome-extension://${playwrightExtensionId}/connect.html`);
        url3.searchParams.set("mcpRelayUrl", mcpRelayEndpoint);
        const client = {
          name: clientName,
          // Not used anymore.
          version: void 0
        };
        url3.searchParams.set("client", JSON.stringify(client));
        url3.searchParams.set("protocolVersion", this._protocolVersion.toString());
        if (this._token)
          url3.searchParams.set("token", this._token);
        const href = url3.toString();
        const channel = registry.isChromiumAlias(this._browserChannel) ? "chromium" : this._browserChannel;
        let executablePath = this._executablePath;
        if (!executablePath) {
          const executableInfo = registry.findExecutable(channel);
          if (!executableInfo)
            throw new Error(`Unsupported channel: "${this._browserChannel}"`);
          executablePath = executableInfo.executablePath();
          if (!executablePath)
            throw new Error(`"${this._browserChannel}" executable not found. Make sure it is installed at a standard location.`);
        }
        const args = [];
        if (this._customUserDataDir)
          args.push(`--user-data-dir=${this._customUserDataDir}`);
        if (this._profileDirectory)
          args.push(`--profile-directory=${this._profileDirectory}`);
        if (import_os27.default.platform() === "linux" && channel === "chromium")
          args.push("--no-sandbox");
        args.push(href);
        (0, import_child_process5.spawn)(executablePath, args, {
          windowsHide: true,
          detached: true,
          shell: false,
          stdio: "ignore"
        });
      }
      stop() {
        this._closeConnections("Server stopped");
        void this._wsServer.close().catch(logUnhandledError);
      }
      _closeConnections(reason) {
        this._closeCDPConnection(reason);
        this._closeExtensionConnection(reason);
      }
      _handlePlaywrightConnection(ws4) {
        if (!this._extensionConnection) {
          debugLogger2("Rejecting Playwright connection: extension not connected");
          ws4.close(1e3, "Extension not connected");
          return;
        }
        if (this._cdpConnection) {
          debugLogger2("Rejecting second Playwright connection");
          ws4.close(1e3, "Another CDP client already connected");
          return;
        }
        this._cdpConnection = ws4;
        this._handler.connectOverCDP((msg) => this._sendToCDPClient(msg));
        ws4.on("message", async (data) => {
          try {
            await this._handlePlaywrightMessage(JSON.parse(data.toString()));
          } catch (error) {
            debugLogger2(`Error while handling Playwright message
${data.toString()}
`, error);
          }
        });
        ws4.on("close", () => {
          this._closeExtensionConnection("Playwright client disconnected");
          debugLogger2("Playwright WebSocket closed");
        });
        ws4.on("error", (error) => {
          debugLogger2("Playwright WebSocket error:", error);
        });
        debugLogger2("Playwright MCP connected");
      }
      _closeExtensionConnection(reason) {
        this._extensionConnection?.close(reason);
        if (!this._extensionConnectionPromise.isDone())
          this._extensionConnectionPromise.reject(new Error(reason));
      }
      _closeCDPConnection(reason) {
        if (this._cdpConnection?.readyState === ws3.OPEN)
          this._cdpConnection.close(1e3, reason);
      }
      _handleExtensionConnection(ws4) {
        if (this._extensionConnection) {
          ws4.close(1e3, "Another extension connection already established");
          return;
        }
        this._extensionConnection = new ExtensionConnection(ws4);
        this._extensionConnection.onclose = (reason) => {
          debugLogger2("Extension WebSocket closed:", reason);
          this._handler.onExtensionDisconnect(reason);
          this._closeCDPConnection(`Extension disconnected: ${reason}`);
        };
        this._extensionConnection.onmessage = (method, params2) => this._handler.handleExtensionEvent(method, params2);
        this._extensionConnectionPromise.resolve();
      }
      async _handlePlaywrightMessage(message) {
        debugLogger2("\u2190 Playwright:", `${message.method} (id=${message.id})`);
        const { id, sessionId, method, params: params2 } = message;
        try {
          const result2 = await this._handleCDPCommand(method, params2, sessionId);
          this._sendToCDPClient({ id, sessionId, result: result2 });
        } catch (e) {
          debugLogger2("Error in the extension:", e);
          this._sendToCDPClient({
            id,
            sessionId,
            error: { message: e.message }
          });
        }
      }
      async _handleCDPCommand(method, params2, sessionId) {
        switch (method) {
          case "Browser.getVersion": {
            return {
              protocolVersion: "1.3",
              product: "Chrome/Extension-Bridge",
              userAgent: "CDP-Bridge-Server/1.0.0"
            };
          }
          case "Browser.setDownloadBehavior": {
            return {};
          }
        }
        const handled = await this._handler.handleCDPCommand(method, params2, sessionId);
        if (handled)
          return handled.result;
        return await this._handler.forwardToExtension(method, params2, sessionId);
      }
      _sendToCDPClient(message) {
        debugLogger2("\u2192 Playwright:", `${message.method ?? `response(id=${message.id})`}`);
        this._cdpConnection?.send(JSON.stringify(message));
      }
    };
    ExtensionConnection = class {
      constructor(ws4) {
        this._callbacks = /* @__PURE__ */ new Map();
        this._lastId = 0;
        this._ws = ws4;
        this._ws.on("message", this._onMessage.bind(this));
        this._ws.on("close", this._onClose.bind(this));
        this._ws.on("error", this._onError.bind(this));
      }
      async send(method, params2) {
        if (this._ws.readyState !== ws3.OPEN)
          throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
        const id = ++this._lastId;
        this._ws.send(JSON.stringify({ id, method, params: params2 }));
        const error = new Error(`Protocol error: ${method}`);
        return new Promise((resolve, reject) => {
          this._callbacks.set(id, { resolve, reject, error });
        });
      }
      close(message) {
        debugLogger2("closing extension connection:", message);
        if (this._ws.readyState === ws3.OPEN)
          this._ws.close(1e3, message);
      }
      _onMessage(event) {
        const eventData = event.toString();
        let parsedJson;
        try {
          parsedJson = JSON.parse(eventData);
        } catch (e) {
          debugLogger2(`<closing ws> Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
          this._ws.close();
          return;
        }
        try {
          this._handleParsedMessage(parsedJson);
        } catch (e) {
          debugLogger2(`<closing ws> Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
          this._ws.close();
        }
      }
      _handleParsedMessage(object) {
        if (object.id && this._callbacks.has(object.id)) {
          const callback = this._callbacks.get(object.id);
          this._callbacks.delete(object.id);
          if (object.error) {
            const error = callback.error;
            error.message = object.error;
            callback.reject(error);
          } else {
            callback.resolve(object.result);
          }
        } else if (object.id) {
          debugLogger2("\u2190 Extension: unexpected response", object);
        } else {
          this.onmessage?.(object.method, object.params);
        }
      }
      _onClose(code, reason) {
        const message = reason.toString();
        debugLogger2(`<ws closed> code=${code} reason=${message}`);
        this._dispose();
        this.onclose?.(message);
      }
      _onError(event) {
        debugLogger2(`<ws error> message=${event.message} type=${event.type} target=${event.target}`);
        this._dispose();
      }
      _dispose() {
        for (const callback of this._callbacks.values())
          callback.reject(new Error("WebSocket closed"));
        this._callbacks.clear();
      }
    };
}
