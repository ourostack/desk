import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createClientDocuments, isPublicAddress, MAX_CONCURRENT_LOADS } from "../src/auth/client-document.js";
import { createRedirectPolicy } from "../src/auth/redirects.js";

// A self-signed certificate for client.example, valid until 2126, made for
// these tests only (openssl req -x509 -newkey ec ... -subj /CN=client.example).
// The client trusts it through the injected `ca`, so no test touches the
// system's trust store.
const TLS = {
  key: readFileSync(new URL("./fixtures/client-document-tls.key", import.meta.url)),
  cert: readFileSync(new URL("./fixtures/client-document-tls.crt", import.meta.url)),
};
const HOST = "client.example";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

// The port of the latest document server. Client ids carry no port (the
// gateway allows only 443), so the fetcher is told to connect here instead.
let serverPort;

// A metadata-document server on 127.0.0.1. `routes` maps a path to a handler;
// `hits` counts the requests each path received and `userAgents` the
// User-Agent each request sent.
async function documentServer(t, routes) {
  const hits = {};
  const userAgents = [];
  const server = createServer(TLS, (req, res) => {
    const path = req.url.split("?")[0];
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    userAgents.push(req.headers["user-agent"]);
    const route = routes[path];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  serverPort = server.address().port;
  return { hits, userAgents, url: (path) => `https://${HOST}${path}` };
}

const json = (body, headers = {}) => (_req, res) => {
  const text = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers }).end(text);
};

// The client document a well-behaved client would serve at `url`.
const documentFor = (url, extra = {}) => ({ client_id: url, client_name: "Example", redirect_uris: [CLAUDE_CALLBACK], ...extra });

// A resolver that answers every host with `addresses`, recording each call.
function resolver(addresses = [{ address: "127.0.0.1", family: 4 }]) {
  const calls = [];
  const lookup = async (host, options) => {
    calls.push({ host, options });
    return addresses;
  };
  return { lookup, calls };
}

// The test server lives on loopback, which the real check refuses; tests
// that need to reach it mark 127.0.0.1, and only it, as public.
const testServerIsPublic = (address) => address === "127.0.0.1" || isPublicAddress(address);

function makeDocuments(overrides = {}) {
  const logs = [];
  const documents = createClientDocuments({
    redirects: createRedirectPolicy(undefined),
    lookup: resolver().lookup,
    ca: TLS.cert,
    log: (line) => logs.push(line),
    isPublic: testServerIsPublic,
    connectPort: serverPort,
    ...overrides,
  });
  return { documents, logs };
}

test("a well-formed document from a public address becomes a public client", async (t) => {
  const routes = {};
  const live = await documentServer(t, routes);
  const liveUrl = live.url("/oauth/client.json");
  routes["/oauth/client.json"] = json(documentFor(liveUrl, { scope: "desk offline_access", extra_field: "dropped" }));
  const dns = resolver();
  const { documents, logs } = makeDocuments({ lookup: dns.lookup });
  const client = await documents.get(liveUrl);
  assert.equal(client.client_id, liveUrl);
  assert.equal(client.client_name, "Example");
  assert.deepEqual(client.redirect_uris, [CLAUDE_CALLBACK]);
  assert.equal(client.token_endpoint_auth_method, "none", "a missing method defaults to none");
  assert.equal(client.client_secret, undefined);
  assert.equal(client.extra_field, undefined);
  assert.deepEqual(logs, []);
  // The host was resolved once, by our resolver; the TLS connection to the
  // address it returned verified the certificate for client.example.
  assert.deepEqual(dns.calls.map((call) => call.host), [HOST]);
  assert.equal(dns.calls[0].options.all, true);
});

