// The gateway's clone of the desk repository, which every Desk child works
// in. Git authenticates to GitHub only through the credential helper, which
// asks the gateway's token socket; no token is written to the clone.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
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

// The media a desk's evidence folders fill up with. The container's disk
// cannot hold them (they are most of a desk's size and grow every day), so the
// clone leaves them out with a sparse checkout: they stay in Git, Desk's moves
// and staging keep them (`--sparse`), and Desk's hosted instructions tell the
// agent which files are not on disk here (runtime/hosted.js). Text, including
// JSON and logs, stays, because an agent reads it.
const MEDIA = ["png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "webm", "mp3", "m4a", "wav", "pdf", "zip", "gz", "tgz", "pptx", "docx", "xlsx"];
export const LEFT_OUT = MEDIA.flatMap((ext) => [`*.${ext}`, `*.${ext.toUpperCase()}`]);

// Clones https://github.com/<repo>.git into `dir` when `dir` is absent or
// empty. The clone is partial (no blobs until Git needs them), which keeps the
// first start short; Desk's push, with its replay onto origin, works the same
// on it, and Git fetches any missing blob through the credential helper.
// It checks out everything but LEFT_OUT. An existing clone is not re-cloned
// (Desk's own boot syncs it); its credential settings and its sparse patterns
// are written again, so they follow this gateway's install and LEFT_OUT.
export async function ensureClone({ dir, repo, git = runGit }) {
  const present = existsSync(dir) && readdirSync(dir).length > 0;
  if (present && !existsSync(join(dir, ".git"))) {
    throw new Error(`${dir} holds files but is not a Git checkout; refusing to clone over it.`);
  }
  if (!present) {
    await git(["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`, "clone", "--quiet", "--no-checkout", "--filter=blob:none", `https://github.com/${repo}.git`, dir]);
  }
  await configure(dir, git);
  // Non-cone patterns: everything, then each left-out kind. On an existing
  // clone this also removes left-out files that are unchanged on disk.
  try {
    await git(["-C", dir, "sparse-checkout", "set", "--no-cone", "/*", ...LEFT_OUT.map((pattern) => `!${pattern}`)]);
    if (!present && (await hasCommit(dir, git))) await git(["-C", dir, "checkout", "--quiet", (await git(["-C", dir, "symbolic-ref", "--short", "HEAD"])).trim()]);
  } catch (error) {
    // A fresh clone that never checked out would look present next start, with every file staged as deleted: empty the directory (it may be a
    // volume mount, so it stays) so the next start clones again.
    if (!present) for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    throw error;
  }
}

// False for a repository with no commits yet, which has nothing to check out.
const hasCommit = (dir, git) => git(["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
