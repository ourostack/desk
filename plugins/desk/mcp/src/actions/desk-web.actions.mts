import { defineAction, defineActions, field } from "../lib/ouro-actions/ouro-actions.mts";
import catalog from "../../web-catalog.json" with { type: "json" };

// The desk-web tools' text and schema constraints come from web-catalog.json, the file the server serves them from.
const schemaOf = (name: string) => catalog.tools.find((tool) => tool.name === name)!.inputSchema;
const describe = (name: string, key: string) => (schemaOf(name).properties as Record<string, { description: string }>)[key]!.description;
const agentOf = (name: string) => catalog.tools.find((tool) => tool.name === name)!.description;

export const browserContext = defineAction({
  id: "browser_context",
  consent: "write",
  label: "Browser context",
  description: "Open or close a browser for this agent.",
  agent: agentOf("browser_context"),
  input: {
    action: field.enum({ label: "Action", description: describe("browser_context", "action"), values: ["open", "close"] }),
    browser: field.enum({ label: "Browser", description: describe("browser_context", "browser"), values: ["fresh", "mine"], optional: true }),
    contextId: field.string({
      label: "Context",
      description: describe("browser_context", "contextId"),
      pattern: schemaOf("browser_context").properties.contextId.pattern,
      optional: true,
    }),
  },
  output: {},
});

export const browserCommand = defineAction({
  id: "browser_command",
  consent: "write",
  label: "Browser command",
  description: "Run one command in an owned browser context.",
  agent: agentOf("browser_command"),
  input: {
    contextId: field.string({
      label: "Context",
      description: describe("browser_command", "contextId"),
      pattern: schemaOf("browser_command").properties.contextId.pattern,
    }),
    args: field.list({
      label: "Args",
      description: describe("browser_command", "args"),
      protocolOnly: true,
      minItems: 1,
      maxItems: 256,
      of: field.string({ label: "Argument", description: "One literal argument.", maxLength: 65536 }),
    }),
  },
  output: {},
});

export default defineActions("desk-web", [browserContext, browserCommand], { tool: "desk-web" });