test("a client id that is not a plain https URL is refused before any lookup", async () => {
  const dns = resolver();
  const { documents, logs } = makeDocuments({ lookup: dns.lookup });
  for (const id of [
    "http://client.example/client.json",
    "https://client.example/client.json#frag",
    "https://client.example/client.json#",
    "https://user@client.example/client.json",
    "https://user:pass@client.example/client.json",
    "https://client.example/a/../client.json",
    "https://client.example/a/./client.json",
    "https://client.example/a/%2e%2e/client.json",
    "https://client.example/a/%2E%2e/client.json",
    "https://client.example/a/.%2e/client.json",
    "https://client.example/a/%2e/client.json",
    "https://client.example/..",
    "https://client.example/",
    "https://client.example",
    "https://CLIENT.example/client.json",
    "https://client.example:443/client.json",
    "https://client.example:8443/client.json",
    "https://client.example/client json",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(await documents.get(id), undefined, String(id));
  }
  assert.equal(dns.calls.length, 0);
  assert.ok(logs.every((line) => line === "client refused: invalid_client_id_url"), logs.join("\n"));
});

test("isPublicAddress refuses private, loopback, link-local, unique-local, CGNAT, unspecified, multicast and their IPv4-mapped forms", () => {
  const refused = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.0.1",
    "::ffff:100.64.0.1",
    "::ffff:0.0.0.0",
    "::ffff:224.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "::127.0.0.1",
    "fe80::1%en0",
    "168.63.129.16",
    "::ffff:168.63.129.16",
    "not an address",
    "",
  ];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "172.15.255.255", "2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("a host that resolves to any non-public address is refused and never contacted", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  for (const address of ["10.0.0.1", "172.16.0.1", "192.168.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
    const { documents, logs } = makeDocuments({ lookup: resolver([{ address, family: 4 }]).lookup, isPublic: isPublicAddress });
    assert.equal(await documents.get(url), undefined, address);
    assert.deepEqual(logs, [`client refused: private_address client ${url}`], address);
  }
  for (const address of ["::1", "fe80::1", "fc00::1", "::", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    const { documents } = makeDocuments({ lookup: resolver([{ address, family: 6 }]).lookup, isPublic: isPublicAddress });
    assert.equal(await documents.get(url), undefined, address);
  }
  assert.equal(server.hits["/client.json"], undefined);
});

test("a host that resolves to both a public and a private address is refused, not raced (DNS rebinding)", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }],
  ]) {
    const { documents, logs } = makeDocuments({ lookup: resolver(addresses).lookup });
    assert.equal(await documents.get(url), undefined, JSON.stringify(addresses));
    assert.deepEqual(logs, [`client refused: private_address client ${url}`]);
  }
  assert.equal(server.hits["/client.json"], undefined);
});

