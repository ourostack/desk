// The command runner provision-identity.mjs and identity-checks.mjs share. Every call to az or gh goes through it,
// so tests replace it with a recording fake.
import { spawn } from "node:child_process";

// Runs a command and resolves with { stdout }. stdin carries `input` (a secret, at times); a failure names the
// command's first three words and az's first error line, never the arguments or the input.
export function defaultRunner(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout });
      const error = new Error(`${[cmd, ...args.slice(0, 3)].join(" ")} failed: ${stderr.trim().split("\n")[0] || `exit ${code}`}`);
      error.stderr = stderr;
      reject(error);
    });
    // A command that never reads stdin may exit first; that is not a failure of the write.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export const trimOneNewline = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);
