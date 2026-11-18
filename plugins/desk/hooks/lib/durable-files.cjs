"use strict";

// Copilot preToolUse for the file-writing tools (create, edit, the image tools). The host's session `files/` and `images/` folders
// vanish with the session and nobody else can find them, so a report, an inventory, a screenshot or a generated image written there is
// lost to the person and to whoever continues. This never blocks: it allows the call and adds one note naming the focused task's
// desk folder, or telling the agent to start a task first. Fail-open: any problem leaves the call as it was.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DURABLE = /\.(?:md|markdown|png|jpe?g|gif|webp|svg|pdf|csv|json|html)$/iu;
const SESSION_FOLDER = /^[^\\/]+[\\/](?:files|images)[\\/]/u;
const MAX_STDIN = 262144;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The durable files under a session's `files/` or `images/` folder that a tool call names, from any string argument. */
function durablePaths(args, { env = process.env, homeDir = os.homedir() } = {}) {
  const home = env.COPILOT_HOME || path.join(homeDir, ".copilot");
  const root = path.resolve(home, "session-state");
  const found = [];
  for (const value of Object.values(args)) {
    if (typeof value !== "string" || value.length > 4096 || value.includes("\n")) continue;
    const target = path.resolve(value);
    if (target.startsWith(root + path.sep) && SESSION_FOLDER.test(target.slice(root.length + 1)) && DURABLE.test(target)) found.push(target);
  }
  return found;
}

/** The focused task's desk folder for this session, or null. Reads the session's own history through the runtime's focus finder. */
async function focusedFolder({ sessionId, cwd, env, homeDir }) {
  if (typeof sessionId !== "string" || !/^[\w-]+$/u.test(sessionId)) return null;
  const runtime = (name) => import(pathToFileURL(path.join(__dirname, "..", "..", "mcp", "src", "runtime", name)).href);
  const activity = await runtime("session-activity.js");
  const cards = await runtime("focused-card.js");
  const dir = path.join(activity.sessionStateDir(env), sessionId);
  const { focus } = await activity.findFocus(path.join(dir, "events.jsonl"));
  if (focus === null) return null;
  const workspace = activity.readWorkspaceFile(path.join(dir, "workspace.yaml"));
  const bases = cards.cardBases({ cwd: workspace.cwd ?? cwd, gitRoot: workspace.gitRoot, extra: [], homeDir });
  const card = cards.findFocusedCard(bases, focus);
  return card === null ? `${focus.track}/${focus.slug}` : path.dirname(card.file);
}

function noteFor(files, folder) {
  const name = path.basename(files[0]);
  return folder === null
    ? `Desk: ${name} is in the host's session folder, which vanishes with the session and which nobody else can find. No task is focused: run start-task first (task_create with focus: true), then write it in that task's desk folder.`
    : `Desk: ${name} is in the host's session folder, which vanishes with the session and which nobody else can find. If it is for anyone else to read, write it in the focused task's desk folder instead: ${folder}`;
}

/** The hook's answer for one payload: `{}` to leave the call alone, or an allow with the note. */
async function decide(payload, options = {}) {
  try {
    if (!isRecord(payload)) return {};
    let args = payload.toolArgs;
    if (typeof args === "string") args = JSON.parse(args);
    if (!isRecord(args)) return {};
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? os.homedir();
    const files = durablePaths(args, { env, homeDir });
    if (files.length === 0) return {};
    let folder = null;
    try {
      folder = await focusedFolder({ sessionId: payload.sessionId, cwd: payload.cwd, env, homeDir });
    } catch { /* no readable focus reads as no task */ }
    return { permissionDecision: "allow", additionalContext: noteFor(files, folder) };
  } catch {
    return {};
  }
}

function main(stdin = process.stdin, stdout = process.stdout) {
  let input = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => { if (input.length <= MAX_STDIN) input += chunk; });
  stdin.on("end", async () => {
    let payload = null;
    try { payload = JSON.parse(input); } catch { /* not a payload: leave the call alone */ }
    stdout.write(`${JSON.stringify(await decide(payload))}\n`);
  });
}

module.exports = { main };