test("a host that does not resolve, or resolves to nothing, is refused", async () => {
  const url = "https://client.example/client.json";
  const failing = makeDocuments({
    lookup: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  assert.equal(await failing.documents.get(url), undefined);
  assert.deepEqual(failing.logs, [`client refused: dns_failed client ${url}`]);
  const empty = makeDocuments({ lookup: resolver([]).lookup });
  assert.equal(await empty.documents.get(url), undefined);
  assert.deepEqual(empty.logs, [`client refused: dns_failed client ${url}`]);
});

test("any redirect is refused and not followed", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const target = server.url("/real.json");
  routes["/real.json"] = json(documentFor(target));
  for (const status of [301, 302, 303, 307, 308]) {
    const url = server.url(`/moved-${status}.json`);
    routes[`/moved-${status}.json`] = (_req, res) => res.writeHead(status, { location: target }).end();
    const { documents, logs } = makeDocuments();
    assert.equal(await documents.get(url), undefined, String(status));
    assert.deepEqual(logs, [`client refused: redirect client ${url}`]);
  }
  assert.equal(server.hits["/real.json"], undefined);
});

test("a status other than 200 is refused", async (t) => {
  const server = await documentServer(t, { "/gone.json": (_req, res) => res.writeHead(410).end("{}") });
  const { documents, logs } = makeDocuments();
  assert.equal(await documents.get(server.url("/gone.json")), undefined);
  assert.deepEqual(logs, [`client refused: http_status client ${server.url("/gone.json")}`]);
  assert.equal(await documents.get(server.url("/missing.json")), undefined);
});

test("a server that answers too slowly, or dribbles bytes past the limit, is cut off", async (t) => {
  const closed = [];
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  const server = await documentServer(t, {
    "/silent.json": (req) => req.on("close", () => closed.push("silent")),
    "/dribble.json": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      const timer = setInterval(() => res.write(" "), 5);
      timers.push(timer);
      res.on("close", () => {
        clearInterval(timer);
        closed.push("dribble");
      });
    },
  });
  for (const path of ["/silent.json", "/dribble.json"]) {
    const { documents, logs } = makeDocuments({ timeoutMs: 50 });
    const started = Date.now();
    assert.equal(await documents.get(server.url(path)), undefined, path);
    assert.ok(Date.now() - started < 1000, `${path} took ${Date.now() - started} ms`);
    assert.deepEqual(logs, [`client refused: timeout client ${server.url(path)}`]);
  }
  for (let i = 0; i < 50 && closed.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(closed.sort(), ["dribble", "silent"], "the gateway closed both connections");
});

test("a slow resolver counts against the same time limit", async () => {
  const { documents, logs } = makeDocuments({ timeoutMs: 50, lookup: () => new Promise(() => {}) });
  assert.equal(await documents.get("https://client.example/client.json"), undefined);
  assert.deepEqual(logs, ["client refused: timeout client https://client.example/client.json"]);
});

test("the time limit defaults to 5 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { documents, logs } = makeDocuments({ lookup: () => new Promise(() => {}) });
  const result = documents.get("https://client.example/client.json");
  await Promise.resolve();
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.deepEqual(logs, []);
  t.mock.timers.tick(1);
  assert.equal(await result, undefined);
  assert.deepEqual(logs, ["client refused: timeout client https://client.example/client.json"]);
});

test("a document over 10 KB is refused, with or without Content-Length, and is not read to the end", async (t) => {
  const closed = [];
  const timers = [];
  t.after(() => timers.forEach(clearInterval));
  const routes = {};
  const server = await documentServer(t, routes);
  const declared = server.url("/declared.json");
  const streamed = server.url("/streamed.json");
  const exact = server.url("/exact.json");
  const big = (url, size) => {
    const base = JSON.stringify(documentFor(url, { padding: "" }));
    return JSON.stringify(documentFor(url, { padding: "x".repeat(size - base.length) }));
  };
  routes["/declared.json"] = (_req, res) => {
    const text = big(declared, 10 * 1024 + 1);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
  };
  // Chunked, with no Content-Length, and never ending: 1 KB every 2 ms.
  routes["/streamed.json"] = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(" ".repeat(1024));
      sent += 1024;
    }, 2);
    timers.push(timer);
    res.on("close", () => {
      clearInterval(timer);
      closed.push(sent);
    });
  };
  routes["/exact.json"] = (_req, res) => {
    const text = big(exact, 10 * 1024);
    res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
    res.end(text);
  };
  const { documents, logs } = makeDocuments();
  assert.equal(await documents.get(declared), undefined);
  assert.equal(await documents.get(streamed), undefined);
  assert.deepEqual(logs, [`client refused: too_large client ${declared}`, `client refused: too_large client ${streamed}`]);
  for (let i = 0; i < 50 && closed.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed.length, 1, "the gateway closed the streaming connection");
  assert.ok(closed[0] < 64 * 1024, `the server sent ${closed[0]} bytes before the cut`);
  assert.equal((await documents.get(exact))?.client_id, exact, "exactly 10 KB is allowed");
});

