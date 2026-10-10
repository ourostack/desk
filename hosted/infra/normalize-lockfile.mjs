#!/usr/bin/env node
// Normalizes hosted/package-lock.json after a dependency change made through a registry mirror.
//
// On a machine whose npm uses a mirror, `npm install` records the mirror's tarball URLs and, when the mirror
// publishes only a SHA-1 `shasum`, SHA-1 integrity. This rewrites every `resolved` to the canonical
// https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz and every `integrity` to the package's sha512:
// the registry's own `dist.integrity` when it has one, otherwise the sha512 of the tarball, downloaded through the
// configured registry and checked against the published `shasum` first. CI's `npm ci` then verifies each sha512
// against npmjs itself. Usage: node infra/normalize-lockfile.mjs [path/to/package-lock.json]
//
// It runs `npm view` through the user's own npm configuration and never reads or prints that configuration.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const NPM = "https://registry.npmjs.org/";

export function canonicalUrl(name, version) {
  const base = name.startsWith("@") ? name.split("/")[1] : name;
  return `${NPM}${name}/-/${base}-${version}.tgz`;
}

// Entries fetched from a registry: everything with a `resolved` URL except links and the root.
const fetched = (lock) => Object.entries(lock.packages ?? {}).filter(([key, entry]) => key && entry.resolved && !entry.link);

export const nonNpmResolved = (lock) => fetched(lock).filter(([, entry]) => !entry.resolved.startsWith(NPM)).map(([key]) => key);

const nameOf = (key, entry) => entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

// `view(spec) -> { integrity?, shasum, tarball }` and `download(url) -> Buffer` are injected for tests.
export async function normalizeLockfile(lock, { view, download, concurrency = 8 }) {
  const queue = fetched(lock);
  const entries = queue.length;
  let viaShasum = 0;
  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, entry] = next;
      const name = nameOf(key, entry);
      const spec = `${name}@${entry.version}`;
      const dist = await view(spec);
      let integrity = dist.integrity?.split(/\s+/).find((one) => one.startsWith("sha512-"));
      if (!integrity) {
        const bytes = await download(dist.tarball);
        if (!dist.shasum || createHash("sha1").update(bytes).digest("hex") !== dist.shasum) {
          throw new Error(`${spec}: the tarball doesn't match the registry's published shasum`);
        }
        integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        viaShasum += 1;
      }
      entry.resolved = canonicalUrl(name, entry.version);
      entry.integrity = integrity;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { entries, viaShasum };
}

async function npmView(spec) {
  const { stdout } = await promisify(execFile)("npm", ["view", spec, "dist", "--json"], { maxBuffer: 1 << 20 });
  return JSON.parse(stdout);
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? new URL("../package-lock.json", import.meta.url).pathname;
  const lock = JSON.parse(readFileSync(path, "utf8"));
  const { entries, viaShasum } = await normalizeLockfile(lock, { view: npmView, download: fetchBytes });
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`${entries} entries normalized to registry.npmjs.org (${viaShasum} sha512s computed from shasum-checked tarballs)`);
}
