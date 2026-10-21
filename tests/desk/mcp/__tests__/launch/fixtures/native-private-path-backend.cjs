"use strict";
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const frontend = require("../../../../../../plugins/desk/mcp/web-native-private-path.cjs");
const client = require("../../../../../../plugins/desk/mcp/web-native-messaging.cjs");
const [mode, root, input] = process.argv.slice(2);
const entries = JSON.parse(input);
if (process.platform === "win32") {
  client.privatePaths(entries);
  client.privatePaths(entries);
} else {
  frontend.verify(entries, root);
  frontend.verify(entries, root);
}
const digest = createHash("sha256").update(JSON.stringify({
  present: Object.hasOwn(process.env, "NODE_OPTIONS"), value: process.env.NODE_OPTIONS, execArgv: process.execArgv,
})).digest("hex");
process.on("exit", () => {
  fs.writeSync(1, JSON.stringify({ mode, exitCode: process.exitCode || 0, digest }) + "\n");
});
process.once("message", message => {
  if (message !== "proceed") throw Error("OWNED_BACKEND_COMMAND_INVALID");
  process.disconnect();
  if (mode === "explicit-exit") process.exit(0);
  if (mode === "uncaught") throw Error("OWNED_BACKEND_EXPECTED_FAILURE");
  if (mode !== "natural") throw Error("OWNED_BACKEND_MODE_INVALID");
});
process.send({ event: "booted", digest });