test("a body that is not a JSON object is refused", async (t) => {
  const server = await documentServer(t, {
    "/text.json": (_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("hello"),
    "/array.json": (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("[]"),
    "/null.json": (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("null"),
  });
  for (const path of ["/text.json", "/array.json", "/null.json"]) {
    const { documents, logs } = makeDocuments();
    assert.equal(await documents.get(server.url(path)), undefined, path);
    assert.deepEqual(logs, [`client refused: not_json client ${server.url(path)}`], path);
  }
});

test("a document whose client_id is not its own URL is refused", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  for (const clientId of [server.url("/other.json"), `${url}/`, url.replace(HOST, "CLIENT.example"), undefined]) {
    routes["/client.json"] = json(documentFor(url, { client_id: clientId }));
    const { documents, logs } = makeDocuments();
    assert.equal(await documents.get(url), undefined, String(clientId));
    assert.deepEqual(logs, [`client refused: client_id_mismatch client ${url}`]);
  }
});

test("a document is refused when any redirect fails DESK_REDIRECTS; the document alone never admits one", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  for (const redirectUris of [[CLAUDE_CALLBACK, "https://client.example/callback"], ["https://evil.example/cb"], []]) {
    routes["/client.json"] = json(documentFor(url, { redirect_uris: redirectUris }));
    const { documents, logs } = makeDocuments();
    assert.equal(await documents.get(url), undefined, JSON.stringify(redirectUris));
    assert.deepEqual(logs, [`client refused: invalid_redirect_uri client ${url}`]);
  }
  routes["/client.json"] = json(documentFor(url, { redirect_uris: ["https://client.example/callback"] }));
  const configured = makeDocuments({ redirects: createRedirectPolicy("https://client.example/callback") });
  assert.deepEqual((await configured.documents.get(url)).redirect_uris, ["https://client.example/callback"]);
});

test("a document that is not valid client metadata is refused", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  for (const extra of [{ redirect_uris: "https://claude.ai/api/mcp/auth_callback" }, { redirect_uris: ["javascript:alert(1)"] }, { client_name: 42 }]) {
    routes["/client.json"] = json(documentFor(url, extra));
    const { documents, logs } = makeDocuments();
    assert.equal(await documents.get(url), undefined, JSON.stringify(extra));
    assert.deepEqual(logs, [`client refused: invalid_document client ${url}`]);
  }
});

test("a document asking for a secret-based token method, or carrying a secret, is refused", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  for (const extra of [{ token_endpoint_auth_method: "client_secret_post" }, { token_endpoint_auth_method: "private_key_jwt" }, { client_secret: "s" }]) {
    routes["/client.json"] = json(documentFor(url, extra));
    const { documents, logs } = makeDocuments();
    assert.equal(await documents.get(url), undefined, JSON.stringify(extra));
    assert.deepEqual(logs, [`client refused: confidential_client client ${url}`]);
  }
  routes["/client.json"] = json(documentFor(url, { token_endpoint_auth_method: "none" }));
  assert.equal((await makeDocuments().documents.get(url)).token_endpoint_auth_method, "none");
});

test("documents are cached for their max-age, clamped to between 5 minutes and 24 hours", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  let clock = 1_000_000_000_000;
  const { documents } = makeDocuments({ now: () => clock });
  const cases = [
    { path: "/none.json", headers: {}, seconds: 300 },
    { path: "/short.json", headers: { "cache-control": "public, max-age=10" }, seconds: 300 },
    { path: "/mid.json", headers: { "cache-control": "max-age=1000" }, seconds: 1000 },
    { path: "/long.json", headers: { "cache-control": "max-age=999999, public" }, seconds: 86400 },
    { path: "/nostore.json", headers: { "cache-control": "no-store" }, seconds: 300 },
  ];
  for (const { path, headers } of cases) routes[path] = json(documentFor(server.url(path)), headers);
  for (const { path, seconds } of cases) {
    const url = server.url(path);
    const start = clock;
    assert.ok(await documents.get(url));
    clock = start + seconds * 1000 - 1;
    assert.ok(await documents.get(url));
    assert.equal(server.hits[path], 1, `${path} is cached just short of ${seconds} s`);
    clock = start + seconds * 1000;
    assert.ok(await documents.get(url));
    assert.equal(server.hits[path], 2, `${path} is fetched again at ${seconds} s`);
  }
});

