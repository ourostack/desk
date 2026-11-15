"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "";
if (args.includes("--version")) { if (mode !== "no-version") console.log(process.env.FAKE_VERSION || "Fake Harness 9.9.9."); process.exit(0); }
const value = (flag) => args[args.indexOf(flag) + 1];
const judging = args.includes("-s");
const log = process.env.FAKE_LOG;
const earlier = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line.includes('"role":"judge"')).length : 0;
const prompt = value("-p");
const cwd = process.cwd();
const git = (gitArgs) => spawnSync("git", gitArgs, { cwd, encoding: "utf8" }).stdout.trim().split("\n");
const linkTarget = (file) => { try { return fs.readlinkSync(file); } catch { return null; } };
if (log) fs.appendFileSync(log, JSON.stringify({ role: judging ? "judge" : "subject", model: value("--model"), pid: process.pid, args, cwd, pathFirst: judging ? null : (process.env.PATH ?? "").split(path.delimiter)[0], deskIsCwd: Boolean(process.env.DESK) && fs.realpathSync(process.env.DESK) === fs.realpathSync(cwd), bound: fs.existsSync(cwd + "/_meta") && fs.existsSync(cwd + "/_archive"), gh: process.env.GH_CONFIG_DIR, heldOut: judging ? null : fs.readdirSync(cwd).filter((name) => name.startsWith("held-out")), deskPerson: judging ? null : (process.env.DESK_PERSON ?? null), linkTo: judging ? null : linkTarget(cwd + "/linked.md"), originMain: judging ? null : git(["--git-dir", path.join(cwd, "..", "origin.git"), "log", "main", "--format=%s"]), originBranches: judging ? null : git(["--git-dir", path.join(cwd, "..", "origin.git"), "branch", "--list"]), prompt, tracked: judging ? null : git(["ls-files"]), commits: judging ? null : git(["log", "--format=%s"]), status: judging ? null : git(["status", "--porcelain"]) }) + "\n");
if (!judging && mode === "write") fs.writeFileSync(cwd + "/written.txt", "x\n");
if (!judging && mode === "commit") { fs.writeFileSync(cwd + "/subject.txt", "x\n"); spawnSync("git", ["add", "-A"], { cwd }); spawnSync("git", ["commit", "-q", "-m", "Subject change"], { cwd }); }
if (!judging && mode === "worktree") { const wt = cwd + "/../wt"; spawnSync("git", ["worktree", "add", "-q", "-b", "fix", wt], { cwd }); fs.writeFileSync(wt + "/subject.txt", "x\n"); spawnSync("git", ["add", "-A"], { cwd: wt }); spawnSync("git", ["commit", "-q", "-m", "Subject change"], { cwd: wt }); fs.writeFileSync(wt + "/worktree-note.md", "x\n"); }
if (!judging && mode === "idle") { spawnSync("git", ["worktree", "add", "-q", "--detach", cwd + "/../idle"], { cwd }); }
if (!judging && mode === "branch") { spawnSync("git", ["checkout", "-q", "-b", "side"], { cwd }); fs.writeFileSync(cwd + "/side.txt", "x\n"); spawnSync("git", ["add", "-A"], { cwd }); spawnSync("git", ["commit", "-q", "-m", "Side change"], { cwd }); spawnSync("git", ["checkout", "-q", "main"], { cwd }); }
if (!judging && mode === "standin") spawnSync("gh", ["api", "repos/x/pulls/1/comments"], { cwd, encoding: "utf8" });
if (!judging && mode === "bigdiff") fs.writeFileSync(cwd + "/src/code.js", "x".repeat(7000) + "\n");
if (mode === "hang-" + (judging ? "judge" : "subject")) setTimeout(() => {}, 60000);
else if (mode === "exit-" + (judging ? "judge" : "subject")) { console.error("fake failure\n"); process.exit(3); }
else if (!judging) {
  const subjectCalls = log ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line.includes('"role":"subject"')).length : 0;
  const content = mode === "empty" || (mode === "empty-once" && subjectCalls === 1) ? "" : "Subject answer.";
  const toolRequests = mode === "tools" ? [{ name: "view", arguments: { path: "SKILL.md" } }] : [];
  console.log(JSON.stringify({ type: "assistant.message", data: { content, toolRequests } }));
} else if (mode === "garbage" || (mode === "flaky" && earlier === 0)) {
  console.log("no verdict here");
} else {
  const ids = [...prompt.matchAll(/- id: (\S+)/gu)].map((match) => match[1]);
  const failing = (process.env.FAKE_FAIL || "").split(",");
  console.log("```json\n" + JSON.stringify({ checks: ids.map((id) => ({ id, passed: !failing.includes(id), evidence: "Fake evidence for " + id })) }) + "\n```");
}