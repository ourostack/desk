// The hooks receiver's HTTP surface (plugins/desk/docs/webhooks.md). Anyone may POST an event to a hook's address; the
// receiver checks its signature on the raw bytes, stores it and answers at once. Nothing an event carries is ever run
// here: an agent reads it later as data. Every other route needs a GitHub token mapped to a Desk account
// (identity.js), and a hook belongs to that account.
//
// Logs carry a hook's name, the status and the body's size only, never a body, a header value, an id or a secret.
import express from "express";
import { randomBytes } from "node:crypto";
import { Conflict, EVENT_ID, MAX_BODY_BYTES, HooksStoreError, newEventId } from "./core.js";
import { newServerSecret, newStandardSecret, openSecret, sealSecret } from "./seal.js";
import { resolveVerify, verify } from "./verify.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HOOK_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_LIMIT = 100;
// What an event keeps of its request's headers: what tells an agent what the event is, never credentials or cookies.
export const KEPT_HEADERS = ["content-type", "user-agent", "webhook-id", "webhook-timestamp", "x-github-delivery", "x-github-event", "request-id", "sentry-hook-resource", "linear-delivery", "linear-event", "x-event-type"];
const HEADER_VALUE_MAX = 1024;

const NOT_FOUND = { code: "hook-not-found", error: "not found" };

function keptHeaders(headers) {
  const kept = {};
  for (const name of KEPT_HEADERS) if (typeof headers[name] === "string") kept[name] = headers[name].slice(0, HEADER_VALUE_MAX);
  return kept;
}

/** The secret a new hook signs with: made here, sent by its owner, or none. Returns `{ secret, show }` or `{ error }`. */
function secretFor(spec, given) {
  if (spec.secretFrom === "none") return given === undefined ? { secret: null, show: false } : { code: "secret-unexpected", error: "a hook with verify none has no secret; leave secret out" };
  if (spec.secretFrom === "server") {
    if (given !== undefined) return { code: "secret-unexpected", error: `verify ${spec.preset} makes its own secret and shows it once; leave secret out` };
    return { secret: spec.scheme === "standard" ? newStandardSecret() : newServerSecret(), show: true };
  }
  if (typeof given !== "string" || given.length < 1 || given.length > 1024 || /\s/.test(given)) {
    return { code: "secret-required", error: `verify ${spec.preset} needs the signing secret the sender shows you, as "secret" (1 to 1024 characters, no spaces)` };
  }
  return { secret: given, show: false };
}

// The routes that write nothing, which test/read-only-routes.test.js proves by serving each one with the store
// recording its calls. The census reads this list as their read-only evidence. GET /hooks/:name/events is not on it:
// reading a hook's events also deletes those older than 7 days.
export const READ_ONLY_ROUTES = ["GET /healthz", "GET /hooks"];

