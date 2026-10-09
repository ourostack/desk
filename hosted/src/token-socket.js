// Serves installation tokens to Git's credential helper over a Unix socket
// that only the gateway's user can open. Each connection gets one JSON line,
// `{ token }` or `{ error }`, and is then closed.
import { createServer } from "node:net";
import { chmodSync, rmSync } from "node:fs";

export function serveTokens({ socketPath, mint }) {
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
  server.on("listening", () => chmodSync(socketPath, 0o600));
  server.listen(socketPath);
  return server;
}
