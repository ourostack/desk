// A fake Desk child for relay tests. It speaks MCP over stdio the way Desk's
// front door does: one JSON-RPC object per line on stdout, logs on stderr.
// Tools: "echo" answers with its text argument; "hang" never answers.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) return;
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "echo-desk", version: "0.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "hang", inputSchema: { type: "object" } }] } });
  } else if (method === "tools/call" && params.name === "echo") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${process.env.ECHO_LOGIN}:${params.arguments.text}` }] } });
  } else if (method === "tools/call" && params.name === "hang") {
    // Never answer, like a Desk call that hangs.
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
