import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeLockfile, canonicalUrl, nonNpmResolved } from "../infra/normalize-lockfile.mjs";

const sha512 = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sha1hex = (bytes) => createHash("sha1").update(bytes).digest("hex");
const MIRROR = "https://mirror.example/npm/registry/";

const BYTES = { "jose@6.2.12": Buffer.from("jose tarball"), "@azure/identity@4.13.3": Buffer.from("identity tarball"), "string-width-cjs@4.2.3": Buffer.from("string-width tarball") };

function fixture() {
  return {
    name: "x",
    lockfileVersion: 3,
    packages: {
      "": { name: "x", dependencies: { jose: "6.2.12" } },
      "node_modules/jose": { version: "6.2.12", resolved: `${MIRROR}jose/-/jose-6.2.12.tgz`, integrity: "sha1-AAAA" },
      "node_modules/@azure/identity": { version: "4.13.3", resolved: "https://registry.npmjs.org/@azure/identity/-/identity-4.13.3.tgz", integrity: "sha1-BBBB" },
      // An npm alias: the folder name differs from the package's real name.
      "node_modules/string-width-cjs": { name: "string-width", version: "4.2.3", resolved: `${MIRROR}string-width/-/string-width-4.2.3.tgz`, integrity: "sha1-CCCC" },
      "node_modules/local": { resolved: "../local", link: true },
    },
  };
}

// What the registry says about each version: the mirror publishes only a SHA-1 `shasum` for some packages.
function registry({ withIntegrity = [], badShasum = [] } = {}) {
  const views = [];
  const view = async (spec) => {
    views.push(spec);
    const key = spec === "string-width@4.2.3" ? "string-width-cjs@4.2.3" : spec;
    const bytes = BYTES[key];
    const dist = { tarball: `${MIRROR}${spec}.tgz`, shasum: badShasum.includes(spec) ? "0".repeat(40) : sha1hex(bytes) };
    if (withIntegrity.includes(spec)) dist.integrity = sha512(bytes);
    return dist;
  };
  const download = async (url) => {
    const spec = url.slice(MIRROR.length, -".tgz".length);
    return BYTES[spec === "string-width@4.2.3" ? "string-width-cjs@4.2.3" : spec];
  };
  return { view, download, views };
}

test("canonical npm URLs for plain, scoped and aliased packages", () => {
  assert.equal(canonicalUrl("jose", "6.2.12"), "https://registry.npmjs.org/jose/-/jose-6.2.12.tgz");
  assert.equal(canonicalUrl("@azure/identity", "4.13.3"), "https://registry.npmjs.org/@azure/identity/-/identity-4.13.3.tgz");
});

test("every resolved URL becomes npm's, and every integrity the published sha512", async () => {
  const lock = fixture();
  const { view, download, views } = registry({ withIntegrity: ["jose@6.2.12"] });
  const summary = await normalizeLockfile(lock, { view, download });
  const p = lock.packages;
  assert.equal(p["node_modules/jose"].resolved, "https://registry.npmjs.org/jose/-/jose-6.2.12.tgz");
  assert.equal(p["node_modules/jose"].integrity, sha512(BYTES["jose@6.2.12"]));
  assert.equal(p["node_modules/@azure/identity"].integrity, sha512(BYTES["@azure/identity@4.13.3"]));
  assert.equal(p["node_modules/string-width-cjs"].resolved, "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz");
  assert.equal(p["node_modules/string-width-cjs"].integrity, sha512(BYTES["string-width-cjs@4.2.3"]));
  assert.deepEqual(p["node_modules/local"], { resolved: "../local", link: true }, "links are left alone");
  assert.deepEqual(p[""], fixture().packages[""]);
  assert.deepEqual(views.sort(), ["@azure/identity@4.13.3", "jose@6.2.12", "string-width@4.2.3"]);
  assert.deepEqual(summary, { entries: 3, viaShasum: 2 });
  assert.deepEqual(nonNpmResolved(lock), []);
});

test("a tarball whose SHA-1 doesn't match the published shasum stops the run", async () => {
  const lock = fixture();
  const { view, download } = registry({ badShasum: ["@azure/identity@4.13.3"] });
  await assert.rejects(normalizeLockfile(lock, { view, download }), /@azure\/identity@4\.13\.3/);
});

test("nonNpmResolved lists every resolved URL outside registry.npmjs.org", () => {
  assert.deepEqual(nonNpmResolved(fixture()), ["node_modules/jose", "node_modules/string-width-cjs"]);
});
