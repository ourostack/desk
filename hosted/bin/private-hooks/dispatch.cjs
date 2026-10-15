const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const name = process.argv[2];
if (!/^[a-z][a-z0-9-]*$/.test(name) || !process.env.DESK_PRIVATE_HOOK_ORIGINAL_DIR) process.exit(1);
const original = path.join(process.env.DESK_PRIVATE_HOOK_ORIGINAL_DIR, name);
try {
  fs.accessSync(original, fs.constants.X_OK);
  if (!fs.statSync(original).isFile()) process.exit(1);
} catch (error) {
  if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) process.exit(0);
  process.stderr.write("Desk could not inspect the configured Git hook.\n");
  process.exit(1);
}
const env = { ...process.env };
// Nested Git must discover these same public entrypoints, never private hook filenames.
if (env.DESK_PRIVATE_HOOK_WORK_TREE) {
  // A cwd-relative Git directory breaks ordinary same-worktree subdirectory calls.
  delete env.GIT_DIR;
  env.GIT_WORK_TREE = env.DESK_PRIVATE_HOOK_WORK_TREE;
  if (env.GIT_INDEX_FILE) env.GIT_INDEX_FILE = path.resolve(process.cwd(), env.GIT_INDEX_FILE);
}
const relative = path.relative(process.cwd(), original).split(path.sep).join("/");
if (path.isAbsolute(relative)) process.exit(1);
const script = `./${relative}`;
const shellScript = process.platform === "win32" && fs.readFileSync(original, "utf8").startsWith("#!/bin/sh");
const result = spawnSync(shellScript ? "sh" : script, [...(shellScript ? [script] : []), ...process.argv.slice(3)], { env, stdio: "inherit" });
if (result.error) {
  process.stderr.write("Desk could not execute the configured Git hook.\n");
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
