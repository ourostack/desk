import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { connect } from "node:net";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { appJwt, installationToken } from "../src/github-app.js";
import { serveTokens } from "../src/token-socket.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

test("appJwt is an RS256 JWT for the App that verifies with its public key", () => {
  const jwt = appJwt({ appId: "12345", privateKeyPem: PEM, now: 1_800_000_000 });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(payload), { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")));
});

// A stand-in for GitHub's App endpoints. Each minted token expires `ttlMs`
// after the fake clock's time.
function fakeGitHub(clock, { ttlMs = 3_600_000 } = {}) {
  const calls = [];
  let minted = 0;
  async function fetch(url, init = {}) {
    calls.push({ url: String(url), init });
    const auth = init.headers?.authorization ?? "";
    assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    if (String(url) === "https://api.github.com/repos/arimendelow/desk/installation") {
      assert.equal(init.method ?? "GET", "GET");
      return Response.json({ id: 777 });
    }
    if (String(url) === "https://api.github.com/app/installations/777/access_tokens") {
      assert.equal(init.method, "POST");
      minted += 1;
      return Response.json(
        { token: `ghs_token${minted}`, expires_at: new Date(clock.now + ttlMs).toISOString() },
        { status: 201 },
      );
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  return { fetch, calls };
}

test("installationToken asks for a repository-scoped token and caches it until five minutes before expiry", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const github = fakeGitHub(clock);
  const options = { appId: "1", privateKeyPem: PEM, repo: "arimendelow/desk", fetch: github.fetch, now: () => clock.now };

  const first = await installationToken(options);
  assert.equal(first.token, "ghs_token1");
  assert.equal(first.expiresAt, clock.now + 3_600_000);
  assert.deepEqual(
    github.calls.map((call) => call.url),
    ["https://api.github.com/repos/arimendelow/desk/installation", "https://api.github.com/app/installations/777/access_tokens"],
  );
  assert.deepEqual(JSON.parse(github.calls[1].init.body), {
    repositories: ["desk"],
    permissions: { contents: "write", pull_requests: "read" },
  });

  clock.now += 54 * 60_000;
  assert.equal((await installationToken(options)).token, "ghs_token1");
  assert.equal(github.calls.length, 2);

  clock.now += 2 * 60_000; // now 4 minutes before expiry
  assert.equal((await installationToken(options)).token, "ghs_token2");
  assert.equal(github.calls.length, 4);
});

test("installationToken shares one request between concurrent callers", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const github = fakeGitHub(clock);
  const options = { appId: "2", privateKeyPem: PEM, repo: "arimendelow/desk", fetch: github.fetch, now: () => clock.now };
  const [a, b] = await Promise.all([installationToken(options), installationToken(options)]);
  assert.equal(a.token, b.token);
  assert.equal(github.calls.length, 2);
});

test("installationToken fails with the status when GitHub refuses, and a later call tries again", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const github = fakeGitHub(clock);
  const options = { appId: "3", privateKeyPem: PEM, repo: "arimendelow/missing", fetch: github.fetch, now: () => clock.now };
  await assert.rejects(installationToken(options), /404/);
  await assert.rejects(installationToken(options), /404/);
  assert.equal(github.calls.length, 2);
});

function readLine(socketPath) {
  return new Promise((resolve, reject) => {
    let text = "";
    const socket = connect(socketPath);
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

test("serveTokens answers each connection with one line holding a freshly minted token, on a 0600 socket", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desk-tokens-"));
  const socketPath = join(dir, "git-token.sock");
  let n = 0;
  const server = serveTokens({ socketPath, mint: async () => ({ token: `ghs_${++n}`, expiresAt: 0 }) });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(await readLine(socketPath), '{"token":"ghs_1"}\n');
  assert.equal(await readLine(socketPath), '{"token":"ghs_2"}\n');
});

test("serveTokens answers with an error line when minting fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desk-tokens-"));
  const socketPath = join(dir, "git-token.sock");
  const server = serveTokens({ socketPath, mint: async () => Promise.reject(new Error("GitHub said 401")) });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  assert.deepEqual(JSON.parse(await readLine(socketPath)), { error: "GitHub said 401" });
});
