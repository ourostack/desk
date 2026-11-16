// Starts a stdio MCP server, asks it for tools/list, and writes the result and the inventory the X-ray compares with.
// The inventory is the server's own list, so a tool it serves without a declaration (or the reverse) fails the X-ray.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [server, outDir] = process.argv.slice(2);
if (!server || !outDir) {
  console.error("usage: node ax-tools-list.mjs <server.js> <out-dir>");
  process.exit(2);
}

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

const listed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no tools/list answer within 60 seconds")), 60_000);
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 2) {
      clearTimeout(timer);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ax-xray", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

const result = await listed;
child.stdin.end();
child.kill();

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "tools-list.json"), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(join(outDir, "inventory.json"), `${JSON.stringify({ mcp: result.tools.map((tool) => tool.name) }, null, 2)}\n`);
console.log(`ax-tools-list: ${result.tools.length} tools written to ${outDir}.`);
