#!/usr/bin/env node
// Git credential helper for hosted Desk. It holds no secret: on `get` for
// github.com it asks the gateway's token socket (DESK_TOKEN_SOCKET) for a
// fresh installation token. `store` and `erase` are ignored, since the
// gateway owns the token's life.
import { text } from "node:stream/consumers";
import { requestToken } from "../src/token-client.js";

const input = await text(process.stdin);
if (process.argv[2] !== "get") process.exit(0);
const request = Object.fromEntries(
  input
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
if (request.host !== "github.com") process.exit(0);

try {
  const token = await requestToken();
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
} catch (error) {
  process.stderr.write(`git-credential-desk: ${error.message}\n`);
  process.exit(1);
}
