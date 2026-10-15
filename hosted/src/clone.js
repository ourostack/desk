// The gateway's clone of the desk repository, which every Desk child works
// in. Git authenticates to GitHub only through the credential helper, which
// asks the gateway's token socket; no token is written to the clone.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = fileURLToPath(new URL("../bin/git-credential-desk.js", import.meta.url));
const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
export const CREDENTIAL_HELPER = `!node ${shellQuote(HELPER_PATH)}`;

// Runs git and resolves with its stdout, or rejects with its stderr.
export function runGit(args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.filter((a) => !a.startsWith("credential.")).join(" ")} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

// Points GitHub credentials at the helper only. The empty value first clears
// any helper inherited from system or global config.
async function configure(dir, git) {
  const helperKey = "credential.https://github.com.helper";
  await git(["-C", dir, "config", "--replace-all", helperKey, ""]);
  await git(["-C", dir, "config", "--add", helperKey, CREDENTIAL_HELPER]);
  await git(["-C", dir, "config", "credential.useHttpPath", "false"]);
  await git(["-C", dir, "config", "pull.rebase", "true"]);
}

// Clones https://github.com/<repo>.git into `dir` when `dir` is absent or
// empty. The clone is partial (no blobs until Git needs them), which keeps the
// first start short; Desk's push, with its pull-rebase retry, works the same
// on it, and Git fetches any missing blob through the credential helper.
// An existing clone is left as it is (Desk's own boot syncs it); only
// its credential settings are written again, so they follow this gateway's
// install location.
export async function ensureClone({ dir, repo, git = runGit, privateContext = false }) {
  const present = existsSync(dir) && readdirSync(dir).length > 0;
  if (present && !existsSync(join(dir, ".git"))) {
    throw new Error(`${dir} holds files but is not a Git checkout; refusing to clone over it.`);
  }
  if (privateContext) {
    // The caller has already entered the clone as its owning UID. Keep the
    // repository URL in a private file, never in an inner Git process's argv.
    if (!existsSync(join(dir, ".git"))) await git(["init", "--quiet"]);
    const marker = join(dir, ".git", "desk-ready");
    if (!existsSync(marker)) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid desk repository.");
      writeFileSync(join(dir, ".git", "desk-repository"), repo, { mode: 0o600 });
      writeFileSync(join(dir, ".git", "config"), `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = desk::origin\nfetch = +refs/heads/*:refs/remotes/origin/*\npromisor = true\npartialclonefilter = blob:none\n[protocol "desk"]\nallow = always\n`, { mode: 0o600 });
      await configure("", (args) => git(args.slice(2)));
      await git(["fetch", "--quiet", "--filter=blob:none", "origin"]);
      await git(["remote", "set-head", "origin", "--auto"]);
      const head = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
      await git(["checkout", "--quiet", "-B", head.slice("origin/".length), "--track", head]);
      writeFileSync(marker, "", { mode: 0o600 });
    }
    await configure("", (args) => git(args.slice(2)));
    return;
  }
  if (!present) {
    await git(["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`, "clone", "--quiet", "--filter=blob:none", `https://github.com/${repo}.git`, dir]);
  }
  await configure(dir, git);
}
