#!/usr/bin/env node
// Git credential helper for hosted Desk. It holds no secret: on `get` for
// github.com it asks the gateway's token socket (DESK_TOKEN_SOCKET) for a
// fresh installation token. `store` and `erase` are ignored, since the
// gateway owns the token's life.
import { connect } from "node:net";
import { text } from "node:stream/consumers";

const fail = (message) => {
  process.stderr.write(`git-credential-desk: ${message}\n`);
  process.exit(1);
};

function askGateway(socketPath) {
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

const input = await text(process.stdin);
if (process.argv[2] !== "get") process.exit(0);
const request = Object.fromEntries(
  input
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
if (request.host !== "github.com") process.exit(0);

const socketPath = process.env.DESK_TOKEN_SOCKET;
if (!socketPath) fail("DESK_TOKEN_SOCKET is not set, so there is no gateway to ask for a token.");
let reply;
try {
  reply = JSON.parse(await askGateway(socketPath));
} catch (error) {
  fail(`could not reach the gateway's token socket at ${socketPath}: ${error.message}`);
}
if (typeof reply?.token !== "string" || !reply.token) fail(`the gateway could not mint a token: ${reply?.error ?? "no token in its answer"}`);
process.stdout.write(`username=x-access-token\npassword=${reply.token}\n`);