export function createHooksApp({ store, identity, key, publicUrl, now = Date.now, log = console.log }) {
  const app = express();
  app.disable("x-powered-by");
  const base = publicUrl.replace(/\/+$/, "");

  app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

  // ── Receiving ──
  app.post("/hooks/:id", express.raw({ type: () => true, limit: MAX_BODY_BYTES }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const hook = HOOK_ID.test(req.params.id) ? await store.hookById(req.params.id) : null;
    if (!hook) {
      log(`hooks: receive unknown 404 ${raw.length} bytes`);
      return res.status(404).json(NOT_FOUND);
    }
    const at = now();
    const secret = hook.sealedSecret ? openSecret(key, hook.sealedSecret) : null;
    const checked = verify(hook.verify, secret, req.headers, raw, at);
    if (!checked.ok) {
      await store.noteRejection(hook.id, checked.reason, at).catch(() => {});
      log(`hooks: receive ${hook.name} 401 ${raw.length} bytes (${checked.reason})`);
      return res.status(401).json({ code: "signature-refused", error: `refused: ${checked.reason}` });
    }
    const outcome = await store.addEvent(hook.id, { eventId: newEventId(at), receivedAt: at, deliveryId: checked.deliveryId, headers: keptHeaders(req.headers), body: raw });
    const status = outcome === "duplicate" ? 200 : 202;
    log(`hooks: receive ${hook.name} ${status} ${raw.length} bytes`);
    return res.status(status).json(outcome === "duplicate" ? { accepted: true, duplicate: true } : { accepted: true });
  });

  // ── Managing and reading: signed in ──
  const signedIn = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const who = await identity(req.get("authorization"));
    if (who.status) return res.status(who.status).json({ code: who.status === 503 ? "identity-unavailable" : "identity-refused", error: who.error });
    req.accountId = who.accountId;
    return next();
  };

  const ownHook = async (req, res) => {
    const hook = NAME.test(req.params.name) ? await store.hookByName(req.accountId, req.params.name) : null;
    if (!hook) res.status(404).json({ code: "hook-not-found", error: `no hook named ${JSON.stringify(req.params.name)}; hooks list shows yours` });
    return hook;
  };

  app.post("/hooks", signedIn, express.json({ limit: "16kb" }), async (req, res) => {
    const { name, verify: verifyName, secret: given } = req.body ?? {};
    if (typeof name !== "string" || !NAME.test(name)) return res.status(400).json({ code: "hook-name-invalid", error: "name must be 1 to 40 lower-case letters, digits and hyphens, starting with a letter or digit" });
    let spec;
    try {
      spec = resolveVerify(verifyName ?? "standard");
    } catch (error) {
      return res.status(400).json({ code: "verification-invalid", error: `${error.message}; use standard, svix, resend, clerk, stripe, github, sentry, linear or none` });
    }
    const made = secretFor(spec, given);
    if (made.error) return res.status(400).json({ code: made.code, error: made.error });
    const id = randomBytes(16).toString("base64url");
    try {
      await store.createHook({ accountId: req.accountId, name, id, verify: spec, sealedSecret: made.secret === null ? null : sealSecret(key, made.secret), createdAt: now() });
    } catch (error) {
      if (error instanceof Conflict) return res.status(409).json({ code: "hook-conflict", error: `a hook named ${name} already exists; delete it first or pick another name` });
      throw error;
    }
    log(`hooks: created ${name} (${spec.preset})`);
    return res.status(201).json({ name, url: `${base}/hooks/${id}`, verify: spec.preset, ...(made.show ? { secret: made.secret } : {}) });
  });

  app.get("/hooks", signedIn, async (req, res) => {
    const hooks = await store.listHooks(req.accountId);
    const listed = [];
    for (const hook of hooks) {
      listed.push({ name: hook.name, verify: hook.verify.preset, createdAt: hook.createdAt, lastEventAt: hook.lastEventAt, pending: await store.pending(hook.id), lastRejection: hook.lastRejection });
    }
    return res.json(listed);
  });

  app.delete("/hooks/:name", signedIn, async (req, res) => {
    const hook = await ownHook(req, res);
    if (!hook) return undefined;
    await store.deleteHook(req.accountId, hook.name);
    log(`hooks: deleted ${hook.name}`);
    return res.status(204).end();
  });

  app.get("/hooks/:name/events", signedIn, async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return res.status(400).json({ code: "event-limit-invalid", error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
    const hook = await ownHook(req, res);
    if (!hook) return undefined;
    const { events, expired } = await store.listEvents(hook.id, { limit, now: now() });
    return res.json({ events: events.map((event) => ({ ...event, body: event.body.toString("base64") })), expired });
  });

  app.delete("/hooks/:name/events/:eventId", signedIn, async (req, res) => {
    const hook = await ownHook(req, res);
    if (!hook) return undefined;
    const gone = EVENT_ID.test(req.params.eventId) && (await store.deleteEvent(hook.id, req.params.eventId));
    if (!gone) return res.status(404).json({ code: "event-not-found", error: `no pending event ${JSON.stringify(req.params.eventId)} on ${hook.name}; it may already be acknowledged` });
    return res.status(204).end();
  });

  app.use((_req, res) => res.status(404).json(NOT_FOUND));

  // A body over its reader's limit, malformed JSON on a management call, the store down or throttling (503, with the Retry-After
  // Table Storage gave, so the sender retries), or anything else (500). Never the error's own text, which may hold keys.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ code: "body-too-large", error: `the body is over ${error.limit} bytes` });
    if (error?.type === "entity.parse.failed") return res.status(400).json({ code: "body-not-json", error: "the body is not valid JSON" });
    // Any other refusal from reading the body, such as an unsupported Content-Encoding (415).
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) return res.status(error.status).json({ code: "body-unreadable", error: "the request body could not be read" });
    if (error instanceof HooksStoreError) {
      log(`hooks: ${error.message}`);
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      return res.status(503).json({ code: "storage-unavailable", error: "storage is unavailable; try again shortly" });
    }
    log(`hooks: unexpected ${error?.name ?? "error"}`);
    return res.status(500).json({ code: "internal-error", error: "internal error" });
  });

  return app;
}