test("a refused document is not cached", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url, { redirect_uris: ["https://evil.example/cb"] }));
  const { documents } = makeDocuments();
  assert.equal(await documents.get(url), undefined);
  routes["/client.json"] = json(documentFor(url));
  assert.equal((await documents.get(url)).client_id, url);
  assert.equal(server.hits["/client.json"], 2);
});

test("the cache holds at most 500 documents and evicts the oldest", async (t) => {
  const server = await documentServer(t, {
    "/client.json": (req, res) => json(documentFor(server.url(req.url)))(req, res),
  });
  const { documents } = makeDocuments();
  const urls = Array.from({ length: 501 }, (_, i) => server.url(`/client.json?n=${i}`));
  for (const url of urls) assert.ok(await documents.get(url));
  // The first was evicted when the 501st arrived; the second is still held.
  assert.ok(await documents.get(urls[1]));
  assert.equal(server.hits["/client.json?n=1"], 1);
  assert.ok(await documents.get(urls[0]));
  assert.equal(server.hits["/client.json?n=0"], 2);
  assert.ok(await documents.get(urls[500]));
  assert.equal(server.hits["/client.json?n=500"], 1);
});

test("concurrent gets of one uncached document share one fetch and one answer", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = (req, res) => setTimeout(() => json(documentFor(url))(req, res), 20);
  const { documents } = makeDocuments();
  const [first, second, third] = await Promise.all([documents.get(url), documents.get(url), documents.get(url)]);
  assert.equal(server.hits["/client.json"], 1);
  assert.equal(first.client_id, url);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);

  const bad = server.url("/bad.json");
  routes["/bad.json"] = (_req, res) => setTimeout(() => res.writeHead(500).end(), 20);
  assert.deepEqual(await Promise.all([documents.get(bad), documents.get(bad)]), [undefined, undefined]);
  assert.equal(server.hits["/bad.json"], 1);
});

test("a certificate the client does not trust is refused", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  const { documents, logs } = makeDocuments({ ca: undefined });
  assert.equal(await documents.get(url), undefined);
  assert.deepEqual(logs, [`client refused: fetch_failed client ${url}`]);
});

