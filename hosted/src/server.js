// The gateway's HTTP surface: the MCP SDK's OAuth endpoints for Claude, the
// consent form's target and the GitHub sign-in callback, a health check, and /mcp, which relays each
// authenticated MCP request to a Desk child unchanged. With the Ouro tenant configured (`entra` and `invites`),
// also the tenant's sign-in callback and the invite pages; without it, none of those routes exist.
import express from "express";
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { githubCallbackHandler } from "./auth/github.js";
import { entraCallbackHandler, inviteHandlers } from "./auth/entra.js";
import { consentHandler } from "./auth/provider.js";
import { page, sendPage } from "./auth/pages.js";

// `unavailable`, when set, is the reason the gateway cannot sign anyone in
// or start Desk yet: /authorize and /mcp answer 503 with it while the rest
// (health, metadata) keeps working.
export function createApp({ provider, relay, githubCallback, issuer, resource, unavailable, entra, invites, log = provider.log }) {
  const app = express();
  // Container Apps terminates TLS one hop in front of the app; the SDK's
  // rate limiters read the client address from X-Forwarded-For.
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => res.type("text").send("ok"));

  if (unavailable) {
    app.all(["/authorize", "/oauth/consent"], (_req, res) => sendPage(res, page(503, unavailable)));
  }

  const routerOptions = {
    provider,
    issuerUrl: new URL(issuer),
    resourceServerUrl: new URL(resource),
    scopesSupported: ["desk"],
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  };
  // The authorization-server metadata is the SDK's plus what the SDK cannot
  // say, served ahead of its router. `offline_access` is granted like `desk`
  // (every client already gets a refresh token); ChatGPT asks for refresh
  // tokens only when the server lists it. The protected-resource metadata
  // keeps `desk` alone, because offline_access is not a scope of the resource.
  // Clients may use an https URL to their metadata document as their id.
  const authorizationServerMetadata = {
    ...createOAuthMetadata(routerOptions),
    scopes_supported: ["desk", "offline_access"],
    client_id_metadata_document_supported: true,
  };
  app.use("/.well-known/oauth-authorization-server", metadataHandler(authorizationServerMetadata));
  app.use(mcpAuthRouter(routerOptions));
  app.post("/oauth/consent", express.urlencoded({ extended: false, limit: "16kb" }), consentHandler(provider, { issuer }));
  app.get("/oauth/github/callback", githubCallbackHandler({ githubCallback }));
  if (entra) app.get("/oauth/entra/callback", entraCallbackHandler(entra, { log }));
  if (invites) {
    const handlers = inviteHandlers(invites);
    app.get("/invite/:token", handlers.landing);
    app.get("/invite", handlers.page);
  }

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
