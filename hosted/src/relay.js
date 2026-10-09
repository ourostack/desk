// Relays remote MCP sessions to Desk's own stdio MCP server. Each session is
// one Streamable HTTP transport from the MCP SDK paired with one Desk child.
// The relay moves JSON-RPC messages between them unchanged: a message from the
// client becomes one line on the child's stdin, and each line on the child's
// stdout goes back to the client. It reads only message ids, to know which
// requests the child still owes an answer when the child goes away or a call
// runs past its deadline.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";

const log = (message) => process.stderr.write(`desk-hosted relay: ${message}\n`);

function refuse(res, status, code, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// `spawnDesk({ auth, sessionId })` returns the Desk child for a new session,
// or a promise of it; `auth` is the SDK AuthInfo of the initializing request.
// `close()` stops every child: SIGTERM first, then SIGKILL for any child still
// running after `killAfterMs`.
export function createRelay({ spawnDesk, maxSessions = 4, idleMs = 30 * 60_000, callTimeoutMs = 200_000, killAfterMs = 10_000 }) {
  // Insertion order is recency order: touching a session moves it to the end.
  const sessions = new Map();
  let starting = 0;
  let closing = false;

  function touch(session) {
    if (session.closed) return;
    sessions.delete(session.id);
    sessions.set(session.id, session);
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => closeSession(session, "idle"), idleMs);
    session.idleTimer.unref?.();
  }

  // Ends a session once: answers every request the child still owes with a
  // JSON-RPC error, closes the transport and stops the child. `errors` gives
  // the error for particular request ids; the rest get a generic one.
  function closeSession(session, reason, errors = new Map()) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    clearTimeout(session.idleTimer);
    const answers = [...session.pending.keys()].map((id) => {
      clearTimeout(session.pending.get(id));
      const error = errors.get(id) ?? { code: -32603, message: `Desk session ended before answering (${reason})` };
      return session.transport
        .send({ jsonrpc: "2.0", id, error })
        .catch((sendError) => log(`could not answer request ${id}: ${sendError.message}`));
    });
    session.pending.clear();
    Promise.all(answers)
      .then(() => session.transport.close())
      .catch((error) => log(`could not close transport: ${error.message}`));
    const { child } = session;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  function attachDesk(session, child) {
    session.child = child;
    session.exited = new Promise((resolve) => {
      child.once("close", resolve);
      child.once("error", resolve);
    });
    child.stderr?.pipe(process.stderr, { end: false });
    child.stdin.on("error", (error) => log(`session ${session.id} stdin: ${error.message}`));
    child.on("error", (error) => {
      log(`session ${session.id} Desk process error: ${error.message}`);
      closeSession(session, "Desk process error");
    });
    child.on("close", () => closeSession(session, "Desk process exited"));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log(`session ${session.id} dropped a stdout line that is not JSON`);
        return;
      }
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        clearTimeout(session.pending.get(message.id));
        session.pending.delete(message.id);
      }
      touch(session);
      session.transport.send(message).catch((error) => log(`session ${session.id} send: ${error.message}`));
    });
  }

  // A call Desk has not answered within callTimeoutMs ends its session, so
  // the client gets an answer before ingress drops the request and a
  // reconnect starts a fresh Desk.
  function startDeadline(session, id) {
    const timer = setTimeout(() => {
      const message = `Desk did not answer within ${callTimeoutMs / 1000} s; the session was closed. Reconnect to start a new one.`;
      closeSession(session, "call timed out", new Map([[id, { code: -32001, message }]]));
    }, callTimeoutMs);
    timer.unref?.();
    return timer;
  }

  function openSession(id, login, child) {
    const session = { id, login, pending: new Map(), closed: false, initialized: false, child: null, exited: Promise.resolve() };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => session.id,
      onsessioninitialized: () => {
        session.initialized = true;
      },
    });
    attachDesk(session, child);
    session.transport.onmessage = (message) => {
      // A request can reach a session that closed while the transport was
      // handling it; answer it rather than leave it to the child that is gone.
      if (session.closed) {
        if (!isJSONRPCRequest(message)) return;
        const error = { code: -32603, message: "Desk session ended before answering; reconnect to start a new one." };
        session.transport
          .send({ jsonrpc: "2.0", id: message.id, error })
          .catch((sendError) => log(`could not answer request ${message.id}: ${sendError.message}`));
        return;
      }
      if (isJSONRPCRequest(message)) session.pending.set(message.id, startDeadline(session, message.id));
      session.child.stdin.write(JSON.stringify(message) + "\n");
    };
    session.transport.onclose = () => closeSession(session, "transport closed");
    sessions.set(session.id, session);
    touch(session);
    return session;
  }

  // Frees one slot by closing the least recently used session that is not
  // waiting on Desk. Returns false when every session is busy.
  function reapIdle() {
    for (const session of sessions.values()) {
      if (session.pending.size === 0) {
        closeSession(session, "reaped for a new session");
        return true;
      }
    }
    return false;
  }

  async function handle(req, res, auth) {
    req.auth = auth;
    const login = auth?.extra?.login;
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (!session) return refuse(res, 404, -32001, "Session not found");
      if (session.login !== login) return refuse(res, 403, -32000, "Forbidden: session belongs to another user");
      touch(session);
      return session.transport.handleRequest(req, res, req.body);
    }
    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      return refuse(res, 400, -32000, "Bad Request: No valid session ID provided");
    }
    if (typeof login !== "string" || login === "") return refuse(res, 403, -32000, "Forbidden: token has no login");
    if (closing) return refuse(res, 503, -32000, "Service Unavailable: the gateway is shutting down; reconnect shortly.");
    if (sessions.size + starting >= maxSessions && !reapIdle()) {
      return refuse(res, 503, -32000, "Service Unavailable: every session is busy");
    }
    // The Desk child starts before the transport sees the initialize, so it
    // is ready for the first message; a spawn still in progress holds its slot.
    const id = randomUUID();
    let child;
    starting += 1;
    try {
      child = await spawnDesk({ auth, sessionId: id });
    } catch (error) {
      log(`could not start Desk for a new session: ${error.message}`);
      return refuse(res, 502, -32000, "Bad Gateway: Desk could not be started; try again shortly.");
    } finally {
      starting -= 1;
    }
    // close() ran while this child was starting: it has served nothing, so
    // it is killed outright rather than left running past the shutdown.
    if (closing) {
      child.on?.("error", () => {});
      child.kill("SIGKILL");
      return refuse(res, 503, -32000, "Service Unavailable: the gateway is shutting down; reconnect shortly.");
    }
    const session = openSession(id, login, child);
    await session.transport.handleRequest(req, res, req.body);
    // The transport refused the initialize (a bad header, say) without starting a session.
    if (!session.initialized) closeSession(session, "initialize refused");
  }

  // Refuses new sessions from now on and stops every child, resolving once
  // each one has exited.
  async function close() {
    closing = true;
    const all = [...sessions.values()];
    for (const session of all) closeSession(session, "gateway closing");
    await Promise.all(
      all.map(async (session) => {
        const kill = setTimeout(() => {
          log(`session ${session.id} Desk process ignored SIGTERM for ${killAfterMs / 1000} s; sending SIGKILL`);
          session.child?.kill("SIGKILL");
        }, killAfterMs);
        await session.exited;
        clearTimeout(kill);
      }),
    );
  }

  return { handle, close, size: () => sessions.size };
}
