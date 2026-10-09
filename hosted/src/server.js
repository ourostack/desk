// The gateway's HTTP surface: the MCP SDK's OAuth endpoints for Claude, the
// GitHub sign-in callback, a health check, and /mcp, which relays each
// authenticated MCP request to a Desk child unchanged.
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { githubCallbackHandler } from "./auth/github.js";

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// `unavailable`, when set, is the reason the gateway cannot sign anyone in
// or start Desk yet: /authorize and /mcp answer 503 with it while the rest
// (health, metadata) keeps working.
export function createApp({ provider, relay, githubCallback, issuer, resource, unavailable }) {
  const app = express();
  // Container Apps terminates TLS one hop in front of the app; the SDK's
  // rate limiters read the client address from X-Forwarded-For.
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => res.type("text").send("ok"));

  if (unavailable) {
    app.all("/authorize", (_req, res) => {
      res
        .status(503)
        .type("html")
        .send(`<!doctype html><html><head><meta charset="utf-8"><title>Desk sign-in</title></head><body><p>${escapeHtml(unavailable)}</p></body></html>`);
    });
  }

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(issuer),
      resourceServerUrl: new URL(resource),
      scopesSupported: ["desk"],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.get("/oauth/github/callback", githubCallbackHandler({ githubCallback }));

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
  app.all(
    "/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl }),
    express.json({ limit: "4mb" }),
    (req, res) => {
      if (unavailable) {
        return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: unavailable }, id: null });
      }
      return relay.handle(req, res, req.auth);
    },
  );

  return app;
}
