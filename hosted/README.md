# Hosted Desk gateway

The hosted Desk gateway lets claude.ai use Desk as a remote MCP server at `https://desk.ouro.bot/mcp`. It is a thin HTTP front for Desk's own MCP server: for each Claude session it starts Desk's unchanged stdio server (`node plugins/desk/mcp/index.js --root <clone>`) with `DESK_HOSTED=1` and relays JSON-RPC bytes both ways. It never parses, edits or adds to Desk's messages, and it never reimplements a Desk behavior; anything Desk must do differently for a remote client lives in Desk behind `DESK_HOSTED`.

The gateway adds only what a remote host needs:

- **An HTTP endpoint.** Streamable HTTP MCP at `/mcp`, plus `/healthz`.
- **Sign-in.** It is the OAuth authorization server MCP clients talk to (dynamic client registration, client metadata documents, PKCE, rotating refresh tokens), and it signs users in with the "Ouro Desk" GitHub App. Before sending the browser to GitHub, it shows a consent page that names the client and the host its sign-in will be sent to, and continues only when the person approves. Only the logins in `DESK_ALLOWED_LOGINS` are admitted.
- **Clients.** A client registers itself, or uses the https URL of its client metadata document as its client id (claude.ai's "Use Claude's published identity"). The gateway fetches a document only over port 443, never from its own host, and only from a host whose every address is public (Azure's platform address 168.63.129.16 counts as private), connecting only to the addresses it checked, with no redirects, a 5-second limit and at most 10 KB. It resolves the host with its own DNS resolver, cancelled at that limit, rather than the system's `getaddrinfo`, so names that never resolve cannot stall the gateway's other lookups, and it loads at most 16 uncached documents at once, refusing more as busy. The document must name its own URL as `client_id`, be a public client (`token_endpoint_auth_method` `none`), and list only redirects `DESK_REDIRECTS` already allows. It is cached for its `Cache-Control` max-age, clamped to between 5 minutes and 24 hours, at most 500 at a time, the least recently used going first. The consent page shows the document URL's host above the name the document gives. A client that sends `resource` must name `<DESK_PUBLIC_URL>/mcp`; tokens carry that audience, and tokens issued before the audience existed are accepted until they expire. The metadata lists `offline_access`, which ChatGPT needs before it asks for refresh tokens; every client gets one regardless.
- **A clone.** At start it makes a partial clone (`--filter=blob:none`) of the desk repository (`arimendelow/desk`) on the container's own disk. Every Desk child works in that clone and commits and pushes through Desk's own write protocol. On SIGTERM the gateway refuses new sessions, stops every Desk child (SIGKILL after 10 s), runs Desk's own push for up to 60 s so no committed write is left only in the clone, and then exits. Any commit still unpushed is logged by SHA as `DESK WRITES NOT PUSHED`. The image runs the gateway under tini, which reaps Desk's detached workers, and the Container App allows 90 s for shutdown.
- **Git credentials.** Git and `gh` get short-lived installation tokens for the one desk repository from a Unix socket that only the gateway serves (`bin/git-credential-desk.js`, `bin/gh`). The App's key never enters a Desk child's environment, and no token is stored in the environment, `.git/config` or on disk.

## What hosted Desk cannot do

Some Desk tools, doctor repairs and skills need a shell, the host machine or a coding harness. Desk refuses them when hosted, each with its reason, from one checked-in list in Desk: `plugins/desk/mcp/src/runtime/hosted.js` (the hosted list). Desk's MCP `instructions` name the same list for the agent. Change that list in Desk, not here.

## Connect from claude.ai

1. In claude.ai, install the Desk plugin and its dependencies (superpowers, plain-language) from the ourostack marketplace.
2. Open **Settings → Connectors → Add custom connector** and enter `https://desk.ouro.bot/mcp`. Leave the OAuth client fields empty; Claude registers itself.
3. Connect, approve on the Hosted Desk consent page, then sign in with GitHub as an allowed login (`arimendelow`).
4. Start a chat. Desk's instructions tell the agent to call `desk_status` first.

## Environment

| Variable | Meaning |
| --- | --- |
| `DESK_SIGNING_KEY` | Required. Signs every OAuth client id, code and token. Changing it signs every client out. |
| `DESK_PUBLIC_URL` | The gateway's public origin, which sets the OAuth issuer, the MCP resource (`<url>/mcp`) and the GitHub callback (`<url>/oauth/github/callback`). Default `https://desk.ouro.bot`; a test deploy uses the Container App's Azure address. |
| `DESK_APP_ID`, `DESK_APP_CLIENT_ID`, `DESK_APP_CLIENT_SECRET` | The GitHub App's id and OAuth client. |
| `DESK_APP_KEY_FILE` | Path to the GitHub App's private key (a mounted secret). |
| `DESK_REPO` | The desk repository. Default `arimendelow/desk`. |
| `DESK_ALLOWED_LOGINS` | Comma-separated GitHub logins allowed to sign in. Default `arimendelow`. |
| `DESK_REDIRECTS` | Comma-separated exact redirect URLs a client may register or name, each an `https` (or loopback `http`) URL written as a URL parser writes it (lower-case host, no default port), with no fragment or user info; the gateway refuses to start otherwise. Unset, the default is `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,https://vscode.dev/redirect,https://insiders.vscode.dev/redirect` (Claude's callbacks and VS Code's, which VS Code registers alongside its loopback ones). Setting it replaces the whole default, so copy every entry you still want; without claude.ai's callback, Ari's claude.ai connector stops working at its next request. The gateway logs the allowlist in force at start and warns when claude.ai's callback is missing. Loopback (`http://localhost` and `http://127.0.0.1` on any port) and ChatGPT's per-connector callback (`https://chatgpt.com/connector/oauth/<one segment of letters, digits, - and _>`) are always allowed. Every client's redirects are checked again on each use, so removing one shuts out clients that registered it before. |
| `DESK_CLONE_DIR` | Where the desk is cloned. The image sets `/data/desk`. |
| `DESK_PLUGIN_DIR` | Desk's plugin directory. The image sets `/app/plugins/desk`. |
| `DESK_REAL_GH` | Optional path to the real `gh`. By default the shim uses the next `gh` on `PATH`; the image installs it at `/usr/bin/gh`. |
| `PORT` | Listening port. Default `8080`. |

Until the GitHub App exists, its four settings hold the placeholder `unset`. The gateway then serves `/healthz` and refuses sign-in with "Hosted Desk is not set up yet: its GitHub App is missing."

## Run the tests

```sh
cd hosted
npm ci
npm test
```

The end-to-end test (`test/e2e.test.js`) runs the real gateway with the real Desk plugin against a scratch desk, with no network. It is skipped unless `DESK_E2E=1`, and it needs Desk's dependencies installed:

```sh
(cd plugins/desk/mcp && npm ci)
cd hosted && DESK_E2E=1 npm test
```

The workflow `.github/workflows/hosted-tests.yml` runs every test, the end-to-end test included, on each pull request and push that touches `hosted/`.

## Build the image

The image (`hosted/Dockerfile`) needs both Desk's plugin and the gateway, so build it from the repository root:

```sh
docker build -f hosted/Dockerfile -t ouro-desk-hosted .
```

The root `.dockerignore` limits the build context to `plugins/desk` and `hosted`, without installed dependencies.

## Set up on Azure

Do these once, in order. They run on a machine signed in to `az` with write access to resource group `rg-ouro-work-substrate`.

1. **Provision.** `hosted/infra/provision.sh` creates the Container App `ouro-desk-hosted` and its secrets (the App's as `unset`), mounts the App key, adds the deploy workflow's federated credential, and prints the repository variables to set. It is safe to run again and never overwrites a secret's value. Run it with `DRY_RUN=1` first to see every change it would make. Until `desk.ouro.bot` exists, run it with `DESK_PUBLIC_URL=https://<the app's Azure address>`.
2. **Set the repository variables** it prints (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DESK_PUBLIC_URL`) on `ourostack/desk`.
3. **Create the GitHub App.** Run `node hosted/infra/create-github-app.mjs --public-url <DESK_PUBLIC_URL>` and open `http://127.0.0.1:8787/` in a browser signed in to GitHub as an ourostack owner. Confirm on GitHub. The script stores the App's credentials in the Container App without printing them and prints the App's install URL.
4. **Install the App** on `arimendelow/desk` only, from that URL. The script waits for the installation, restarts the app's revision so the gateway picks up the credentials, and exits.
5. **Add DNS.** At ouro.bot's DNS (Cloudflare, DNS only), add the `CNAME` and `asuid` `TXT` records that `provision.sh` prints, then run `provision.sh` again to bind `desk.ouro.bot` with a managed certificate. This rerun keeps the app's current public URL.

Run the first provision from a checkout of released `main`, because it builds the first image from the local `HEAD`.

### Move to desk.ouro.bot

A rerun of `provision.sh` keeps the app's current `DESK_PUBLIC_URL` unless one is passed, so a reconcile never moves the live OAuth issuer. Once `desk.ouro.bot` is bound with its certificate, cut over in this order:

1. Run `DESK_PUBLIC_URL=https://desk.ouro.bot hosted/infra/provision.sh`. The issuer, the MCP resource and the GitHub callback move to `desk.ouro.bot`.
2. Set the `DESK_PUBLIC_URL` repository variable to `https://desk.ouro.bot`, so the deploy's health check follows.
3. In claude.ai, remove the connector and add `https://desk.ouro.bot/mcp` again, so Claude registers and signs in against the new issuer.

The GitHub App needs no change: its callbacks already list both the Azure address and `desk.ouro.bot`.

## Deploy

Hosted Desk serves only released Desk. `.github/workflows/hosted-deploy.yml` runs after each successful "Desk release" run and by hand (`workflow_dispatch` on main). Either way it deploys the newest `Release Desk` commit on main, not main's head, so a gateway change ships with the next Desk release. As a check it refuses a commit whose `plugins/desk/changelog.d/` holds a fragment no release has carried (anything but `README.md`). It builds the image with `az acr build`, tagged with the commit SHA, points the app at it, waits for the new revision and fails unless `/healthz` answers 200.
