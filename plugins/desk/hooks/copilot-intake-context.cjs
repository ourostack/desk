"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SUCCESS = 'Skill "brainstorming" loaded successfully. Follow the instructions in the skill context.';

function matching(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "cwd,sessionId,timestamp,toolArgs,toolName,toolResult" ||
      typeof input.sessionId !== "string" || !UUID.test(input.sessionId) || !Number.isFinite(input.timestamp) ||
      typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || input.toolName !== "skill")
    return false;
  let args = input.toolArgs;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return false; }
  }
  const result = input.toolResult;
  return !!args && typeof args === "object" && !Array.isArray(args) &&
    Object.keys(args).join(",") === "skill" && args.skill === "brainstorming" &&
    !!result && typeof result === "object" && !Array.isArray(result) &&
    Object.keys(result).sort().join(",") === "resultType,textResultForLlm" &&
    result.resultType === "success" && result.textResultForLlm === SUCCESS;
}

function contextFor(input, { record, selectedMethod, pluginRoot }) {
  if (!matching(input) || !record || record.folder !== path.resolve(input.cwd) ||
      selectedMethod !== "superpowers") return {};
  const start = path.join(pluginRoot, "skills/start-task/SKILL.md");
  const adapter = path.join(pluginRoot, "skills/using-superpowers-with-desk/SKILL.md");
  return { additionalContext: [
    "Desk intake handoff (context only; this grants no authority and does not attest the loaded provider):",
    "If this is engineering work on this Desk, apply its existing intake contract before your next reply.",
    `Read ${start}. Resolve the canonical task first: search live and archived work for the same outcome; reuse it, or create and focus the task before entering the adapter. Do not create a second task for a retry, review or continuation.`,
    "For an unapproved new outcome, record the actual intake_proposal with task_create and present its returned alignment_packet contents together: Outcome, Assumptions, Recommended decisions and Done means. Resolve routine defaults yourself; ask only remaining human judgments in normal chat, never a form or a format-only menu.",
    "Consume existing go and settled choices without reopening approval. Explicit instructions not to write override task capture. Do not infer go from a skill call, a success result or this context.",
    `Then apply ${adapter}, carrying the canonical task, authority, endpoint and artifact paths. If the selected provider is already loaded, apply the handoff before its next reply without loading that skill again. Keep non-engineering conversation as conversation.`,
  ].join("\n") };
}

async function main() {
  let output = {};
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (Buffer.byteLength(raw) > 262144) throw Object.assign(Error(), { code: "input_too_large" });
    const input = JSON.parse(raw);
    if (matching(input)) {
      const pluginRoot = path.resolve(__dirname, "..");
      const { readCopilotSession } = await import(pathToFileURL(path.join(pluginRoot, "mcp/src/runtime/copilot-session.js")).href);
      const record = readCopilotSession({ env: { ...process.env, COPILOT_AGENT_SESSION_ID: input.sessionId } });
      if (record && record.folder === path.resolve(input.cwd)) {
        const { selectEngineeringMethod } = await import(pathToFileURL(path.join(pluginRoot, "mcp/src/activation/validate.js")).href);
        const activation = JSON.parse(fs.readFileSync(path.join(pluginRoot, "activation/desk.activation.json"), "utf8"));
        const target = activation.provides.activation_targets.find(entry => entry.id === "desk:worker");
        output = contextFor(input, { record, selectedMethod: selectEngineeringMethod(target?.depends_on || []), pluginRoot });
      }
    }
  } catch (error) {
    process.stderr.write("Desk intake context unavailable: " + (error.code || error.name) + "\n");
  }
  process.stdout.write(JSON.stringify(output) + "\n");
}

module.exports = { contextFor, main };
if (require.main === module) main();