// A DNS server on 127.0.0.1 that answers `answers[name]` (IPv4 addresses) to
// A queries, answers AAAA queries with no records, and never answers a name
// it does not know, the way a black-hole nameserver behaves. Names in
// `silentAAAA` get their A answer but never an AAAA one. `queries` lists
// each name asked.
async function dnsServer(t, answers, silentAAAA = []) {
  const queries = [];
  const socket = createSocket("udp4");
  socket.on("message", (message, peer) => {
    const labels = [];
    let offset = 12;
    while (message[offset] !== 0) {
      labels.push(message.subarray(offset + 1, offset + 1 + message[offset]).toString());
      offset += message[offset] + 1;
    }
    const questionEnd = offset + 5;
    const name = labels.join(".").toLowerCase();
    const type = message.readUInt16BE(offset + 1);
    queries.push(name);
    if (!(name in answers) || (type === 28 && silentAAAA.includes(name))) return;
    const records = type === 1 ? answers[name] : [];
    const header = Buffer.alloc(12);
    message.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const answerRecords = records.map((address) => {
      const record = Buffer.alloc(16);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(1, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(60, 6);
      record.writeUInt16BE(4, 10);
      address.split(".").forEach((octet, i) => (record[12 + i] = Number(octet)));
      return record;
    });
    socket.send(Buffer.concat([header, message.subarray(12, questionEnd), ...answerRecords]), peer.port, peer.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  t.after(() => socket.close());
  return { server: `127.0.0.1:${socket.address().port}`, queries };
}

test("lookups that never answer do not hold up another client's document, and are cut at the deadline (I1)", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  const dns = await dnsServer(t, { [HOST]: ["127.0.0.1"] });
  // The real resolver, pointed at the test DNS server; no lookup is injected.
  const { documents, logs } = makeDocuments({ lookup: undefined, dnsServers: [dns.server], timeoutMs: 1000 });
  const hung = ["https://hung-1.example/client.json", "https://hung-2.example/client.json"].map((id) => documents.get(id));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();
  assert.equal((await documents.get(url))?.client_id, url, "the good document is accepted while two lookups hang");
  // Well inside the 1 s deadline, with room for a slow CI runner.
  assert.ok(Date.now() - started < 900, `the good document took ${Date.now() - started} ms`);
  assert.deepEqual(await Promise.all(hung), [undefined, undefined]);
  assert.deepEqual(logs.sort(), ["client refused: timeout client https://hung-1.example/client.json", "client refused: timeout client https://hung-2.example/client.json"]);
  assert.ok(dns.queries.includes("hung-1.example") && dns.queries.includes(HOST), "the gateway's own resolver asked the test DNS server");
  // Cancelled at the deadline: no query goes out for the hung names afterwards. A retry sent in the
  // same event-loop turn as the abort can reach the test DNS server just after it, so let in-flight
  // packets land first; a resolver that kept querying would still add queries in the window below.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const asked = dns.queries.length;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(dns.queries.length, asked);
});

test("the real resolver refuses a name with no addresses as dns_failed", async (t) => {
  const dns = await dnsServer(t, { "empty.example": [] });
  const { documents, logs } = makeDocuments({ lookup: undefined, dnsServers: [dns.server], timeoutMs: 1000 });
  assert.equal(await documents.get("https://empty.example/client.json"), undefined);
  assert.deepEqual(logs, ["client refused: dns_failed client https://empty.example/client.json"]);
});

test(`at most ${MAX_CONCURRENT_LOADS} uncached documents load at once; one more is refused at once as busy`, async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  let hang = true;
  const fallback = resolver();
  const lookup = (host, options) => (hang ? new Promise(() => {}) : fallback.lookup(host, options));
  const { documents, logs } = makeDocuments({ lookup, timeoutMs: 100 });
  const held = Array.from({ length: MAX_CONCURRENT_LOADS }, (_, i) => documents.get(`https://hung-${i}.example/client.json`));
  const started = Date.now();
  assert.equal(await documents.get("https://one-more.example/client.json"), undefined);
  assert.ok(Date.now() - started < 50, "refused without waiting");
  assert.ok(logs.includes("client refused: busy client https://one-more.example/client.json"));
  // A second get of an id already loading shares that load, not a new slot.
  const shared = documents.get("https://hung-0.example/client.json");
  assert.ok(!logs.includes("client refused: busy client https://hung-0.example/client.json"));
  await Promise.all([...held, shared]);
  hang = false;
  assert.equal((await documents.get(url))?.client_id, url, "the slots are free again after the deadline");
});

test("a client id on the gateway's own host is refused before any lookup", async () => {
  const dns = resolver();
  const { documents, logs } = makeDocuments({ lookup: dns.lookup, ownHost: "desk.ouro.bot" });
  const nested = "https://desk.ouro.bot/authorize?response_type=code&client_id=https://desk.ouro.bot/authorize";
  assert.equal(await documents.get(nested), undefined);
  assert.equal(await documents.get("https://DESK.ouro.bot/x"), undefined);
  assert.equal(dns.calls.length, 0);
  assert.deepEqual(logs, [`client refused: own_host client ${nested}`, "client refused: invalid_client_id_url"]);
});

test("every checked address is offered to the socket, so an unreachable first address falls back to the next", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  // The server listens on 127.0.0.1 only, so ::1 is refused.
  const addresses = [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
  const { documents, logs } = makeDocuments({ lookup: resolver(addresses).lookup, isPublic: (address) => address === "::1" || address === "127.0.0.1" });
  assert.equal((await documents.get(url))?.client_id, url, logs.join("\n"));
});

test("document fetches name the gateway in User-Agent", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  assert.ok(await makeDocuments().documents.get(url));
  assert.deepEqual(server.userAgents, ["ouro-desk-hosted"]);
});

test("the cache evicts the least recently used document, not merely the oldest", async (t) => {
  const server = await documentServer(t, {
    "/client.json": (req, res) => json(documentFor(server.url(req.url)))(req, res),
  });
  const { documents } = makeDocuments();
  const urls = Array.from({ length: 501 }, (_, i) => server.url(`/client.json?n=${i}`));
  for (const url of urls.slice(0, 500)) assert.ok(await documents.get(url));
  assert.ok(await documents.get(urls[0]), "a hit makes the first document the most recently used");
  assert.ok(await documents.get(urls[500]));
  assert.ok(await documents.get(urls[0]));
  assert.equal(server.hits["/client.json?n=0"], 1, "the used document stayed");
  assert.ok(await documents.get(urls[1]));
  assert.equal(server.hits["/client.json?n=1"], 2, "the least recently used one went");
});

test("an AAAA query that never answers does not sink a host whose A record resolved", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  const dns = await dnsServer(t, { [HOST]: ["127.0.0.1"] }, [HOST]);
  const { documents, logs } = makeDocuments({ lookup: undefined, dnsServers: [dns.server], timeoutMs: 5000 });
  const started = Date.now();
  assert.equal((await documents.get(url))?.client_id, url, logs.join("\n"));
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
});

