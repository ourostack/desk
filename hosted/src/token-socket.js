// Serves installation tokens to Git's credential helper over a Unix socket
// that only the gateway's user can open. Each connection gets one JSON line,
// `{ token }` or `{ error }`, and is then closed.
import { createServer } from "node:net";
import { chmodSync, chownSync, rmSync } from "node:fs";

export function serveTokens({ socketPath, mint, uid, gid = uid }) {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    Promise.resolve()
      .then(mint)
      .then(
        ({ token }) => socket.end(JSON.stringify({ token }) + "\n"),
        (error) => socket.end(JSON.stringify({ error: error.message }) + "\n"),
      );
  });
  // A socket file left by an earlier run would make listen fail.
  rmSync(socketPath, { force: true });
  server.ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      try {
        chmodSync(socketPath, 0o600);
        if (uid !== undefined) chownSync(socketPath, uid, gid);
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
  // Legacy consumers await the listening event; keep failed readiness handled
  // there too. Realm consumers must await ready before allowing Git to run.
  server.ready.catch(() => {});
  server.listen(socketPath);
  return server;
}
