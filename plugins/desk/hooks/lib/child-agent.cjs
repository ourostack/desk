"use strict";

// Plain Language loads on demand, and agents do not load it unprompted (0 of 8 haiku runs did), so every start points at it.
const PLAIN_LANGUAGE_POINTER = "Before you write anything a person will read (a reply, handoff, document, PR text, review, comment or commit message), load the `plain-language` skill and follow it.";

// What a child agent (a subagent) gets in place of the boot: its brief is its instruction, so Desk's startup does not apply to it.
const CHILD_AGENT_LINE = "Desk: you are a child agent, so follow your brief and skip Desk's startup. Desk's tools are named `desk-<name>`. Before you write anything a person will read, load the `plain-language` skill.";

// Copilot's prompt hooks name the agent running the prompt: a subagent's input carries `agentId` and `parentAgentId`, a main session's carries neither.
function isChildAgentInput(input) {
  return typeof input?.agentId === "string" && input.agentId !== "" && typeof input?.parentAgentId === "string" && input.parentAgentId !== "";
}

module.exports = { PLAIN_LANGUAGE_POINTER, CHILD_AGENT_LINE, isChildAgentInput };