test("when a refetch fails in transit, the last accepted document is served for up to 24 hours", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  let clock = 1_000_000_000_000;
  const { documents, logs } = makeDocuments({ now: () => clock });
  const accepted = await documents.get(url);
  assert.equal(accepted.client_id, url);
  routes["/client.json"] = (_req, res) => res.writeHead(503).end();
  clock += 301 * 1000;
  assert.deepEqual(await documents.get(url), accepted);
  assert.deepEqual(logs, [`client document stale: http_status client ${url}`]);
  assert.equal(server.hits["/client.json"], 2, "the refetch was tried");
  clock = 1_000_000_000_000 + 24 * 3600 * 1000;
  assert.equal(await documents.get(url), undefined, "not past 24 hours from the last accepted fetch");
  assert.equal(logs.at(-1), `client refused: http_status client ${url}`);
});

test("a refetch whose document is now refused drops the client at once, with no stale copy", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  let clock = 1_000_000_000_000;
  const { documents, logs } = makeDocuments({ now: () => clock });
  assert.ok(await documents.get(url));
  routes["/client.json"] = json(documentFor(url, { redirect_uris: ["https://evil.example/cb"] }));
  clock += 301 * 1000;
  assert.equal(await documents.get(url), undefined);
  routes["/client.json"] = (_req, res) => res.writeHead(503).end();
  assert.equal(await documents.get(url), undefined, "the refused document left no stale copy behind");
  assert.deepEqual(logs, [`client refused: invalid_redirect_uri client ${url}`, `client refused: http_status client ${url}`]);
});

test("a private address on refetch is never answered with a stale copy", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  let clock = 1_000_000_000_000;
  let addresses = [{ address: "127.0.0.1", family: 4 }];
  const { documents } = makeDocuments({ now: () => clock, lookup: async () => addresses });
  assert.ok(await documents.get(url));
  addresses = [{ address: "10.0.0.1", family: 4 }];
  clock += 301 * 1000;
  assert.equal(await documents.get(url), undefined);
});

test("a known document is served stale when every load slot is busy", async (t) => {
  const routes = {};
  const server = await documentServer(t, routes);
  const url = server.url("/client.json");
  routes["/client.json"] = json(documentFor(url));
  let clock = 1_000_000_000_000;
  let hang = false;
  const fallback = resolver();
  const lookup = (host, options) => (hang ? new Promise(() => {}) : fallback.lookup(host, options));
  const { documents, logs } = makeDocuments({ now: () => clock, lookup, timeoutMs: 100 });
  const accepted = await documents.get(url);
  clock += 301 * 1000;
  hang = true;
  const held = Array.from({ length: MAX_CONCURRENT_LOADS }, (_, i) => documents.get(`https://hung-${i}.example/client.json`));
  assert.deepEqual(await documents.get(url), accepted);
  assert.ok(logs.includes(`client document stale: busy client ${url}`));
  await Promise.all(held);
});
