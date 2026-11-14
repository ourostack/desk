// Publishes the package at its package.json version to its usual registry, then lists the older published versions.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const history = JSON.parse(readFileSync("release-history.json", "utf8"));

const published = spawnSync("npm", ["publish"], { stdio: "inherit" });
if (published.status !== 0) process.exit(published.status ?? 1);
console.log(`Published ${pkg.name}@${pkg.version}.`);

const older = history.filter((version) => version !== pkg.version);
if (!process.argv.includes("--delete-older")) {
  console.log(`${older.length} older published versions take up space. Run with --delete-older to delete them.`);
  process.exit(0);
}
for (const version of older) {
  spawnSync("npm", ["unpublish", `${pkg.name}@${version}`], { stdio: "inherit" });
}
