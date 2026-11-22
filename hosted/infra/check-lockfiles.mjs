#!/usr/bin/env node
// ax: read-only. It lists the tracked lockfiles with git ls-files and reads them; it changes nothing.
// Each failing lockfile is one stderr line that leads with its stable code.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { nonNpmResolved } from "./normalize-lockfile.mjs";

const OUTSIDE_REGISTRY = "lockfile-outside-registry";
const WEAK_INTEGRITY = "lockfile-weak-integrity";

const paths = execFileSync("git", ["ls-files", "-z", "--", "**/package-lock.json", "package-lock.json"], { encoding: "utf8" }).split("\0").filter(Boolean);
let failed = false;
for (const path of paths) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  const bad = nonNpmResolved(lock);
  if (bad.length) {
    failed = true;
    console.error(`${OUTSIDE_REGISTRY}: ${path}: ${bad.length} packages resolve outside registry.npmjs.org: ${bad.join(", ")}`);
  }
  if (path === "hosted/package-lock.json") {
    const weak = Object.entries(lock.packages).filter(([key, entry]) => key && entry.resolved && !entry.link && !entry.integrity?.startsWith("sha512-")).map(([key]) => key);
    if (weak.length) {
      failed = true;
      console.error(`${WEAK_INTEGRITY}: ${path}: ${weak.length} packages lack sha512 integrity: ${weak.join(", ")}`);
    }
  }
}
if (failed) {
  console.error("Repair each failing lockfile with: node hosted/infra/normalize-lockfile.mjs <path>");
  process.exitCode = 1;
} else {
  console.log(`${paths.length} tracked lockfiles resolve from registry.npmjs.org`);
}
