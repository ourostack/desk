// The admin routes (spec item 16), which `ouro desk` in @ouro.bot/cli calls:
//
//   POST   /admin/invites              {displayName} for a new person, or {accountId} to re-invite one
//                                     -> 201 {accountId, inviteUrl, expiresAt}
//   POST   /admin/accounts/:id/access  {on: boolean} -> 200 {accountId, deskAccess}
//   DELETE /admin/accounts/:id         -> 200 {accountId, deleted: true}
//
// Each needs `Authorization: Bearer <token>`, an access token the Ouro tenant issued for the gateway's app that
// carries the `ouro.admin` app role (id-token.js `createAccessTokenVerifier`). A missing or invalid token is 401; a
// valid one without the role is 403. Answers are JSON and never cached.
//
// An invite for a new person creates their account with Desk access on and no desk; they link one after signing in.
// The invite link is a single-use bearer credential: it goes back to the admin and nowhere else, never into a log.
// Logs name accounts, the admin's included, by accountId only.
import express from "express";
import { createAccessTokenVerifier } from "./auth/id-token.js";
import { issueInvite, INVITE_TTL_MS } from "./accounts/invites.js";
import { randomUUID } from "node:crypto";

export const ADMIN_ROLE = "ouro.admin";
const ACCOUNT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_NAME = 100;

const stderrLog = (message) => process.stderr.write(`desk-hosted admin: ${message}\n`);

// The tenant's discovery hasn't loaded, so no token can be checked yet.
export class AdminUnavailable extends Error {
  constructor() {
    super("the Ouro tenant's discovery document has not loaded yet");
    this.name = "AdminUnavailable";
  }
}

// Checks admin bearer tokens against the Ouro tenant, building the verifier once discovery has loaded.
export function createAdminTokenVerifier({ discovery, tenantId, clientId, fetch = globalThis.fetch, now = Date.now }) {
  let verifier = null;
  return {
    async verify(token) {
      if (!discovery.ready()) throw new AdminUnavailable();
      verifier ??= createAccessTokenVerifier({ issuer: discovery.get().issuer, jwksUri: discovery.get().jwksUri, clientId, tenantId, role: ADMIN_ROLE, fetch, now });
      return verifier.verify(token);
    },
  };
}

const fail = (res, status, error, message) => res.status(status).json({ error, message });

