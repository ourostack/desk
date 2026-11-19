"use strict";

// Which GitHub account a Copilot CLI child should spend: chosen by the repository owner, never by the ambient GH_TOKEN
// (agent shells export the work account's token, whose Copilot quota can be empty). Work orgs use the work login;
// ourostack, arimendelow and everything else use the personal login. Matches MS Desk's gh-route owner rule.
const { spawnSync } = require("node:child_process");

const WORK_OWNERS = new Set(["teams-microsoft", "gim-home", "shared-internal-tools"]);
const PERSONAL_LOGIN = "arimendelow";
const WORK_LOGIN = "arimendelow_microsoft";

function isWorkOwner(owner, env = process.env) {
  const name = String(owner ?? "").toLowerCase();
  if (!name) return false;
  const extra = String(env.MS_DESK_WORK_OWNERS ?? "").toLowerCase().split(/[\s,]+/u).filter(Boolean);
  return WORK_OWNERS.has(name) || /[_-]microsoft$/u.test(name) || extra.includes(name);
}

function ownerOfRepo(cwd, run = spawnSync) {
  const out = run("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
  const match = /[:/]([^/:\s]+)\/[^/\s]+?(?:\.git)?\s*$/u.exec(String(out.stdout ?? "").trim());
  return match ? match[1] : "";
}

/** The gh login whose Copilot quota a child started in `cwd` should use. DESK_COPILOT_ACCOUNT overrides. */
function copilotLogin(cwd, { env = process.env, run = spawnSync } = {}) {
  if (env.DESK_COPILOT_ACCOUNT) return env.DESK_COPILOT_ACCOUNT;
  return isWorkOwner(ownerOfRepo(cwd, run), env) ? (env.DESK_COPILOT_WORK_ACCOUNT || WORK_LOGIN) : PERSONAL_LOGIN;
}

function withoutAmbientTokens(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN)$/iu.test(key)) delete clean[key];
  }
  return clean;
}

/** `base` for a Copilot child: ambient GH_TOKEN and GITHUB_TOKEN removed, COPILOT_GITHUB_TOKEN set from the owner's account. A token already in COPILOT_GITHUB_TOKEN is kept. */
function copilotEnvironment(base, cwd, { run = spawnSync } = {}) {
  const env = withoutAmbientTokens(base);
  if (env.COPILOT_GITHUB_TOKEN) return env;
  const login = copilotLogin(cwd, { env: base, run });
  const out = run("gh", ["auth", "token", "--hostname", "github.com", "--user", login], { encoding: "utf8", env: withoutAmbientTokens(process.env) });
  const token = String(out.stdout ?? "").trim();
  if (out.status === 0 && token) env.COPILOT_GITHUB_TOKEN = token;
  else process.stderr.write(`copilot-account: run gh auth login --hostname github.com to sign in ${login}; copilot will fall back to its stored login.\n`);
  return env;
}

module.exports = { copilotEnvironment, copilotLogin, isWorkOwner, ownerOfRepo, withoutAmbientTokens };
