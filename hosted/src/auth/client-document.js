// Client metadata documents (CIMD): a client may use an https URL as its
// client id, and the gateway reads the client's registration from that URL
// instead of asking it to register. claude.ai's "Use Claude's published
// identity" works this way, and the MCP specification prefers it to dynamic
// registration.
//
// Fetching a URL a stranger names is a way into the gateway's network, so
// every fetch is fenced: the id must be a plain https URL; its host must
// resolve only to public addresses, and the gateway connects to the address
// it checked, so a second lookup cannot swap in a private one; no redirect is
// followed; the whole fetch, lookup included, gets 5 seconds; and at most
// 10 KB is read. The document must name its own URL as client_id, every
// redirect it lists must already be allowed by DESK_REDIRECTS, and it must be
// a public client, because a document cannot hold a secret we issued.
//
// Accepted documents are cached for their Cache-Control max-age, clamped to
// between 5 minutes and 24 hours, at most 500 of them; refusals are not
// cached.
import { request } from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";

const MIN_CACHE_SECONDS = 5 * 60;
const MAX_CACHE_SECONDS = 24 * 60 * 60;

class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// A path segment that is `.` or `..`, written plainly or percent-encoded.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

// Returns the parsed URL, or throws when the id is not a plain https URL: no
// fragment, user info or dot segments, a path beyond `/`, and already in the
// form a URL parser would write it, so the id compared and the URL fetched
// are the same text.
function clientIdUrl(clientId) {
  if (typeof clientId !== "string" || !URL.canParse(clientId)) throw new Refusal("invalid_client_id_url");
  const url = new URL(clientId);
  const rawPath = clientId.replace(/^https:\/\/[^/?#]*/i, "").split(/[?#]/)[0];
  if (
    url.protocol !== "https:" ||
    clientId.includes("#") ||
    url.username ||
    url.password ||
    rawPath.split("/").some((segment) => DOT_SEGMENT.test(segment)) ||
    url.pathname === "/" ||
    url.href !== clientId
  ) {
    throw new Refusal("invalid_client_id_url");
  }
  return url;
}

const ipv4Number = (text) => {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
};

// Every IPv4 range that is not the public internet: this network (0/8),
// private (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), loopback (127/8),
// link-local (169.254/16), IETF protocol assignments (192.0.0/24),
// benchmarking (198.18/15), multicast (224/4) and reserved (240/4, which
// holds the broadcast address).
const IPV4_NOT_PUBLIC = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => ({ base: ipv4Number(base), size: 2 ** (32 - bits) }));

const isPublicIPv4 = (value) => !IPV4_NOT_PUBLIC.some(({ base, size }) => value >= base && value < base + size);

// The eight 16-bit groups of an IPv6 address, or null. A zone (`%en0`) is
// dropped; a trailing dotted IPv4 part becomes the last two groups.
function ipv6Groups(text) {
  let address = text.split("%")[0];
  const dotted = address.match(/^(.*:)([^:]*\.[^:]*)$/);
  if (dotted) {
    const value = ipv4Number(dotted[2]);
    if (value === null) return null;
    address = `${dotted[1]}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

const embeddedIPv4 = (high, low) => high * 65536 + low;

// Whether an address is on the public internet. An IPv6 address must be
// global unicast (2000::/3), outside Teredo and documentation space; one that
// carries an IPv4 address (IPv4-mapped, NAT64, 6to4) is judged by that IPv4
// address.
export function isPublicAddress(address) {
  if (typeof address !== "string") return false;
  const family = isIP(address.split("%")[0]);
  if (family === 4) return isPublicIPv4(ipv4Number(address));
  if (family !== 6) return false;
  const g = ipv6Groups(address);
  if (!g) return false;
  const zeros = (from, to) => g.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isPublicIPv4(embeddedIPv4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicIPv4(embeddedIPv4(g[6], g[7]));
  if (g[0] === 0x2002) return isPublicIPv4(embeddedIPv4(g[1], g[2]));
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false;
  return true;
}

// Resolves when `promise` does, or rejects with a timeout once `signal` aborts.
const beforeAbort = (promise, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => reject(new Refusal("timeout"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

const cacheSeconds = (cacheControl) => {
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(cacheControl ?? "");
  const seconds = match ? Number(match[1]) : MIN_CACHE_SECONDS;
  return Math.min(Math.max(seconds, MIN_CACHE_SECONDS), MAX_CACHE_SECONDS);
};

// `lookup` resolves a host to `[{ address, family }]` (node:dns/promises's
// shape with `all: true`); `ca` replaces the trusted roots; `isPublic`,
// `timeoutMs` and `now` exist for tests. `log` gets one line per refusal: the
// reason, and the client id once it is known to be a well-formed URL.
export function createClientDocuments({
  redirects,
  lookup = dnsLookup,
  ca,
  now = Date.now,
  log = () => {},
  isPublic = isPublicAddress,
  timeoutMs = 5000,
  maxBytes = 10 * 1024,
  maxEntries = 500,
}) {
  const cache = new Map(); // client id -> { client, expiresAt }, oldest first
  const inflight = new Map(); // client id -> the one fetch under way

  // Reads the document from `address`, which was resolved and checked
  // already, and returns its body and Cache-Control.
  function fetchFrom(url, { address, family }, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const req = request({
        hostname: host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "application/json" },
        ca,
        agent: false,
        signal,
        // TLS still checks the certificate against the host's name.
        servername: isIP(host) ? undefined : host,
        // Connect to the address already checked, never a fresh lookup.
        lookup: (_hostname, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)),
      });
      const fail = (reason) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Refusal(reason));
      };
      req.on("error", () => fail(signal.aborted ? "timeout" : "fetch_failed"));
      req.on("response", (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) return fail("redirect");
        if (res.statusCode !== 200) return fail("http_status");
        if (Number(res.headers["content-length"]) > maxBytes) return fail("too_large");
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return fail("too_large");
          chunks.push(chunk);
        });
        res.on("error", () => fail(signal.aborted ? "timeout" : "fetch_failed"));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ body: Buffer.concat(chunks).toString("utf8"), cacheControl: res.headers["cache-control"] });
        });
      });
      req.end();
    });
  }

  function clientFrom(clientId, body) {
    let document;
    try {
      document = JSON.parse(body);
    } catch {
      throw new Refusal("not_json");
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Refusal("not_json");
    if (document.client_id !== clientId) throw new Refusal("client_id_mismatch");
    const parsed = OAuthClientMetadataSchema.safeParse(document);
    if (!parsed.success) throw new Refusal("invalid_document");
    const metadata = parsed.data;
    if ((metadata.token_endpoint_auth_method ?? "none") !== "none" || "client_secret" in document) throw new Refusal("confidential_client");
    if (!metadata.redirect_uris.length || !metadata.redirect_uris.every(redirects.allows)) throw new Refusal("invalid_redirect_uri");
    return { ...metadata, client_id: clientId, token_endpoint_auth_method: "none" };
  }

  async function load(clientId) {
    let url;
    try {
      url = clientIdUrl(clientId);
    } catch (refusal) {
      log(`client refused: ${refusal.reason}`);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      let addresses;
      try {
        addresses = await beforeAbort(Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), controller.signal);
      } catch (error) {
        throw error instanceof Refusal ? error : new Refusal("dns_failed");
      }
      if (!Array.isArray(addresses) || addresses.length === 0) throw new Refusal("dns_failed");
      // Every address must be public, not just the one used: a host that
      // answers with a public and a private address is refused outright.
      if (!addresses.every(({ address }) => isPublic(address))) throw new Refusal("private_address");
      const { body, cacheControl } = await fetchFrom(url, addresses[0], controller.signal);
      const client = clientFrom(clientId, body);
      cache.delete(clientId);
      cache.set(clientId, { client, expiresAt: now() + cacheSeconds(cacheControl) * 1000 });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return client;
    } catch (error) {
      log(`client refused: ${error instanceof Refusal ? error.reason : "fetch_failed"} client ${clientId}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // Never throws: any failure is `undefined`, which the SDK answers as
    // invalid_client.
    async get(clientId) {
      const cached = cache.get(clientId);
      if (cached && cached.expiresAt > now()) return cached.client;
      let pending = inflight.get(clientId);
      if (!pending) {
        pending = load(clientId).finally(() => inflight.delete(clientId));
        inflight.set(clientId, pending);
      }
      return pending;
    },
  };
}
