// Asks the gateway's token socket for one installation token. Shared by the
// Git credential helper and the gh shim, which run in Desk's processes and
// hold no secret of their own.
import { connect } from "node:net";

// Resolves with the token, or rejects with a message fit to show the user.
export async function requestToken(socketPath = process.env.DESK_TOKEN_SOCKET) {
  if (!socketPath) throw new Error("DESK_TOKEN_SOCKET is not set, so there is no gateway to ask for a token.");
  let reply;
  try {
    reply = JSON.parse(await readReply(socketPath));
  } catch (error) {
    throw new Error(`could not reach the gateway's token socket at ${socketPath}: ${error.message}`);
  }
  if (typeof reply?.token !== "string" || !reply.token) throw new Error(`the gateway could not mint a token: ${reply?.error ?? "no token in its answer"}`);
  return reply.token;
}

function readReply(socketPath) {
  return new Promise((resolve, reject) => {
    let reply = "";
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error("timed out")));
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
  });
}
