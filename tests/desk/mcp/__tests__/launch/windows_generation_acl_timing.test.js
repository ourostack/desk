import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkTempRoot } from "../_temp_roots.js";
import { removeTree } from "../_remove_tree.js";
import { protectWindowsPaths } from "../../../../../plugins/desk/mcp/src/factory/windows-acl.js";

const require = createRequire(import.meta.url);
const mcpRoot = fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url));
const cp = require("node:child_process");
const PROGRAM_SHA = "426463dd0405f86221bd81161772f54eca4699b04a3433f3d240b3ee657e2137";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("owned Windows generation ACL timing separates program time from invocation overhead",
  { skip: process.platform !== "win32", timeout: 150000 }, async t => {
    const root = await mkTempRoot("desk-generation-acl-timing-");
    t.after(() => removeTree(root));
    const generation = path.join(root, "generation"), receipt = path.join(generation, "receipt.json");
    await fs.mkdir(generation, { mode: 0o700 });
    await fs.writeFile(receipt, "{}\n", { mode: 0o600 });
    await protectWindowsPaths([
      { path: generation, kind: "directory", created: true },
      { path: receipt, kind: "file", created: true },
    ]);

    // Initialize the normal collector before the same canonical VM compiler.
    require(path.join(mcpRoot, "web-extension-credential.cjs"));
    const rows = [];
    let mode = "original", current;
    const context = {
      module: { exports: {} }, __dirname: mcpRoot, process, Buffer, setTimeout, clearTimeout,
      require: name => name === "child_process" ? {
        execFileSync(executable, argv, options) {
          const script = argv.at(-1);
          assert.equal(sha(script), PROGRAM_SHA);
          assert.equal(options.timeout, 5000);
          assert.equal(options.maxBuffer, 16384);
          current = { mode, sourceProgramSha256: PROGRAM_SHA };
          const started = performance.now();
          if (mode === "original") {
            try {
              const stdout = cp.execFileSync(executable, argv, options);
              Object.assign(current, { privateResult: stdout === "private", stdoutBytes: Buffer.byteLength(stdout) });
              return stdout;
            } catch (error) {
              Object.assign(current, { code: error.code, status: error.status, signal: error.signal,
                stdoutBytes: Buffer.byteLength(error.stdout ?? ""), stderrBytes: Buffer.byteLength(error.stderr ?? ""),
                privateResult: (error.stdout ?? "").toString() === "private" });
              throw error;
            } finally { current.outerMs = Math.round(performance.now() - started); }
          }
          // This separate diagnostic twin does not replace the original call.
          // Its only extra output is fixed markers and a duration, never paths.
          const twin = "$__deskClock=[Diagnostics.Stopwatch]::StartNew();" +
            "[Console]::Error.WriteLine('__DESK_ACL_START__');" + script +
            ";[Console]::Error.WriteLine('__DESK_ACL_MS__'+$__deskClock.ElapsedMilliseconds);";
          const result = cp.spawnSync(executable, [...argv.slice(0, -1), twin], options);
          const stdout = (result.stdout ?? "").toString(), stderr = (result.stderr ?? "").toString();
          const match = /__DESK_ACL_MS__(\d+)/u.exec(stderr);
          Object.assign(current, {
            outerMs: Math.round(performance.now() - started), twinProgramSha256: sha(twin),
            startedMarkerCaptured: stderr.includes("__DESK_ACL_START__"),
            programMs: match === null ? null : Number(match[1]),
            privateResult: stdout === "private", stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr), status: result.status, signal: result.signal,
            code: result.error?.code ?? null,
          });
          if (match !== null) current.invocationOverheadMs = current.outerMs - current.programMs;
          if (result.error || result.status !== 0)
            throw Object.assign(new Error("owned ACL timing twin did not complete"), { code: result.error?.code ?? "ACL_TWIN_FAILED" });
          return stdout;
        },
      } : require(name),
    };
    require("./fixtures/native-template-loader.cjs").loadTemplate(
      path.join(mcpRoot, "web-extension-credential.cjs"), context);
    assert.equal(typeof context.assertPrivateGeneration, "function");
    for (let sample = 0; sample < 8; sample++) {
      for (mode of ["original", "diagnostic-twin"]) {
        current = null;
        try {
          context.assertPrivateGeneration(generation, receipt);
          current.guardPassed = true;
        } catch (error) {
          if (current === null) throw error;
          current.guardPassed = false;
          current.guardCode = error.code ?? "ACL_TIMING_GUARD_FAILED";
        }
        rows.push({ sample, ...current });
      }
    }
    const summary = {
      timeoutMs: 5000, maxBuffer: 16384, sourceProgramSha256: PROGRAM_SHA, rows,
      scope: "Original calls unchanged; separate marked twins only. No raw program, input, paths, stdout or stderr logged.",
    };
    await fs.writeFile(fileURLToPath(new URL("../../../../../windows-generation-acl-timing.json", import.meta.url)),
      JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    t.diagnostic("Windows generation ACL phase timing " + JSON.stringify(summary));
    assert.equal(rows.filter(row => !row.guardPassed).length, 0, "actual guard failures remain failures, not timing waivers");
    assert.ok(rows.filter(row => row.mode === "diagnostic-twin")
      .every(row => row.startedMarkerCaptured && row.programMs !== null && row.privateResult));
  });