// `verifier` is createAdminTokenVerifier's. `forget(accountId)`, when set, drops the account from the account cache
// so a change reaches open sessions at once. `onAccountDeleted(accountId)`, when set, removes what the gateway holds
// for the account outside the store (its realm and clone); it runs after the store rows are gone.
export function createAdmin({ store, verifier, issuer, forget = () => {}, onAccountDeleted = async () => {}, ttlMs = INVITE_TTL_MS, now = Date.now, log = stderrLog }) {
  if (!store || !verifier || !issuer) throw new Error("createAdmin needs the accounts store, a token verifier and the issuer");
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });

  // Authenticates the admin; sets `req.admin` to `{ accountId }` (null when their identity has no account).
  router.use(async (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
    if (!match) {
      res.setHeader("www-authenticate", 'Bearer error="invalid_request"');
      return fail(res, 401, "unauthorized", "An Ouro admin access token is required.");
    }
    let identity;
    try {
      identity = await verifier.verify(match[1]);
    } catch (refusal) {
      if (refusal?.name === "AdminUnavailable") return fail(res, 503, "unavailable", "Ouro sign-in is starting up. Try again shortly.");
      if (refusal?.reason === "role") {
        log("admin refused: no_role");
        return fail(res, 403, "forbidden", `The ${ADMIN_ROLE} role is required.`);
      }
      log(`admin refused: invalid_token (${typeof refusal?.reason === "string" ? refusal.reason : "error"})`);
      res.setHeader("www-authenticate", 'Bearer error="invalid_token"');
      return fail(res, 401, "unauthorized", "The admin access token is not valid.");
    }
    try {
      req.admin = { accountId: await store.findIdentity(identity.tid, identity.oid) };
    } catch {
      return fail(res, 503, "unavailable", "The accounts store can't answer right now. Try again shortly.");
    }
    next();
  });

  router.use(express.json({ limit: "4kb" }));

  const by = (req) => `by account ${req.admin.accountId ?? "unmapped"}`;
  const accountIdOf = (req, res) => {
    const id = req.params.id;
    if (typeof id === "string" && ACCOUNT_ID.test(id)) return id;
    fail(res, 400, "bad_request", "That isn't an account id.");
    return null;
  };
  // Runs a store-backed handler, answering 503 when the store fails.
  const handle = (run) => async (req, res) => {
    try {
      await run(req, res);
    } catch (error) {
      log(`admin failed: ${error?.name === "StoreError" ? "store_unavailable" : "error"} (${typeof error?.name === "string" && /^\w{1,64}$/.test(error.name) ? error.name : "error"})`);
      if (!res.headersSent) fail(res, 503, "unavailable", "The accounts store can't answer right now. Try again shortly.");
    }
  };

  router.post(
    "/invites",
    handle(async (req, res) => {
      const body = req.body;
      if (body === null || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "bad_request", "Send {displayName} or {accountId}.");
      let accountId = body.accountId;
      if (accountId !== undefined) {
        if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) return fail(res, 400, "bad_request", "That isn't an account id.");
        if ((await store.getAccount(accountId)) === null) return fail(res, 404, "not_found", "There is no such account.");
      } else {
        const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (!name || name.length > MAX_NAME) return fail(res, 400, "bad_request", `displayName must be 1 to ${MAX_NAME} characters.`);
        accountId = randomUUID();
        await store.ensureTables();
        await store.putAccount({ accountId, displayName: name, deskAccess: true });
        log(`account created: account ${accountId} ${by(req)}`);
      }
      const at = now();
      const { token } = await issueInvite({ store, accountId, ttlMs, now: at });
      log(`invite issued: account ${accountId} ${by(req)}`);
      res.status(201).json({ accountId, inviteUrl: new URL(`/invite/${token}`, issuer).href, expiresAt: new Date(at + ttlMs).toISOString() });
    }),
  );

  router.post(
    "/accounts/:id/access",
    handle(async (req, res) => {
      const accountId = accountIdOf(req, res);
      if (!accountId) return;
      if (typeof req.body?.on !== "boolean") return fail(res, 400, "bad_request", "Send {on: true} or {on: false}.");
      const result = await store.setAccess(accountId, req.body.on);
      if (!result) return fail(res, 404, "not_found", "There is no such account.");
      forget(accountId);
      log(`access ${req.body.on ? "on" : "off"} account ${accountId} ${by(req)}`);
      res.json(result);
    }),
  );

  router.delete(
    "/accounts/:id",
    handle(async (req, res) => {
      const accountId = accountIdOf(req, res);
      if (!accountId) return;
      if (accountId === req.admin.accountId) return fail(res, 409, "conflict", "An admin can't delete their own account.");
      const existed = await store.deleteAccount(accountId);
      forget(accountId);
      if (!existed) return fail(res, 404, "not_found", "There is no such account.");
      log(`account deleted: account ${accountId} ${by(req)}`);
      // The rows are gone, so a retry would find no account: a failed clean-up is reported, not retried here.
      let deskRemoved = true;
      try {
        await onAccountDeleted(accountId);
      } catch (error) {
        deskRemoved = false;
        log(`account deleted: desk clean-up failed account ${accountId} (${typeof error?.name === "string" && /^\w{1,64}$/.test(error.name) ? error.name : "error"})`);
      }
      res.json({ accountId, deleted: true, deskRemoved });
    }),
  );

  router.use((_req, res) => fail(res, 404, "not_found", "There is no such admin route."));
  // A body that isn't JSON, or is too large, is the caller's mistake; nothing else reaches here.
  router.use((error, _req, res, _next) => {
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") return fail(res, error.status ?? 400, "bad_request", "The body must be a small JSON object.");
    log("admin failed: error");
    fail(res, 500, "error", "The admin request failed.");
  });

  return router;
}
