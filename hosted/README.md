# Hosted Desk gateway

The hosted Desk gateway lets claude.ai use Desk as a remote MCP server at `https://desk.ouro.bot/mcp`. It is a thin HTTP front for Desk's own MCP server: for each Claude session it starts Desk's unchanged stdio server (`node plugins/desk/mcp/index.js --root <clone>`) with `DESK_HOSTED=1` and relays JSON-RPC bytes both ways. It never parses, edits or adds to Desk's messages, and it never reimplements a Desk behavior; anything Desk must do differently for a remote client lives in Desk behind `DESK_HOSTED`.

The gateway adds only what a remote host needs:

- **An HTTP endpoint.** Streamable HTTP MCP at `/mcp`, plus `/healthz` (the Container App's startup and liveness probe) and `/healthz/deep`, which answers 200 `ok` only when the Ouro tenant's discovery document has loaded with the expected issuer, the accounts store answers a read, and `DESK_GITHUB_ACCOUNTS` names at least one account and every account it names exists, and otherwise 503 with the failing check names (`discovery`, `store`, `legacy-account`) and nothing else. Its result is cached for 10 s. Without the Ouro tenant it answers `ok`. It is never a probe, so a store or ciamlogin.com outage never restarts the gateway.
- **Sign-in.** It is the OAuth authorization server MCP clients talk to (dynamic client registration, client metadata documents, PKCE, rotating refresh tokens), and it signs users in with the "Ouro Desk" GitHub App. Before sending the browser to GitHub, it shows a consent page that names the client and the host its sign-in will be sent to, and continues only when the person approves. Without the Ouro tenant configured, it signs in with GitHub and admits only the logins in `DESK_ALLOWED_LOGINS`. With it, people sign in through the Ouro tenant (Apple or an email code), their tokens belong to an Ouro account and can't be refreshed more than 30 days after that sign-in, Ari's tokens from before stay valid until `DESK_LEGACY_CUTOFF`, and a GitHub fallback for mapped accounts only is on while `DESK_GITHUB_SIGNIN=on`.
- **Clients.** A client registers itself, or uses the https URL of its client metadata document as its client id (claude.ai's "Use Claude's published identity"). The gateway fetches a document only over port 443, never from its own host, and only from a host whose every address is public (Azure's platform address 168.63.129.16 counts as private), connecting only to the addresses it checked, with no redirects, a 5-second limit and at most 10 KB. It resolves the host with its own DNS resolver, cancelled at that limit, rather than the system's `getaddrinfo`, so names that never resolve cannot stall the gateway's other lookups, and it loads at most 16 uncached documents at once, refusing more as busy. The document must name its own URL as `client_id`, be a public client (`token_endpoint_auth_method` `none`), and list only redirects `DESK_REDIRECTS` already allows. It is cached for its `Cache-Control` max-age, clamped to between 5 minutes and 24 hours, at most 500 at a time, the least recently used going first. If a refetch fails in transit (busy, timeout, DNS, connection or HTTP status), the last accepted document is served for up to 24 hours after it was fetched; a document that is fetched and refused is dropped at once. The consent page shows the document URL's host above the name the document gives. A client that sends `resource` must name `<DESK_PUBLIC_URL>/mcp`; tokens carry that audience, and tokens issued before the audience existed are accepted until they expire. The metadata lists `offline_access`, which ChatGPT needs before it asks for refresh tokens; every client gets one regardless.
- **A clone.** At start it makes a partial clone (`--filter=blob:none`) of the desk repository (`arimendelow/desk`) on the container's own disk. Every Desk child works in that clone and commits and pushes through Desk's own write protocol. On SIGTERM the gateway refuses new sessions, stops every Desk child (SIGKILL after 10 s), runs Desk's own push for up to 60 s so no committed write is left only in the clone, and then exits. Any commit still unpushed is logged by SHA as `DESK WRITES NOT PUSHED`. The image runs the gateway under tini, which reaps Desk's detached workers, and the Container App allows 90 s for shutdown.
- **Git credentials.** Git and `gh` get short-lived installation tokens for the one desk repository from a Unix socket that only the gateway serves (`bin/git-credential-desk.js`, `bin/gh`). The App's key never enters a Desk child's environment, and no token is stored in the environment, `.git/config` or on disk.

## What hosted Desk cannot do

Some Desk tools, doctor repairs and skills need a shell, the host machine or a coding harness. Desk refuses them when hosted, each with its reason, from one checked-in list in Desk: `plugins/desk/mcp/src/runtime/hosted.js` (the hosted list). Desk's MCP `instructions` name the same list for the agent. Change that list in Desk, not here.

## Connect from claude.ai

1. In claude.ai, install the Desk plugin and its dependencies (superpowers, plain-language) from the ourostack marketplace.
2. Open **Customize → Connectors → Add custom connector** and enter `https://desk.ouro.bot/mcp`. Leave the OAuth client fields empty; Claude registers itself.
3. Connect and approve on the Hosted Desk consent page. With Ouro sign-in on, choose **Continue with Apple or email** and sign in through the Ouro tenant. A new person first opens their invite link in the same browser, so the sign-in can redeem it. Ari can also choose **Continue with GitHub** while `DESK_GITHUB_SIGNIN=on`. Without Ouro sign-in, sign in with GitHub as an allowed login (`arimendelow`).
4. Start a chat. Desk's instructions tell the agent to call `desk_status` first.

## Branding

The consent, invitation and sign-in refusal pages share the approved transparent Desk render at `/assets/desk-logo.png` and the silhouette favicon at `/favicon.svg`. Both are public, fixed files under `hosted/public`; authentication pages stay uncached and refuse framing. The PNG is a lossless conversion of the approved 256px WebP, and the SVG is the approved single-colour silhouette. Replace assets only from an approved logo handoff, not a redraw.

The gateway derives `DESK_MCP_ICON_URL` for each Desk child from `DESK_PUBLIC_URL`. The native Desk front door advertises it in `serverInfo.icons` for protocols from `2025-11-25` onward. Local sessions, hosted sessions without that setting and older protocols retain their existing metadata; the gateway does not rewrite MCP messages.

## Environment

| Variable | Meaning |
| --- | --- |
| `DESK_SIGNING_KEY` | Required. Signs every OAuth code and token, and, while `DESK_CLIENT_KEY` is unset, every client id. Any whitespace in it stops the gateway at start. The gateway logs each key's fingerprint at start, never the key: `keys: signing <fp> client <fp> client-from <DESK_CLIENT_KEY or DESK_SIGNING_KEY> previous <fp until <time>, or none> revision <revision>`, followed by `entra <fp>`, the Entra client secret's fingerprint, when the Ouro tenant is set. |
| `DESK_SIGNING_KEY_PREVIOUS`, `DESK_SIGNING_KEY_PREVIOUS_UNTIL` | After a signing-key rotation, the old key and the ISO time until which tokens sealed with it are still accepted (30 days after the rotation), so a rotation signs nobody out. The previous key needs both the time and an explicit `DESK_CLIENT_KEY`, or the gateway refuses to start. |
| `DESK_CLIENT_KEY` | Seals client ids and derives client secrets, kept apart from the signing key so a signing-key rotation leaves every registered client working. Unset, the gateway uses `DESK_SIGNING_KEY`, which is how client ids were sealed before; set it to a byte-exact copy of that key before the first rotation. Changing it makes every client register again. |
| `DESK_PUBLIC_URL` | The gateway's public origin, which sets the OAuth issuer, the MCP resource (`<url>/mcp`) and the GitHub callback (`<url>/oauth/github/callback`). Default `https://desk.ouro.bot`; a test deploy uses the Container App's Azure address. |
| `DESK_APP_ID`, `DESK_APP_CLIENT_ID`, `DESK_APP_CLIENT_SECRET` | The GitHub App's id and OAuth client. |
| `DESK_APP_KEY_FILE` | Path to the GitHub App's private key (a mounted secret). |
| `DESK_REPO` | The desk repository. Default `arimendelow/desk`. |
| `DESK_ALLOWED_LOGINS` | Without the Ouro tenant: comma-separated GitHub logins allowed to sign in. Default `arimendelow`. With the Ouro tenant it is ignored (the gateway logs one line saying so), but stays set until the legacy cutoff so a rollback to the previous image still admits Ari. |
| `DESK_ENTRA_TENANT_ID`, `DESK_ENTRA_SUBDOMAIN`, `DESK_ENTRA_CLIENT_ID`, `DESK_ENTRA_CLIENT_SECRET` | The Ouro tenant (Microsoft Entra External ID) people sign in through: its id (a GUID), its `ciamlogin.com` subdomain, and the gateway app's client id and secret (a Key Vault reference; whitespace in it stops the gateway at start). Its callback is `<DESK_PUBLIC_URL>/oauth/entra/callback`. Set together with `DESK_ACCOUNTS_ENDPOINT`; with none of these, the gateway signs in with GitHub for `DESK_ALLOWED_LOGINS` as before, and any partial set stops it at start. At start the gateway fetches the tenant's discovery document, waiting at most 10 s: a document naming another issuer stops it; one it can't fetch is retried every 30 s while the legacy and GitHub paths serve and Ouro sign-in shows "try again shortly". |
| `DESK_ACCOUNTS_ENDPOINT`, `AZURE_CLIENT_ID` | The accounts store's Table endpoint (`https://<account>.table.core.windows.net`) and the client id of the user-assigned identity the gateway reads it as. Every code exchange, refresh and MCP request checks the account (rows cached at most 60 s; when the store can't answer and the row is older, the request gets `server_error`), and every 60 s the gateway closes all sessions of any account whose Desk access is off. |
| `DESK_GITHUB_SIGNIN` | `on` turns on the GitHub fallback (a second button on the consent page); `off` or unset turns it off, and the GitHub callback then refuses. It admits only the GitHub user ids in `DESK_GITHUB_ACCOUNTS`. |
| `DESK_GITHUB_ACCOUNTS`, `DESK_GITHUB_LOGINS` | `<GitHub user id>=<accountId>` and `<GitHub user id>=<login>`, comma-separated, naming the same ids (from `identity-<env>.json`). The GitHub fallback admits these ids; a legacy token (sealed before Ouro accounts) maps to the account only when both its login (in any case) and its user id match. With the Ouro tenant on, an empty mapping logs `LEGACY ACCOUNT MAPPING EMPTY` at start and fails `/healthz/deep`. At start the gateway reads each account once and logs `LEGACY ACCOUNT MISSING <accountId>` for any that doesn't exist. |
| `DESK_LEGACY_CUTOFF` | ISO time after which legacy tokens, and every token refreshed from them, are refused. Set once, 14 days after the release is confirmed live; unset, legacy tokens keep working. Tokens from an Ouro or GitHub-fallback sign-in can't be refreshed more than 30 days after that sign-in, whatever the cutoff. |
| `DESK_REDIRECTS` | Comma-separated exact redirect URLs a client may register or name, each an `https` (or loopback `http`) URL written as a URL parser writes it (lower-case host, no default port), with no fragment or user info; the gateway refuses to start otherwise. Unset, the default is `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,https://vscode.dev/redirect,https://insiders.vscode.dev/redirect` (Claude's callbacks and VS Code's, which VS Code registers alongside its loopback ones). Setting it replaces the whole default, so copy every entry you still want; without claude.ai's callback, Ari's claude.ai connector stops working at its next request. The gateway logs the allowlist in force at start and warns when claude.ai's callback is missing. Set it with `DESK_REDIRECTS=<url>,<url> hosted/infra/provision.sh`; a rerun without it keeps the app's current value, and passing it empty returns to the default. Loopback (`http://localhost` and `http://127.0.0.1` on any port) and ChatGPT's per-connector callback (`https://chatgpt.com/connector/oauth/<one segment of letters, digits, - and _>`) are always allowed. Every client's redirects are checked again on each use, so removing one shuts out clients that registered it before. |
| `DESK_CLONE_DIR` | Where the desk is cloned. The image sets `/data/desk`. |
| `DESK_MULTI_USER` | Experimental owning-UID runtime gate. Unset or `0` preserves the legacy shared clone; only `1` enables account-keyed realms. Other values fail startup. Leave off until complete v1b-2 staging/P3 qualification. Requires Ouro identity and the Linux image entrypoint's kernel boundary; never falls back to legacy execution. |
| `DESK_PLUGIN_DIR` | Desk's plugin directory. The image sets `/app/plugins/desk`. |
| `DESK_REAL_GH` | Optional path to the real `gh`. By default the shim uses the next `gh` on `PATH`; the image installs it at `/usr/bin/gh`. |
| `PORT` | Listening port. Default `8080`. |

Until the GitHub App exists, its four settings hold the placeholder `unset`. The gateway then serves `/healthz` and refuses sign-in with "Hosted Desk is not set up yet: its GitHub App is missing."

### Gated account runtime

`createAccountRuntime({ config, store, mint, baseEnv?, rootDir? })` returns
`{ prepare(accountId), close() }`. `rootDir` defaults to `/data/realms`; its
existing ancestors must be protected directories. `mint(repo)` receives only
the repository verified from the account's committed binding, never HTTP client
input. Existing admission remains unchanged: the binding must name `DESK_REPO`.
Repository selection, account administration, capacity policy and initialization
are separate later units.

`await prepare(accountId)` returns a frozen
`{ realm: { uid, gid, root }, env, launch(args), git(args), push(), close(), purge() }`.
Preparation deduplicates concurrent callers, rechecks account access and freezes
repository/installation/author authority for that manager. UID reservations
survive preparation failures and manager replacement within the process.
`launch` returns a relay-compatible service handle whose `kill("SIGTERM"|"SIGKILL")`
uses an inherited owning-UID supervisor channel, not a gateway PID signal.
`git` rejects private cwd/repository overrides. `close` stops owned children,
runs Desk's own sync lock/rebase/push loop, and only then closes its private token
broker. Push/count failures reject shutdown and retain the broker rather than
reporting a successful loss of writes. `purge` first closes successfully, then
deletes that UID's contents; its 0700 root/UID tombstone remains reserved.

Only realm children receive `DESK_ISOLATED_HOSTED=1`; ordinary local sessions
and legacy `DESK_HOSTED=1` retain their existing subprocess contracts. The
built-in Git callers use `deskGitInvocation({root,args,env})`: private mode
validates the root's real containment within `env.DESK`, including symlinks,
then uses cwd instead of `git -C <root>`. Git's `diff-tree --root` flag is
unchanged. Private triage candidate worktrees live below `.git/desk-triage`,
with desk-relative Git operands; protected operation records stay in the
realm's factory state.

Private triage also keeps Git's hook descendants private. Realm environments
provide `DESK_PRIVATE_HOOKS_DIR`, a fixed public, read-only dispatcher directory.
Git invokes those public entrypoints; they execute the original configured
hooks through relative filenames, forwarding stdin, arguments and exit status.
Original configured hook policy is still fingerprinted before/after commit;
the ephemeral public routing override remains effective inside original hooks
so ordinary nested Git mutations also execute the original hooks privately.
No persisted configuration is changed. The outer commit keeps its message-file
arguments relative. During that commit, the owned candidate's `.git` gitfile is
held outside its worktree and replaced by a directory link to the same validated
private administrative directory. Git discovery through this link retains a
relative `.git/COMMIT_EDITMSG` operand even for a guarded nested commit.
The exact gitfile is restored after the bounded commit, also before recovery
removes an interrupted candidate; foreign replacement metadata is retained,
not overwritten. Original hooks use normal Git discovery within the same
linked worktree, without a forced `GIT_DIR` or `GIT_WORK_TREE`; subdirectory Git
calls therefore work too. The private context marker and normalized index
context stay in environment, never argv.
No executable hook or triage operation is disabled by this transport.

Sync workers/session sync and shared remote/ahead-behind readers use their
supplied environment for both context selection and actual Git children,
including when it differs from the ambient process environment.

Detached sync and identity-refresh scripts read their root from `DESK`.
Their admitted source-mirror filename also travels in environment
(`DESK_BUILTIN_SCRIPT`), through a fixed Node module loader, never argv.
Readiness-controller and status-inspection forks use the same private loader,
retaining their IPC channel and serialization. The controller's guarded entry
recognizes only its matching admitted script URL in private mode; an ordinary
module import does not start a controller.
Explicit script `--root` remains supported for local callers. Automatic
host-package upgrades and product issue filing are unavailable in the private
customer context and return an explicit unavailable/not-filed reason before
spawning or claiming host-side work.

MCP services also run below an owning-UID `tini -s` and a retained worker-session
leader. The service handle's stdout/stderr bytes and protocol close are relayed
in order over inherited IPC; protocol EOF is not a synthetic guardian exit.
Natural MCP exit and individual session signals leave the guardian tracked
while descendants remain. In particular, closing one session does not signal
the group containing readiness/sync activity another session may still use.
Realm close retires all of its service groups, then positively confirms each
guardian's quiescence before final push or broker close. Detached writers may
finish within the five-second retirement watchdog; an escaped writer that
cannot retire in time fails closed instead of being blindly PID-signalled.
The service-close boundary retains its existing ten-second deadline. Failed,
missing or malformed retirement proof is sticky preservation, even if the MCP
protocol already ended or descendants eventually finish later.

Service output uses end-to-end credit: at most one 16 KiB frame per stdout/
stderr stream is outstanding across the two IPC hops. The worker reads again
only after the gateway's bounded stream accepts/drains that frame. The helper
validates frame size/order and credit; it never pauses the shared IPC channel,
so termination and retirement control remain deliverable under output pressure.
Normal protocol close waits for both output streams to drain and finish.
Malformed/excess output, pipe failure or unproved guardian disconnect instead
ends the protocol with an explicit preservation error, without fabricating a
guardian exit. The runtime retains the real guardian and sticky recovery state;
relay shutdown can reach that rejection rather than wait indefinitely. Forced
session cancellation can also terminate pressured protocol output with this
explicit preservation outcome. Kernel retirement is still proved separately.

Gateway filesystem/Git jobs use a dedicated owning-UID `tini -s` subreaper and
a fresh worker session. A worker's result or exit is not retirement proof:
completion requires the worker and all its descendants, including reparented
detached children, to be gone. The existing 60-second operation deadline is
unchanged; cancellation signals the fresh process group only while its exact
ChildProcess leader is still owned and unreaped. No CAP_KILL or blind PID
cleanup is used. A separate five-second retirement watchdog does not extend
the work deadline.

If retirement cannot be proved, `DESK_OPERATION_UNQUIESCENT` puts the account
in sticky failed-preservation state. Its broker/private root remain intact;
new preparation and destructive cleanup are refused, and manager shutdown
rejects even when that account's preparation never returned a prepared object.
A proved-retired timeout reports `DESK_OPERATION_TIMEOUT` with `quiescent:true`
and permits safe cleanup/retry or a subsequent final push. Neither rejection
is silently discarded as an ordinary completed operation.
The final ahead-count is checked again after the push job's descendants retire,
within the existing push budget. A hook-produced write omitted from the earlier
count rejects close and retains the broker rather than producing a success
based on stale Git state.

The root entrypoint drops into UID 1000 **before tini**. Enabled gateway/tini
have exactly chown/setgid/setuid and NoNewPrivs; each desk helper/child has no
active capabilities and NoNewPrivs. Disabled gateway/tini and children retain
none of those capabilities. Realm roots are opaque 0700 directories under a
711 common parent; writable HOME/TMP/XDG/config/clone all belong to their UID.
App key files (and any Azure federated-token file) must be regular, gateway-UID
owned, inaccessible to group/other, with protected non-symlink ancestors.
Unsafe mounts fail startup; the runtime does not chmod mounted secrets wider.

Gateway Git uses the private `desk::origin` transport. Its real HTTPS helper
receives only a fixed public alias, with the verified repository in private Git
configuration, not argv. `GH_REPO` preserves gh's binding-derived repository
default. The token socket remains 0600 in its UID's private realm and is ready
before any clone operation. This milestone does **not** claim that Desk's
internal detached workers, problem filer, or all internal Git/root arguments
have completed v1b-2 qualification.

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

The accounts store's tests also run against Azurite, the local Azure Storage emulator, when `DESK_AZURITE=1`. Without it, that half is skipped. Start Azurite in another terminal first; with `DESK_AZURITE=1` and no Azurite answering, the run fails rather than skipping:

```sh
cd hosted
npx azurite-table --inMemoryPersistence --tableHost 127.0.0.1 --tablePort 10002
DESK_AZURITE=1 npm test
```

Set `DESK_AZURITE_ENDPOINT` if Azurite listens somewhere other than `http://127.0.0.1:10002/devstoreaccount1`.

The workflow `.github/workflows/hosted-tests.yml` runs every test, the end-to-end and Azurite tests included, on each pull request and push to main that touches `hosted/`, `plugins/desk/mcp/`, or the `hosted-tests.yml`, `hosted-deploy.yml` or `identity-checks.yml` workflows.

The owning-UID fixture is a **native Linux** gate, not a cloud or credential
test. First build the actual `hosted/Dockerfile` production image as
`desk-hosted-native:production`, including its real compiled native dependencies.
Then build `hosted/test/fixtures/runtime-native.Dockerfile` using a separate
small context containing it as `Dockerfile` and `runtime-native.js`,
`runtime-child.js`, `runtime-timeout-native.js`, `runtime-service-native.js`.
The overlay is COPY-only and inherits the production entrypoint; it does not
install or replace any dependency. A separate context is necessary because
the production root `.dockerignore` excludes `hosted/test`.
Create an exact-owned container with `--network none`, `--cap-drop ALL` and
only `CHOWN`, `SETUID`, `SETGID` added, with `DESK_MULTI_USER=1`, command
`node /app/hosted/test/fixtures/runtime-native.js`. It uses a synthetic loopback
Git HTTP origin and verifies kernel/UID/cwd/socket/argv/signal boundaries,
concurrent preparation/retry, immutable authority and shutdown preservation.
No host credentials or credential directories should be mounted.
Adding `DESK_NATIVE_TIMEOUTS=1` and copying `runtime-timeout-native.js` into the
same fixture directory runs the bounded real-deadline regression: an actual
65-second Git pre-commit hook, normal delayed HTTP fetch, and detached delayed
Git fetch. It checks close **after** timeout rejection, cleanup only after
quiescence, and retained failed-preparation state when descendants remain.
These cases exercise the actual 60-second deadline, not a shorter test-only
timeout; they run concurrently within a 100-second fixture bound.

In this production fixture overlay, `DESK_NATIVE_SERVICES=1` selects actual
MCP SDK initialize/status/save/reindex/
search, native SQLite inspection, automatic Git sync, natural protocol EOF,
explicit termination, same-realm concurrent sessions and a neighboring realm.
An actual MCP-triggered Git hook starts a detached writer with ignored stdio;
successful realm close must preserve its commit on the loopback origin.
Adding `DESK_SERVICE_UNPROVEN=1` instead checks the real five-second retirement
failure, retained broker/root and sticky repeated refusal while the escaped
writer finishes later. These service cases have a 180-second outer fixture
guard; production operation/push/retirement budgets are unchanged. They use
arbitrary kernel UIDs absent from passwd, not fixture NSS entries or native
dependency substitutes. This is two-realm single-configured-repository
qualification, not multirepository admission or cloud deployment qualification.

The existing `.github/workflows/hosted-tests.yml` also maintains a separate
native Linux/amd64 job on `ubuntu-latest`, alongside the unchanged gateway
E2E/Azurite job. It builds the production image once, adds this small fixture
overlay, then runs service success, sticky service preservation and the
**unchanged** `DESK_NATIVE_TIMEOUTS=1` I1 fixture sequentially. Each container
has two CPUs and 4 GiB of memory; this is a consuming boundary, not a
twelve-session capacity qualification. Any case or evidence-collection failure
makes the job fail; later cases still produce diagnostic evidence. An always-run
artifact step retains the exact checkout/tree and hashes, image IDs/metadata,
runner kernel/architecture, actual fixture kernel/native-source observations,
separate stdout/stderr, exit status, container configuration/state and synthetic
realm filesystem archives. The twenty-minute outer job allowance covers builds
and all three cases; it does not change production deadlines, I1's 100-second
fixture guard or its 75-second observation. A native I1 failure remains red,
and a later native pass does not relabel an earlier emulated run as passing.

## Build the image

The image (`hosted/Dockerfile`) needs both Desk's plugin and the gateway, so build it from the repository root:

```sh
docker build -f hosted/Dockerfile -t ouro-desk-hosted .
```

The root `.dockerignore` limits the build context to `plugins/desk` and `hosted`, without installed dependencies.

## Set up on Azure

Do these once, in order. They run on a machine signed in to `az` with write access to resource group `rg-ouro-work-substrate`. Ouro sign-in has its own steps, in [Turn on Ouro sign-in](#turn-on-ouro-sign-in).

1. **Provision.** `hosted/infra/provision.sh` creates the Container App `ouro-desk-hosted` and its secrets (the App's as `unset`), mounts the App key, adds the deploy workflow's federated credential, and prints the repository variables to set. It is safe to run again and never overwrites a secret's value. Run it with `DRY_RUN=1` first to see every change it would make. Until `desk.ouro.bot` exists, run it with `DESK_PUBLIC_URL=https://<the app's Azure address>`.
2. **Set the repository variables** it prints (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `DESK_PUBLIC_URL`) on `ourostack/desk`.
3. **Create the GitHub App.** Do not run `create-github-app.mjs` again until it is fixed: it passes the App's secrets to `az containerapp secret set` as arguments, where any process on the machine can read them. The fix is planned for v1b-2. The App already exists for `desk.ouro.bot`, so only a fresh setup needs this step. Once fixed, run `node hosted/infra/create-github-app.mjs --public-url <DESK_PUBLIC_URL>` and open `http://127.0.0.1:8787/` in a browser signed in to GitHub as an ourostack owner. Confirm on GitHub. The script stores the App's credentials in the Container App without printing them and prints the App's install URL.
4. **Install the App** on `arimendelow/desk` only, from that URL. The script waits for the installation, restarts the app's revision so the gateway picks up the credentials, and exits.
5. **Add DNS.** At ouro.bot's DNS (Cloudflare, DNS only), add the `CNAME` and `asuid` `TXT` records that `provision.sh` prints, then run `provision.sh` again to bind `desk.ouro.bot` with a managed certificate. This rerun keeps the app's current public URL.

Run the first provision from a checkout of released `main`, because it builds the first image from the local `HEAD`.

### Move to desk.ouro.bot

A rerun of `provision.sh` keeps the app's current `DESK_PUBLIC_URL` unless one is passed, so a reconcile never moves the live OAuth issuer. Once `desk.ouro.bot` is bound with its certificate, cut over in this order:

1. Run `DESK_PUBLIC_URL=https://desk.ouro.bot hosted/infra/provision.sh`. The issuer, the MCP resource and the GitHub callback move to `desk.ouro.bot`.
2. Set the `DESK_PUBLIC_URL` repository variable to `https://desk.ouro.bot`, so the deploy's health check follows.
3. In claude.ai, remove the connector and add `https://desk.ouro.bot/mcp` again, so Claude registers and signs in against the new issuer.

The GitHub App needs no change: its callbacks already list both the Azure address and `desk.ouro.bot`.

### Turn on Ouro sign-in

Do this for the test tenant and staging first (`--env test`, `STAGE=staging`), then for production (`--env prod`). [Ouro identity](#ouro-identity) describes each piece. Every step is safe to run again.

1. **Sign `az` in** to the subscription and to the env's Ouro tenant, as [az sign-ins](#az-sign-ins) says. Run the scripts on a Mac: the admin app's secret lives in the macOS keychain.
2. **Record the Apple facts** in `hosted/infra/identity-<env>.json`: `apple.developerId` (Apple's Team ID) and `apple.outcome`, `"A"` if Graph can renew the Apple provider or `"B"` if only the admin center can. Leave `apple.outcome` as `null` until it is known; the checks then behave as under outcome B.
3. **Import both Apple keys**, slot `a` and slot `b`, as [Import an Apple key](#import-an-apple-key) says. Under outcome B, add `--keep-file` to slot `a`'s import, because Ari uploads that file in step 5. A key put in Key Vault any other way has no `key-id` or `fingerprint` tag, so provisioning and the renewal refuse to send it. The 2026-10-11 spike imported all four keys with `az keyvault secret set --file` (tags `keyId` and `teamId` only), so import each of them again with this command, from the `.p8` files the spike kept, before the first renewal. Pass `--keep-file` on each of these four imports: the plan keeps those files until Task 9 confirms outcome A (spike.md, Step 4), and Apple lets each key be downloaded only once, while an import without `--keep-file` deletes the file.
4. **Provision the tenant.** Run `node hosted/infra/provision-identity.mjs --env <env> --dry-run` and read what it would change. Then run it without `--dry-run`. It creates or reconciles every piece, writes the gateway's client secret to Key Vault without printing it, and records every id in `identity-<env>.json`. It first creates or adopts the admin app `ouro-identity-admin`, grants it its Graph roles, and keeps its secret in your keychain ([az sign-ins](#az-sign-ins)); until that app can sign in, a dry run plans the email code, the Apple provider and the user flow as missing. An Apple provider or user flow that already exists is adopted, never made again: the spike made both tenants' Apple providers and the test tenant's user flow, `Ouro sign-in (test)`. A user flow refuses a new app for about 30 seconds, so linking the gateway app retries for up to three minutes. It stops with exit code 2 when it must wait: while a tenant is still being created, or, under outcome B, at the Apple provider, where it prints the admin-center steps.
5. **Outcome B only: add Apple by hand.** Ari follows the printed steps in the Entra admin center and uploads slot `a`'s file. Then run, in this order:
   1. `node hosted/infra/provision-identity.mjs --env <env>` again, which finishes the user flow and the GitHub environment.
   2. `node hosted/infra/identity-checks.mjs --env <env> --record-apple-upload a --admin-app`, which records the upload date (see [The first upload record](#the-first-upload-record)).
   3. The slot `a` import again, without `--keep-file`. It writes the same key again and deletes the file.
6. **Seed Ari's account.** Run `node hosted/infra/provision-identity.mjs --env <env> --seed-ari`. It gives you `Storage Table Data Contributor` on that env's accounts storage, creates Ari's account bound to his desk (`arimendelow/desk` in production, `arimendelow/desk-rehearsal` in test) and records his `accountId`. An account that exists is left as it is.
7. **Commit `identity-<env>.json`** to the branch that carries this change, or to main through a small pull request once the identity files exist there. The identity checks workflow reads main's copy, so it checks an env only after its file reaches main.
8. **Production only: copy the client key.** Save the v1a image and settings as [Rollback](#rollback) says, then run `node hosted/infra/provision-identity.mjs --env prod --migrate client-key`. It copies `desk-signing-key` byte for byte into `desk-client-key`, sets `DESK_CLIENT_KEY`, and checks the copy against the fingerprint the gateway logs. An image that logs no fingerprints is checked with the legacy probe instead.
9. **Add the settings to the app.** Run `hosted/infra/provision.sh` (`STAGE=staging hosted/infra/provision.sh` for test). Once the record is complete, Ari's `accountId` included, it attaches the gateway identity and sets the Ouro tenant settings, the Key Vault reference for `DESK_ENTRA_CLIENT_SECRET`, `DESK_GITHUB_SIGNIN`, and `DESK_GITHUB_ACCOUNTS` and `DESK_GITHUB_LOGINS` for Ari's GitHub user id. `DESK_GITHUB_SIGNIN` is `on` the first time; after that a rerun keeps the app's value unless you pass `DESK_GITHUB_SIGNIN=on` or `DESK_GITHUB_SIGNIN=off`. Passing it before the record is complete is refused, because the setting alone would leave Ouro sign-in partly configured and the gateway would not start. Until the record is complete, it leaves the Ouro settings as they are. `DESK_ALLOWED_LOGINS` stays. Before it writes, it checks the settings with the gateway's own reader and stops if the gateway would refuse one. After the update, it waits until the app's new revision is the ready one, and fails if the revision doesn't start, so a bad setting can't leave the old revision serving unnoticed.
10. **Deploy, then set the legacy cutoff.** The deploy needs the settings from step 9 ([Deploy](#deploy) says why). Once the release is confirmed live, set `releasedAt` (that time) and `legacyCutoff` (14 days later, an ISO time with its zone) in `identity-prod.json`, run `hosted/infra/provision.sh` to set `DESK_LEGACY_CUTOFF`, and commit the file to main. A rerun never moves the cutoff, because `provision.sh` reads it from the file. `provision.sh` refuses a cutoff or `releasedAt` without a zone, a cutoff that isn't after `releasedAt`, and a new cutoff that is already in the past, because that would end Ari's legacy connector at once. A cutoff the app already holds may be in the past, so reruns after day 14 still work. It also warns when the cutoff is not 13 to 15 days after `releasedAt`.
11. **Invite Ari.** Run `node hosted/infra/provision-identity.mjs --env <env> --invite-ari`. Production's link lasts 24 hours and goes to `~/.ouro/invite-prod.url` (mode 0600), never to the screen. Pass `--browser-context <name>` and set `DESK_CDP_OPENER` to open it in the browser that will connect. Test links last 7 days and are printed.
12. **Outcome A only: renew once.** Run `node hosted/infra/identity-checks.mjs --env <env> --renew-apple --admin-app`, so the Apple client secret has a recorded date at once instead of alerting daily until the next scheduled renewal.

To turn Ouro sign-in off again, run `REMOVE_OURO_SETTINGS=1 hosted/infra/provision.sh` (with `STAGE=staging` for test). It takes every Ouro setting off the app (`DESK_ENTRA_*`, `DESK_ACCOUNTS_ENDPOINT`, `DESK_GITHUB_*`, `DESK_LEGACY_CUTOFF` and `AZURE_CLIENT_ID`), applies no identity record, and leaves secrets, the Key Vault reference and identities in place. The gateway then signs in with GitHub for `DESK_ALLOWED_LOGINS` only, so every Ouro account is shut out until the settings return. It is also the way to clear a partial set of Ouro settings that stops the gateway from starting.

Staging stays apart from production. It has its own gateway identity, `id-ouro-desk-hosted-staging`, which holds `AcrPull` on the registry and data roles only on `entra-client-secret-test` and the test accounts storage. It never holds production's pull identity `ouro-prod-services-mi`, and both scripts refuse a staging app that does. Production's GitHub App secrets reach staging only through `node hosted/infra/provision-identity.mjs --env test --copy-app-secrets`, for a rehearsal. Afterwards, `--env test --clear-app-secrets` writes `unset` over them.

## Deploy

Hosted Desk serves only released Desk. `.github/workflows/hosted-deploy.yml` runs after each successful "Desk release" run and by hand (`workflow_dispatch` on main). Either way it deploys the newest `Release Desk` commit on main, not main's head, so a gateway change ships with the next Desk release. As a check it refuses a commit whose `plugins/desk/changelog.d/` holds a fragment no release has carried (anything but `README.md`). It builds the image with `az acr build`, tagged with the commit SHA, points the app at it, waits for the new revision and fails unless `/healthz` answers 200 and then `/healthz/deep` answers 200 within 5 minutes (a 404, from an image that predates the route, is a notice). A failing deep check fails the workflow but rolls nothing back. Each deploy writes the image it replaced to its run's summary page, which is the target for a [rollback](#rollback).

The first deploy of a release with Ouro sign-in needs the app's Ouro settings in place first ([Turn on Ouro sign-in](#turn-on-ouro-sign-in), step 9). `DESK_GITHUB_ACCOUNTS` and `DESK_GITHUB_LOGINS` must name Ari's GitHub user id. With the Ouro tenant set and an empty mapping, the gateway logs `LEGACY ACCOUNT MAPPING EMPTY`, refuses Ari's legacy connector, and fails `/healthz/deep`, which fails the deploy. Set `DESK_LEGACY_CUTOFF` once the release is confirmed live (step 10). Until then legacy tokens never expire, and the identity checks alert a day after `releasedAt`. A 404 from `/healthz/deep` is only a notice, because an image from before the route can't answer it, so after such a deploy run the legacy probe by hand: `node hosted/infra/mcp-probe.mjs status --name prod-legacy`.

## Ouro identity

People sign in to hosted Desk through an Ouro tenant, a Microsoft Entra External ID directory, with Apple or an email one-time code. Production uses the tenant `ourobot` (`de8841c3-7799-4523-bbad-44f8a2426eaa`). The staging app, `ouro-desk-hosted-staging`, uses the test tenant `ourobottest` (`c12edfb6-c5ab-4bf8-b1d5-1f053311d396`), which stays for later rehearsals.

`hosted/infra/provision-identity.mjs` builds each tenant's pieces and records every non-secret id in `hosted/infra/identity-<env>.json`, where `<env>` is `prod` or `test`. `provision.sh` reads that file and never recomputes an id, Ari's `accountId` or the legacy cutoff. Commit the file to main after every change, because the identity checks workflow reads main's copy.

| Piece | Name | What it does |
| --- | --- | --- |
| Gateway app registration | `ouro-desk-hosted`, in each tenant | The app the gateway signs people in as. Its 12-month client secret lives in Key Vault. |
| User flow | `Ouro sign-in` (prod), `Ouro sign-in (test)` (test) | Offers the email code and Apple to the gateway app. |
| Apple provider | Sign in with Apple | Signs people in with Apple, using one of the tenant's two Apple keys. Graph gives it a GUID id in an external tenant (`apple.providerId` in the record), not B2C's `Apple-Managed-OIDC`, so the scripts find it by its type. |
| Admin app | `ouro-identity-admin`, in each tenant | The scripts call Graph as this app, on your machine, for what `az` can't reach: the Apple provider, the user flow and the email one-time-code policy. `provision-identity.mjs` grants it four Graph application roles, one for each kind of call it makes: `IdentityProvider.ReadWrite.All` (the Apple provider), `EventListener.ReadWrite.All` (the user flow), `Policy.ReadWrite.AuthenticationMethod` (the email code) and `Application.ReadWrite.All` (the user flow's app link and the gateway secret's expiry). The apps the 2026-10-11 spike made in both tenants also hold `IdentityUserFlow.ReadWrite.All`, `Policy.ReadWrite.AuthenticationFlows`, `User.Read.All` and `AuditLog.Read.All`; the script never removes a role, so those stay until someone removes them by hand. Its secret is only in your macOS keychain. |
| Automation app | `ouro-identity-automation`, in each tenant | The identity checks sign in to the tenant as this app, through a federated credential with no secret. It holds Graph's `IdentityProvider.ReadWrite.All` and `Application.Read.All`. |
| Key Vault | `kv-ouro-identity-261e0b`, in resource group `rg-ouro-identity` | Holds the gateway's Entra client secret and the Apple keys, with access granted per secret. It was made with the tenants; the scripts never create it. |
| Accounts store | Storage accounts `stouroaccounts261e0b` (prod) and `stouroacctstest261e0b` (test) | Tables `accounts`, `identities`, `invites` and `bindings`. Shared keys are off, so it is reached only through Entra roles. |
| Gateway identity | `id-ouro-desk-hosted` (prod), `id-ouro-desk-hosted-staging` (staging) | Reads its env's Entra client secret and accounts store. Staging's also pulls staging's images. |
| Checks identity | `id-ouro-identity-checks` | The identity checks' Azure identity, with roles on single secrets, never the whole vault: `Key Vault Secrets User` on each env's `entra-client-secret-<env>`, `apple-siwa-key-a-<env>` and `apple-siwa-key-b-<env>`, `Key Vault Secrets Officer` on `apple-siwa-active-<env>` (the renewal writes it), and `Reader` on both Container Apps. `provision-identity.mjs` grants a secret's role on the first run after the secret exists. |
| GitHub environment | `identity`, on ourostack/desk | Allows deployments from main only, and holds the variables the identity checks workflow reads. |

`node hosted/infra/provision-identity.mjs --env test|prod` takes one action at a time:

| Flags | What it does |
| --- | --- |
| none | Creates or reconciles every piece above. Add `--dry-run` to print every write instead, with secret input shown as `***`. |
| `--apple-key-file <file> --apple-key-slot a\|b`, optionally `--apple-key-id <Key ID>` and `--keep-file` | Imports an Apple key ([Import an Apple key](#import-an-apple-key)). |
| `--seed-ari` | Reconciles, then creates Ari's account and binding and records his `accountId`. |
| `--invite-ari`, optionally `--browser-context <name>` | Issues Ari's invite ([Turn on Ouro sign-in](#turn-on-ouro-sign-in), step 11). |
| `--copy-app-secrets`, `--clear-app-secrets` | Test only. Copies production's four GitHub App secrets to staging, or writes `unset` over staging's copies. |
| `--migrate client-key` | Copies the signing key into the client key, checked by fingerprint. |
| `--rotate signing-key` | Test only in v1b-1. Rotates the signing key with a 30-day overlap ([Rotate the signing key](#rotate-the-signing-key)). |
| `--rotate signing-key --emergency` | For a leaked signing key, in production too: new signing and client keys, no previous key ([If the signing key leaks](#if-the-signing-key-leaks)). |
| `--rotate entra-secret` | Rotates the gateway's Entra client secret, deleting the old credential only once the gateway shows the new one ([Rotate the gateway's Entra client secret](#rotate-the-gateways-entra-client-secret)). |

### az sign-ins

The scripts and runbooks need two `az` sign-ins at once, and each kind of call goes to its own.

- **The Azure subscription** `261e0bf1-934d-41ab-9295-229b0d254418`, in Microsoft's tenant. Key Vault, Container Apps, storage and role assignments go through Azure Resource Manager there, and every such command names `--subscription 261e0bf1-934d-41ab-9295-229b0d254418`. Microsoft Graph is blocked in this tenant by a conditional-access policy (error `AADSTS530084`). Therefore never run `az ad …` there, and never pass `--assignee <name>` or anything else az must look up by name. The scripts use object ids and Resource Manager for this reason. Find an identity's ids with `az identity show` and grant roles with `--assignee-object-id`.
- **The env's Ouro tenant**, for Graph. Run `az login --tenant <tenant id> --allow-no-subscriptions`, then `az account set --subscription <tenant id>` to make it az's current account. When the tenant's admin is a guest whose sign-in can't complete on the tenant's own sign-in page (Ari's `ari@mendelow.me` gets "not in our system"), az still gets the tenant's tokens silently from that account's existing sign-in: `az account get-access-token --tenant <tenant id>` succeeds. Add a tenant-level account for the tenant to `~/.azure/azureProfile.json` instead (a copy of an existing `N/A(tenant level account)` entry with `id` and `tenantId` set to the tenant id and `user.name` set to the admin), back the file up first, and then run `az account set`. `az ad app …` and the Graph parts of both scripts work only while the env's tenant is current. Both scripts check this and refuse to run otherwise. This tenant's Graph is not blocked.
- **The admin app**, for the Graph calls az can't make. az's Graph token is delegated, for the Azure CLI's own app, and has no scope for identity providers, user flows or the email policy; Entra refuses to consent one (`AADSTS65002`, between two Microsoft apps). It does have `Application.ReadWrite.All` and `AppRoleAssignment.ReadWrite.All`, so `provision-identity.mjs` uses it to create `ouro-identity-admin`, grant it its roles, and add a 90-day client secret, which it stores in your macOS keychain as `ouro-identity-admin-<tenant id>` through stdin. The scripts then sign in as that app with client credentials and call Graph themselves; the secret and the token stay in memory. When the secret expires, the next provisioning run adds a new one and replaces the keychain item. `identity-checks.mjs` uses the app when you pass `--admin-app`.

### Identity checks

`.github/workflows/identity-checks.yml` runs `hosted/infra/identity-checks.mjs` every day at 06:00 UTC for both envs, in the `identity` environment, from main only. Each run fails, and opens or comments on one issue labelled `identity-alert`, when any of these checks fails:

- `entra-client-secret`: the gateway's client secret ends more than 30 days from now. The check judges the credential whose keyId is in the `key-id` tag of Key Vault secret `entra-client-secret-<env>`, not the newest one. A missing or stale tag fails the check.
- `apple-secret-age`: the Apple client secret, which lasts six months from the `apple-renewed-at` tag on Key Vault secret `apple-siwa-active-<env>`, ends more than 30 days from now. No recorded date fails, and so does a date more than 5 minutes in the future.
- `legacy-cutoff`, production only: `DESK_LEGACY_CUTOFF` is set on the revision that is serving, the app's latest ready revision, once `releasedAt` in `identity-prod.json` is more than a day old. With no `releasedAt` recorded, it must be set as soon as that revision maps GitHub accounts. The check reads the serving revision rather than the app's template, so a newer revision that never started doesn't count. An app with no ready revision fails the check.

Under Apple outcome A the workflow also renews the Apple client secret, for test on the 1st of each month and for production on the 2nd. The issue holds only check names and dates, because the repository is public. To run the checks by hand, run `gh workflow run "Identity checks" -R ourostack/desk`. To run them locally, sign in as [az sign-ins](#az-sign-ins) says and run `node hosted/infra/identity-checks.mjs --env <env> --admin-app`. Locally, always pass `--admin-app`: your own `az` sign-in can't read the Apple provider, so a renewal, an upload record or `--show-apple-key` fails without it. The workflow doesn't need it, because its `az` sign-in is the automation app.

## Secrets and rotation

Every secret hosted Desk uses is listed here, with where it lives, when it expires and how it rotates. No runbook passes a secret as a command argument, and none prints a production secret. Test-tenant invite links are printed by design: each is a single-use link to the test tenant.

| Secret | Where it lives | Expires | How it rotates |
| --- | --- | --- | --- |
| The gateway's Entra client secret | Key Vault `entra-client-secret-<env>`, tagged `key-id` with its credential's keyId. The app reads it as a Key Vault reference. | 12 months after it was made. The identity checks alert 30 days ahead. | `provision-identity.mjs --rotate entra-secret` ([Rotate the gateway's Entra client secret](#rotate-the-gateways-entra-client-secret)). |
| The Apple keys (.p8) | Key Vault `apple-siwa-key-a-<env>` and `apple-siwa-key-b-<env>`, two per tenant's App ID (`bot.ouro.identity` for prod, `bot.ouro.identity.testapp` for test). Key Vault holds the only copies. | Never. | Revoke a key and import its replacement ([Revoke an Apple key](#revoke-an-apple-key)). |
| The Apple client secret | Inside Entra, made by Entra from the live Apple key. Key Vault `apple-siwa-active-<env>` records the live slot and, in its `apple-renewed-at` tag, when Entra was given it. | 6 months after that date. The identity checks alert 30 days ahead. | Under outcome A, the monthly renewal. Under outcome B, by hand ([Apple keys and the Apple client secret](#apple-keys-and-the-apple-client-secret)). |
| The token-signing key | Container App secret `desk-signing-key`, and `desk-signing-key-previous` during a rollover | Never. | `provision-identity.mjs --rotate signing-key`, with a 30-day overlap, never in production in v1b-1 ([Rotate the signing key](#rotate-the-signing-key)). If it leaks, `--rotate signing-key --emergency` at once, in production too ([If the signing key leaks](#if-the-signing-key-leaks)). |
| The client key | Container App secret `desk-client-key` (`DESK_CLIENT_KEY`) | Never. | Only the emergency rotation changes it, together with the signing key. Changing it makes every client register and sign in again. |
| The GitHub App's credentials | Container App secrets `desk-app-id`, `desk-app-client-id`, `desk-app-client-secret` and `desk-app-key` (mounted as a file). Staging holds copies only during a rehearsal. | The private key never expires. | By hand, in the App's settings on GitHub ([The GitHub App's credentials](#the-github-apps-credentials)). |
| Ari's production invite link | `~/.ouro/invite-prod.url`, mode 0600, on the machine that issued it | 24 hours, or when redeemed | `--invite-ari` issues a new one. |
| The legacy probe's refresh tokens | `~/.ouro/probe-<name>.json`, mode 0600, written by the legacy probe `hosted/infra/mcp-probe.mjs`, which arrives with the rehearsal | Refused after `DESK_LEGACY_CUTOFF` | On day 14, move them to `~/.Trash/` with `mv`. |
| Accounts storage access | No secret: the gateway's managed identity holds an Entra role, and shared keys are off. | — | Nothing to rotate. |
| The admin app's client secret | Your macOS keychain, generic password `ouro-identity-admin-<tenant id>` with the app id as its account. The spike's secrets end on 2027-01-09. | 90 days after it was made. | The next `provision-identity.mjs --env <env>` run after it expires adds a new one and replaces the keychain item. To replace it earlier, delete the keychain item (`security delete-generic-password -s ouro-identity-admin-<tenant id>`) and run provisioning. Delete the old credential with `az ad app credential delete`. |
| The automation app and the checks identity | No secret: each signs in through a federated credential that trusts only the `identity` environment on ourostack/desk. | — | Nothing to rotate. |
| The Microsoft-account sign-in secret | Not present yet; it arrives with Microsoft-account sign-in in v1b-3. | At most 2 years. | Planned with v1b-3. |
| The backup writer's credential | Not present yet; it arrives with backups in v1c. | — | Planned with v1c. |

### Rotate the gateway's Entra client secret

Rotate it with one command when the identity checks say it ends within 30 days, or at once if it may have leaked:

```sh
node hosted/infra/provision-identity.mjs --env <env> --rotate entra-secret
```

Run it with the env's Ouro tenant as az's current account ([az sign-ins](#az-sign-ins)). Add `--dry-run` first to see what it would do. It gives you `Key Vault Secrets Officer` on the vault if you lack it.

Run it once at a time for each env: never start a second run while one is still going, in another terminal or on another machine. If a second run starts anyway, each run gives its credential its own name, `desk-gateway-<env>-<time>-<random>`, and touches only that one, and a run whose Key Vault tags change under it stops before writing anything.

The command keeps sign-in working throughout, and it never writes an empty secret:

1. It finds the credential the gateway holds now, from the `key-id` tag on `entra-client-secret-<env>`. If the tag is missing and the app has exactly one credential, it uses that one. Otherwise it stops before changing anything and says how to tag the secret.
2. It adds a 12-month credential with `--append`, so the old one keeps working. If the reset fails, or prints an empty or whitespace value, it stops, removes the credential it added, and writes nothing to Key Vault.
3. It writes the new secret to Key Vault through stdin, tagged `key-id=<new>` and `previous-key-id=<old>`, and reads it back to check its fingerprint. If the write reports a failure, the command reads the `key-id` tag to see whether the write landed anyway. If the tag names the new credential, it carries on. If the tag still names the old one, it removes the new credential and stops. If Key Vault can't be read, it keeps both credentials, so sign-in keeps working, and stops with exit code 2. Then rerun the command once Key Vault answers: if the tag names the new credential the rerun finishes the rotation, and if it still names the old one, delete the unused credential with the `az ad app credential delete` line the message prints and rotate again.
4. It restarts the app's revision and waits for the gateway's startup line, `keys: … entra <fingerprint>`, to show the new secret's fingerprint. Only then does it delete the old credential.

If the gateway still shows the old fingerprint after about five minutes, the command stops with exit code 2 and keeps the old credential, so sign-in keeps working. Expect this on the first run: in the 2026-10-12 rehearsal the revision restart kept the old Key Vault version, and the gateway showed the new one only in the next new revision, made 30 minutes after the write. Container Apps reads a new Key Vault version within about 30 minutes. Run the same command again after that; it sees the rotation under way, adds nothing, and deletes the old credential once the gateway shows the new secret. An image from before this check logs no `entra` fingerprint, so the command can't confirm the rotation and always keeps the old credential.

Afterwards, `node hosted/infra/identity-checks.mjs --env <env> --admin-app` must print `ok entra-client-secret` with a date about a year away.

### Apple keys and the Apple client secret

Each tenant has its own Apple App ID with two Sign in with Apple keys, in slots `a` and `b`: `bot.ouro.identity` for production and `bot.ouro.identity.testapp` for test. Each key is in Key Vault as `apple-siwa-key-<slot>-<env>`, tagged with its Key ID, its fingerprint and when it was imported. Entra makes the Apple client secret from the key the Apple provider uses, and that secret lasts six months. Key Vault secret `apple-siwa-active-<env>` records which slot the provider uses, and its `apple-renewed-at` tag records when Entra was given it. The identity checks count the six months from that tag.

How the client secret is renewed depends on Apple's outcome, recorded as `apple.outcome` in `identity-<env>.json`. Under outcome A, Graph can update the Apple provider, so the workflow renews it every month by switching to the other slot. Under outcome B, only the Entra admin center can, so Ari uploads the other slot's key by hand, about every five months, when the identity checks alert.

Change the test tenant first. After any Apple change, finish one Apple sign-in in the test tenant before you change production.

#### Import an Apple key

Keep the file name Apple gives the download, `AuthKey_<Key ID>.p8`. The import reads the Key ID from that name. If the file was renamed, pass the Key ID with `--apple-key-id <Key ID>`; a Key ID is 10 capital letters or digits.

```sh
node hosted/infra/provision-identity.mjs --env <env> --apple-key-file <folder>/AuthKey_<Key ID>.p8 --apple-key-slot <a or b>
```

The import writes the key to Key Vault through stdin and tags it with its Key ID and fingerprint. A new version carries only these tags, so the import also clears a `revoked` tag on that slot. It records the Key ID as `apple.keyIds.<slot>` in `identity-<env>.json`, and deletes the file once Key Vault returns the same key. With `--keep-file`, it keeps the file.

After every import, commit `identity-<env>.json` to main through a small pull request. The workflow sends a key only when its Key ID tag matches the Key ID recorded in main's copy of the file. Until the change is on main, the renewal refuses that slot and alerts "a key slot doesn't match its recorded Key ID or import fingerprint".

#### Renew under outcome A

The workflow renews test on the 1st of each month and production on the 2nd, so a renewal that breaks Apple sign-in shows in test a day before it reaches production. To renew by hand, renew test first and production after one Apple sign-in in the test tenant works:

```sh
node hosted/infra/identity-checks.mjs --env test --renew-apple --admin-app
node hosted/infra/identity-checks.mjs --env prod --renew-apple --admin-app
```

Don't use `gh workflow run "Identity checks" -f renew_apple=true` for this, because it renews test and production together.

The renewal sends the other slot's key, but only when its tags prove it is the recorded key. Key Vault holds the whole `.p8`; the renewal sends Graph only its Base64 body, without the `BEGIN` and `END` lines or line breaks, because Graph refuses a whole PEM. The renewal checks its own work by reading the provider back: Entra's audit log can't, because a change to the Apple provider logs only "Set federation settings on domain", with no Key ID. It records the new date only after Graph accepts the change and the provider, read back, shows the new Key ID. If the other slot is revoked or missing, it sends the live slot again, keeps the old date and alerts, so the next step is to [replace the revoked key](#replace-a-revoked-apple-key). An Apple provider created without a recorded date gets one from its first renewal, so run one renewal right after setup rather than waiting for the scheduled one.

#### Renew under outcome B

Do this when the identity checks alert that the Apple client secret ends within 30 days. Every upload must switch to the other key slot, because Graph can't tell a second upload of the same key from no upload. Run all the commands in one shell, from the repository root, because later steps use the variables the first one sets.

1. Set the env, find the live slot, and name the other slot and its Key ID from the record. The slot letter is not a secret.
   ```sh
   ENV=test
   LIVE="$(az keyvault secret show --vault-name kv-ouro-identity-261e0b --name "apple-siwa-active-$ENV" --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --query value -o tsv)"
   OTHER="$([ "$LIVE" = a ] && echo b || echo a)"
   KEY_ID="$(node -p "require('./hosted/infra/identity-$ENV.json').apple.keyIds.$OTHER")"
   echo "live $LIVE, uploading $OTHER ($KEY_ID)"
   ```
2. Download the other slot's key into a new private folder. Nobody opens the file.
   ```sh
   DIR="$(mktemp -d)"; az keyvault secret download --vault-name kv-ouro-identity-261e0b --name "apple-siwa-key-$OTHER-$ENV" --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --file "$DIR/AuthKey_$KEY_ID.p8"
   ```
3. Ari uploads it. In the Entra admin center for the env's tenant, go to External Identities, All identity providers, Apple, and edit the provider. Enter the Key ID that step 1 printed and upload the file. Only Ari does this upload.
4. Record the upload. The command checks that the provider now shows that slot's Key ID and that the slot recorded as live is the other one, and refuses otherwise.
   ```sh
   node hosted/infra/identity-checks.mjs --env "$ENV" --record-apple-upload "$OTHER" --admin-app
   ```
5. Delete the file through the import, which writes the same key again and deletes the file once Key Vault returns it. Run this step even if step 3 or 4 failed, so the private key doesn't stay in the folder. Because the name comes from the record, the Key ID can't change.
   ```sh
   node hosted/infra/provision-identity.mjs --env "$ENV" --apple-key-file "$DIR/AuthKey_$KEY_ID.p8" --apple-key-slot "$OTHER"
   ```
6. Finish one Apple sign-in in the test tenant. Then repeat with `ENV=prod`.

#### The first upload record

Until a date is recorded, the daily check alerts "no renewal or upload date is recorded". That is the state after the admin center creates the Apple provider, and for any provider created before these checks existed. Nothing back-dates it.

Under outcome B, or while `apple.outcome` is `null`, record the first date right after the upload: run `node hosted/infra/identity-checks.mjs --env <env> --record-apple-upload <slot> --admin-app` with the slot the provider uses. With no earlier record, the command needs only the provider to show that slot's Key ID. It records the time you run it, not the time of the upload. If the provider's key was uploaded more than a day earlier, upload the other slot now, as in [Renew under outcome B](#renew-under-outcome-b), and record that one, so the date is true.

Under outcome A the command refuses. A renewal records the first date instead.

#### Revoke an Apple key

Never revoke the key the Apple provider uses: Apple sign-in breaks at once. Tag the slot in Key Vault before you revoke it at Apple, so no renewal can send it in between.

1. Check which key the provider uses. This prints only the provider's Key ID and which recorded slot it is. `az rest` can't do this, because your own `az` sign-in can't read identity providers:
   ```sh
   node hosted/infra/identity-checks.mjs --env <env> --show-apple-key --admin-app
   ```
2. If it is the key you want to revoke, switch the provider to the other slot first. Under outcome A, run `node hosted/infra/identity-checks.mjs --env <env> --renew-apple --admin-app`, which must print `ok apple-renewal: sent the other key slot`. Under outcome B, upload the other slot and record it ([Renew under outcome B](#renew-under-outcome-b)). Then run step 1 again. Go on only when it prints the other slot's Key ID. If the other slot is missing or revoked too, stop: [replace that key](#replace-a-revoked-apple-key) first.
3. Tag the slot you are revoking:
   ```sh
   az keyvault secret set-attributes --vault-name kv-ouro-identity-261e0b --name apple-siwa-key-<slot>-<env> --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --tags revoked=true
   ```
   This command replaces all of the secret's tags, so it also drops `key-id` and `fingerprint`. Taking the `revoked` tag off again therefore doesn't make the key usable. If you tagged the wrong slot, import that key again.
4. Run step 1 again, right before you revoke. A renewal or an upload between step 2 and step 3 could have switched the provider back. Go on only when it still prints the other slot's Key ID. If it prints the Key ID of the slot you just tagged, don't revoke: switch the provider to the other slot as step 2 says, and check again. Under outcome A the renewal never sends a slot tagged `revoked`.
5. Revoke the key in the Apple Developer portal, under Certificates, Identifiers & Profiles, Keys.
6. [Replace the revoked key](#replace-a-revoked-apple-key).

#### Replace a revoked Apple key

1. In the Apple Developer portal, create a new Sign in with Apple key under the same App ID, and download it. Apple lets you download it only once.
2. Import it into the revoked slot, as [Import an Apple key](#import-an-apple-key) says. The import clears the `revoked` tag and records the new Key ID.
3. Commit `identity-<env>.json` to main.
4. Finish one Apple sign-in in the test tenant.

#### Email codes are not Ari's fallback

An email-code sign-in is not a way back in for Ari's account in v1b-1. If his email identity's `oid` differs from his Apple identity's, an email sign-in lands on the invite-only page. His fallbacks are the GitHub sign-in, while `DESK_GITHUB_SIGNIN=on`, and a [rollback](#rollback).

### Rotate the signing key

Run `node hosted/infra/provision-identity.mjs --env test --rotate signing-key`. It works only against staging in v1b-1. Production signing-key rotations wait until day 14 after the release, when the rollback to the v1a image retires, because a rolled-back image would know only the new key. Allowing `--env prod` after that is a later change.

The rotation refuses to run while `DESK_CLIENT_KEY` is unset, so run `--migrate client-key` first. It reads the running revision's startup line and refuses if the key it read differs from the one the gateway logged. It then writes the old key as `desk-signing-key-previous`, accepted until `DESK_SIGNING_KEY_PREVIOUS_UNTIL` (30 days and an hour later), and a new random `desk-signing-key`. After the restart it checks the new startup line. A second rotation is refused while the previous key is still accepted.

### If the signing key leaks

Use the emergency rotation, in production too:

```sh
node hosted/infra/provision-identity.mjs --env prod --rotate signing-key --emergency
```

Every client then registers and signs in again, Ari's legacy connector included. The ordinary rotation is wrong for a leak, for two reasons. It keeps the old key accepted for 30 days. It also leaves the client key alone, and the client key starts as a byte copy of the signing key, so a leaked signing key also lets someone make client ids.

The emergency rotation:
1. writes a new random `desk-signing-key` and a new random `desk-client-key`, and points `DESK_CLIENT_KEY` at the new client key;
2. removes `DESK_SIGNING_KEY_PREVIOUS` and `DESK_SIGNING_KEY_PREVIOUS_UNTIL`, and overwrites `desk-signing-key-previous` if the app holds one, so no older key is accepted;
3. restarts the app, then waits until the startup line shows both new fingerprints, the client key read from `DESK_CLIENT_KEY`, and no previous key.

It keeps every other secret, the Key Vault reference and the identities, as every app write does. After it, a rollback to an older image also signs everyone out, because that image seals client ids with the new signing key. Tell Ari to reconnect his claude.ai connectors, then run the legacy probe's `connect` again, because its token is gone too.

### The GitHub App's credentials

The App's private key never expires. To rotate it, generate a new key in the "Ouro Desk" App's settings on GitHub. No command can yet write the new key to the Container App without passing it as an argument, because `create-github-app.mjs` does exactly that. Until its fix in v1b-2, rotate the key only if it may have leaked, and treat that as a change of its own.

## Rollback

To roll back, turn off the deploy workflow, cancel any deploy still queued or running, and then point the app at the image it ran before the bad deploy. Do the steps in this order: a deploy run that is already queued or running isn't stopped by disabling the workflow, and it would put the new image back. Do not apply a saved app YAML with `az containerapp update --yaml`.

**Which image to go back to.** Every production deploy writes the image it replaced to its run's summary page, as "Rollback target, the image before this deploy". Find the run that deployed the bad image with `gh run list --workflow "Hosted Desk deploy" -R ourostack/desk`, and open it with `gh run view <run id> -R ourostack/desk --web`. Its log says the same thing, as `ouro-desk-hosted runs <previous image>; deploying <new image>`. Azure keeps every earlier revision's image too, which is a cross-check:

```sh
az containerapp revision list -n ouro-desk-hosted -g rg-ouro-work-substrate --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --all --query "[].{created: properties.createdTime, image: properties.template.containers[0].image, active: properties.active}" -o table
```

The target is normally the previous v1b-1 or later image, not the v1a image. Going back to an image from before Ouro sign-in shuts out every account that signs in with Apple or an email code. Before the first deploy of the release with Ouro sign-in, save the v1a image as well, because the run summary of that first deploy is the only other record of it:

```sh
mkdir -p ~/.ouro
az containerapp show -n ouro-desk-hosted -g rg-ouro-work-substrate --subscription 261e0bf1-934d-41ab-9295-229b0d254418 -o yaml > ~/.ouro/hosted-before-$(date -u +%F).yaml
az containerapp show -n ouro-desk-hosted -g rg-ouro-work-substrate --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --query "properties.template.containers[0].image" -o tsv > ~/.ouro/hosted-before-$(date -u +%F).image
```

The YAML is a record of the settings (secret names, no values), never something to apply.

**The rollback to the v1a image ends on day 14** after the release. On day 14 the legacy cutoff passes, `DESK_ALLOWED_LOGINS` and the saved v1a files retire, and production signing-key rotations become possible, so the v1a image may no longer admit anyone. After day 14, roll back only to a v1b-1 or later image.

**To roll back:**

1. Turn off the deploy workflow:
   ```sh
   gh workflow disable "Hosted Desk deploy" -R ourostack/desk
   ```
2. Cancel every deploy run that hasn't finished. The first command lists them, whether queued, waiting or running; cancel each, and repeat until it lists none:
   ```sh
   gh run list --workflow "Hosted Desk deploy" -R ourostack/desk --json databaseId,status --jq '.[] | select(.status != "completed") | "\(.databaseId) \(.status)"'
   gh run cancel <run id> -R ourostack/desk
   ```
3. Make sure az's Container Apps extension is current, because only recent versions send just the image (this runbook was checked against 1.2.0b4):
   ```sh
   az extension add --name containerapp --upgrade
   ```
4. Point the app at the target image:
   ```sh
   TARGET=<the target image>
   az containerapp update -n ouro-desk-hosted -g rg-ouro-work-substrate --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --image "$TARGET" --output none
   ```
5. Wait until the app's newest revision runs the target and is the ready one. Run this until it prints the target image and the same revision name twice:
   ```sh
   az containerapp show -n ouro-desk-hosted -g rg-ouro-work-substrate --subscription 261e0bf1-934d-41ab-9295-229b0d254418 --query "[properties.template.containers[0].image, properties.latestRevisionName, properties.latestReadyRevisionName]" -o tsv
   ```
6. Run `node hosted/infra/mcp-probe.mjs status --name prod-legacy` to confirm Ari's legacy connection works.

Why `--image` and not the saved YAML: az's YAML update reads every secret's value and sends them all back, and it drops the identity map from the request. The app holds a Key Vault reference, `entra-client-secret`, which has no value to read, so az either fails or turns the reference into a plain secret, and the missing identity map can take the gateway identity off the app. An update with only `--image` sends just the new image and never touches secrets or identities; it is the same command the deploy workflow runs on every release. `provision.sh` avoids the same problem for its own writes by building the whole app document and attaching identities first.

The new settings can stay on the app, because an older image ignores them: `DESK_ENTRA_*`, `DESK_ACCOUNTS_ENDPOINT`, `AZURE_CLIENT_ID`, `DESK_GITHUB_*`, `DESK_LEGACY_CUTOFF` and `DESK_CLIENT_KEY`. Leaving them means a fixed release needs no settings change. If a setting itself must change, use `provision.sh`, which keeps the running image, never the saved YAML.

A rollback to the v1a image keeps Ari's legacy connector working because:
- `DESK_ALLOWED_LOGINS` and every old secret stay on the app until day 14;
- the client key is a byte-exact copy of the signing key, so registered clients stay valid;
- tokens refreshed from Ari's legacy tokens keep v1a's claims, which the older image accepts.

The exception is a rollback after an [emergency signing-key rotation](#if-the-signing-key-leaks). That rotation voids every token and gives the client key its own random value, so none of the reasons above holds: after the rollback, every client, Ari's included, registers and signs in again with GitHub, as an allowed login in `DESK_ALLOWED_LOGINS`.

Every other connection must sign in again with GitHub after such a rollback: tokens from any Ouro sign-in, with Apple or an email code, and from the GitHub fallback carry an `accountId` instead of a login, and the v1a image refuses them.

Keep these rules while a rollback to v1a is possible:
- No production signing-key rotation happens before day 14, except the emergency rotation for a leaked key.
- A red `/healthz/deep` fails the deploy workflow but doesn't roll back. The new revision keeps serving until someone rolls back.

**To deploy again**, once a fix or a revert of the v1b-1 pull request is released, turn the workflow back on and start a deploy. Releases made while it was off triggered nothing, so enabling alone deploys nothing:

```sh
gh workflow enable "Hosted Desk deploy" -R ourostack/desk
gh workflow run "Hosted Desk deploy" -R ourostack/desk
```

After it finishes, run `node hosted/infra/mcp-probe.mjs status --name prod-legacy` again.

**Staging** has no deploy workflow, so skip steps 1 and 2. Find its target with the `revision list` command above against `ouro-desk-hosted-staging`, then run steps 3 to 5 against `ouro-desk-hosted-staging`.
