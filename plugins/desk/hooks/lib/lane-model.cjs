"use strict";

// Copilot preToolUse for the app's session-starting tools (create_session, open_issue_session, open_pr_session). Without
// `kickoff.model` the app starts the new session on the model of the session that asked, and coordinators run on the most
// expensive one, so every lane inherits it. When the call names no model, this adds Desk's lane default through `modifiedArgs`;
// the app also starts a kickoff in plan mode when `kickoff.mode` is absent, which leaves a lane waiting on a plan approval
// nobody sees, so a missing mode becomes autopilot. A model or mode the caller named is never touched.
// `execution_location: "cloud"` is dropped (the session runs locally), because the cloud sandbox loads no plugins. Fail-open: any problem leaves the call as it was.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LANE_MODEL = "claude-sonnet-5.5";
const DEFAULT_LANE_MODE = "autopilot";
const SESSION_TOOL = /(?:^|[^a-z_])(?:create_session|open_issue_session|open_pr_session)$/u;

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `create_session`, or the same tool under a server prefix (`app-create_session`, `app/create_session`). */
function isSessionTool(name) {
  return typeof name === "string" && SESSION_TOOL.test(name);
}

/** Desk's state folder, where the drains config also lives. */
function configFile({ env = process.env, homeDir = os.homedir() } = {}) {
  const configured = text(env.XDG_STATE_HOME);
  const stateHome = configured !== null && path.isAbsolute(configured) ? configured : path.join(homeDir, ".local", "state");
  return path.join(stateHome, "ouroboros-skills", "desk", "config.json");
}

/** The lane default: `DESK_LANE_MODEL`, else `laneModel` in Desk's `config.json`, else claude-sonnet-5.5. */
function laneModel({ env = process.env, homeDir = os.homedir() } = {}) {
  const fromEnv = text(env.DESK_LANE_MODEL);
  if (fromEnv !== null) return fromEnv;
  try {
    const config = JSON.parse(fs.readFileSync(configFile({ env, homeDir }), "utf8"));
    return (isRecord(config) && text(config.laneModel)) || DEFAULT_LANE_MODEL;
  } catch {
    return DEFAULT_LANE_MODEL;
  }
}

/** `DESK_ALLOW_CLOUD_SESSIONS=1` keeps `execution_location: "cloud"` for a lane that really must run in the cloud. */
function allowCloud({ env = process.env } = {}) {
  return text(env.DESK_ALLOW_CLOUD_SESSIONS) === "1";
}

/** The hook's answer for one payload: `{}` to leave the call alone, or an allow with the arguments plus the default model. */
function decide(payload, options = {}) {
  try {
    if (!isRecord(payload) || !isSessionTool(payload.toolName)) return {};
    let args = payload.toolArgs;
    if (typeof args === "string") args = JSON.parse(args);
    if (!isRecord(args)) return {};
    if (args.kickoff !== undefined && !isRecord(args.kickoff)) return {};
    const kickoff = { ...(args.kickoff ?? {}) };
    if (text(kickoff.model) === null) kickoff.model = laneModel(options);
    if (text(kickoff.mode) === null) kickoff.mode = DEFAULT_LANE_MODE;
    // A cloud session runs in a sandbox that never loads the Desk, MS Desk and Superpowers plugin bundle, so it is started locally.
    const { execution_location: location, ...rest } = args;
    const dropCloud = text(location) === "cloud" && !allowCloud(options);
    if (!dropCloud && isRecord(args.kickoff) && kickoff.model === args.kickoff.model && kickoff.mode === args.kickoff.mode) return {};
    return { permissionDecision: "allow", modifiedArgs: { ...(dropCloud ? rest : args), kickoff } };
  } catch {
    return {};
  }
}

function main(stdin = process.stdin, stdout = process.stdout) {
  let input = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => { input += chunk; });
  stdin.on("end", () => {
    let payload = null;
    try { payload = JSON.parse(input); } catch { /* not a payload: leave the call alone */ }
    stdout.write(`${JSON.stringify(decide(payload))}\n`);
  });
}

module.exports = { main };
