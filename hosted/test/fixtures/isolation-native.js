import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chownSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertChildKernelBoundary, assertGatewayKernelBoundary,
  isolatedDeskEnv, isolationArgs,
} from "../../src/isolation.js";

assert.equal(process.platform, "linux");
const status = () => readFileSync("/proc/self/status", "utf8");
const capabilities = () => Object.fromEntries(status().split("\n")
  .filter(line => /^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/.test(line))
  .map(line => line.trim().split(/:\s*/)));

if (process.env.DESK_NATIVE_ISOLATION_CHILD === "1") {
  const uid = Number(process.env.DESK_NATIVE_EXPECTED_UID);
  assertChildKernelBoundary({ status: status(), uid });
  assert.throws(() => process.setuid(0), { code: "EPERM" });
  assert.equal(readFileSync(join(process.env.DESK, "marker"), "utf8"), "synthetic own marker");
  assert.throws(() => readFileSync(join(process.env.DESK_NATIVE_NEIGHBOR, "clone", "marker")), { code: "EACCES" });
  process.chdir(process.env.DESK);
  assert.equal(process.env.DESK_SIGNING_KEY, undefined);
  console.log(JSON.stringify({
    uid: process.getuid(), gid: process.getgid(), capabilities: capabilities(),
    rootDenied: true, ownRead: true, neighborDenied: true, privateCwd: true, secretsExcluded: true,
  }));
} else {
  assertGatewayKernelBoundary({ status: status(), uid: 1000 });
  const root = "/data/isolation-native";
  mkdirSync(root, { mode: 0o755 });
  chmodSync(root, 0o755);
  const realms = [19001, 19002].map(uid => {
    const realm = { uid, gid: uid, root: join(root, `realm-${uid}`) };
    mkdirSync(realm.root, { mode: 0o700 });
    mkdirSync(join(realm.root, "clone"), { mode: 0o700 });
    const marker = join(realm.root, "clone", "marker");
    writeFileSync(marker, "synthetic own marker", { mode: 0o600 });
    chownSync(marker, uid, uid);
    chownSync(join(realm.root, "clone"), uid, uid);
    chownSync(realm.root, uid, uid);
    return realm;
  });
  const children = realms.map((realm, index) => {
    const child = spawnSync("/usr/bin/setpriv", isolationArgs({
      uid: realm.uid, gid: realm.gid, command: process.execPath,
      args: [fileURLToPath(import.meta.url)],
    }), {
      encoding: "utf8", timeout: 10_000,
      env: {
        ...isolatedDeskEnv({
          realm, baseEnv: { PATH: process.env.PATH, DESK_SIGNING_KEY: "synthetic gateway secret" },
          author: { name: "Synthetic user", email: "synthetic@users.noreply.github.com" },
        }),
        DESK_NATIVE_ISOLATION_CHILD: "1",
        DESK_NATIVE_EXPECTED_UID: String(realm.uid),
        DESK_NATIVE_NEIGHBOR: realms[1 - index].root,
      },
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  });
  console.log(JSON.stringify({ gateway: { uid: process.getuid(), capabilities: capabilities() }, children }));
}
