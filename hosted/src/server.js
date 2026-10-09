// The gateway's HTTP surface: the MCP SDK's OAuth endpoints for Claude, the
// consent form's target and the GitHub sign-in callback, a health check, and /mcp, which relays each
// authenticated MCP request to a Desk child unchanged.
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { githubCallbackHandler } from "./auth/github.js";
import { consentHandler } from "./auth/provider.js";
import { page, sendPage } from "./auth/pages.js";

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
    app.all(["/authorize", "/oauth/consent"], (_req, res) => sendPage(res, page(503, unavailable)));
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
  app.post("/oauth/consent", express.urlencoded({ extended: false, limit: "16kb" }), consentHandler(provider));
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
