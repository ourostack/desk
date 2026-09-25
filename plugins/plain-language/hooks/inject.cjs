#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const event = process.argv[2];
const claudeEvents = ["SessionStart", "SubagentStart"];
const copilotEvents = ["sessionStart"];

if (![...claudeEvents, ...copilotEvents].includes(event)) {
  console.error(`unsupported Plain Language hook event: ${event || "missing"}`);
  process.exit(1);
}

const skillPath = path.join(__dirname, "..", "skills", "plain-language", "SKILL.md");

function loadContract() {
  const body = fs.readFileSync(skillPath, "utf8").replace(/^---[\s\S]*?---\s*/u, "");
  return `[PLAIN_LANGUAGE_CONTRACT]\n${body}`;
}

if (copilotEvents.includes(event)) {
  // Copilot merges every installed plugin's sessionStart output, so one
  // plugin's failure must never block the rest: any error becomes a
  // one-line diagnostic in `additionalContext`, and the process still
  // exits 0.
  let additionalContext;
  try {
    additionalContext = loadContract();
  } catch (error) {
    additionalContext = `Plain Language hook could not load ${skillPath}: ${error.message}`;
  }
  process.stdout.write(JSON.stringify({ additionalContext }));
  process.exit(0);
}

let body;
try {
  body = fs.readFileSync(skillPath, "utf8").replace(/^---[\s\S]*?---\s*/u, "");
} catch (error) {
  console.error(`Plain Language hook could not load ${skillPath}: ${error.message}`);
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext: `[PLAIN_LANGUAGE_CONTRACT]\n${body}`,
  },
}));
