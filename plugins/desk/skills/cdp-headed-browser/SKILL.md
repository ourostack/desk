---
name: cdp-headed-browser
description: Use when qualifying browser automation or creating disposable browser-test profiles, when interactive authentication requires a persistent browser, when agents share an authenticated context, or when Playwright cannot reuse the required browser state. Do not invoke for ordinary unauthenticated browsing that works in an isolated browser, or ordinary browsing whose current MCP already has the required signed-in state.
---

# cdp-headed-browser

> **Overlay users:** consumer overlays provide browser-specific context declarations, launch behavior, and process attestation. This skill stays generic.

A signed-in browser context uses an existing declared profile without making a shared MCP connection its owner. An arbitrary debugging port, process ID, client name or group title is not ownership evidence.

## When to use it

Use an explicit signed-in context when:

- The task needs authentication already present in the declared profile.
- Several actual agents share a browser or MCP connection but need separate owned tabs.
- A retained context must remain usable across turns without opening a replacement.

Choose private mode explicitly for isolated, signed-out work. A missing declaration or native readiness never silently selects a headless/private fallback.

## Two tools, one handle per actual agent

`desk-web` lists only `browser_context` and `browser_command`. Do not call the former page tools such as `browser_navigate` or `browser_close`.

1. Each actual agent, including each child sharing its parent's MCP transport, calls `browser_context` with `{"action":"create","label":"Research child: compare renewal terms"}`. Omitted mode means signed-in. Supply a useful label, not whitespace or a connection/PID-derived identity.
2. Retain the exact returned `contextId`. Signed-in handles are plain UUIDv4 values. Private handles have the `private-` prefix. Creation generates the ID; callers cannot select it.
3. Operate only that handle: `browser_command` with `{"contextId":"<returned-id>","args":["goto","https://example.org"]}`. Arguments are the maintained CLI's page-command grammar, not shell code or another MCP tool's arguments.
4. Use `browser_context` with `{"action":"keep","contextId":"<returned-id>"}` or `resume` to check the same retained context. Neither creates a page, reopens a closed context nor replaces an unavailable one.
5. Choose `discard` explicitly when that agent wants to settle its owned context. Retention does not require an approval, and a task ending, connection closing or host exiting does not force cleanup.

Non-create actions accept only action and explicit ID. Mode and label are create-only. There is no ambient default, last context or automatic connection-owned handle. A parent must not hand one handle to multiple children and call that independent ownership. Agent names and labels are descriptive, not security principals.

Session, profile, configuration, connection, browser-lifecycle and global overrides are rejected. Signed-in callers cannot supply raw/JSON output overrides. For literal page data beginning with a dash, use the genuine inner delimiter, for example `["fill","e4","--","--session=page-data"]`. Do not hide options in short aliases or use a shell to evade these guards.

## Declared signed-in profile and readiness

An installed plugin may declare `"desk":{"browser":{"channel":"msedge","profileAccountDomain":"example.org"}}` in its manifest. The existing selector chooses that channel and matching existing profile. The same convention supports Chrome. It does not require a particular organization or overlay.

The matching native provider must already be registered, ready and freshly attested for the distributed extension source. A missing declaration, profile, compatible generation or readiness binding is an explicit failure. The controller does not install/register an extension, read a legacy token database, reload a normal extension, change the selected browser or borrow a private context. Generic cold setup and predecessor cutover are separate, unqualified operations.

Creation gives each actual agent its own tab group, initially useful and inactive, in that existing `desk.browser` profile. Never activate a tab/window, launch a persistent copy of the operator profile or ask the operator to export credentials. Do not automate extension token/status pages or capture their DOM or screenshots.

## Private mode and shell compatibility

Use `browser_context` with `{"action":"create","mode":"private"}` for fresh in-memory signed-out state. A useful label is optional there. Private mode is isolation, not anonymity or a separate OS security principal.

Shell clients use the same explicit controller:

```text
node <installed-desk>/mcp/browser-context.cjs create --label <useful-label>
node <installed-desk>/mcp/browser-context.cjs create --mode private
node <installed-desk>/mcp/browser-context.cjs keep <contextId>
node <installed-desk>/mcp/browser-context.cjs resume <contextId>
node <installed-desk>/mcp/browser-context.cjs run <contextId> -- <page-command> [arguments]
node <installed-desk>/mcp/browser-context.cjs discard <contextId>
```

The existing `browser-private.cjs create|keep|resume|run|discard` shell API remains compatible. Keep its returned private handle and exact resource paths. Private absent-discard behavior is not signed-in repeat-discard behavior.

## Failure and cleanup evidence

`isError`, a nonzero exit or structured native error resources are failures, never readiness or cleanup receipts. Preserve the generated handle, original code/resources, related errors and separate `contextResources`. An unknown startup can already have native effects. Do not create another context as an implicit retry or close foreign/unknown tabs.

Signed-in discard first checks current native status, obtains the current native disposition, then independently proves the exact maintained CLI stopped or is absent. Released transferred tabs are not absent and must survive. A successful current discard retains persistent metadata, immutable owner/config and exports; it does not archive evidence. A repeated signed-in discard is unavailable, not a fabricated idempotent success.

Screenshots, exports and owner directories remain after discard in both modes. Keep/resume never reanchors a missing or incompatible daemon, rewrites its generation stamp, prunes a registry or unlinks a stale socket to manufacture absence.

## Separate broker capability

The broker below is a separate claims-based provider interface for an explicitly configured persistent profile. It is not the `desk-web` native controller, a signed-in fallback or automatic setup/cutover. Its aliases and leases do not replace the explicit handles above. Use it only when the task separately declares that provider-backed interface.

## Required runtime inputs

The consuming overlay supplies:

- The exact executable path in `BROWSER_CONTEXT_BROKER_BIN`.
- A user-private broker configuration containing aliases and context declarations.
- An external provider command implementing discovery, launch, health, and attestation.
- A user-private state directory.
- A launcher that requests the intended alias or claim set.

The released Desk package is the canonical plugin-relative source at `browser-context-broker/`. An ordinary Desk install does not place `browser-context-broker` on `PATH`. A host overlay that offers this optional capability owns a runtime installer: it copies or installs that plugin-relative package, installs production dependencies, and supplies the resulting executable path to its launcher as `BROWSER_CONTEXT_BROKER_BIN`.

## Make the broker runnable on a fresh install

The broker source ships inside Desk's plugin folder without its `ws` dependency, so running it in place fails with `ERR_MODULE_NOT_FOUND`. The plugin folder is the parent of `docs/` in the path on the `Desk RFC:` line printed at session start. Install a private runtime copy once, with no overlay:

```bash
DESK_PLUGIN_DIR="<plugin folder>"
RUNTIME="${XDG_STATE_HOME:-$HOME/.local/state}/ouroboros-skills/desk/browser-context-broker"
mkdir -p "$RUNTIME" && cp -R "$DESK_PLUGIN_DIR/browser-context-broker/." "$RUNTIME/"
(cd "$RUNTIME" && npm ci --omit=dev --ignore-scripts)
export BROWSER_CONTEXT_BROKER_BIN="$RUNTIME/bin/browser-context-broker.mjs"
"$BROWSER_CONTEXT_BROKER_BIN" status --state-dir "$RUNTIME/state" --json
```

`status` answers `{"ok":true,...}` once the copy runs. Copy again after a Desk update. Without a provider, `acquire` still fails closed: it answers `INVALID_ARGUMENTS` when it is given no `--config`, and `INVALID_PROVIDER_CONFIG` when the config declares no `provider.command`, so on a personal install this makes the broker's own diagnostics reachable but not a signed-in browser; use the Playwright MCP options above for that.

Aliases are convenience only. The broker expands them to claims and applies the same exact, conjunctive comparison. Missing evidence, zero matches, and ambiguous matches fail closed.

## Normal launcher flow

The installed launcher performs this sequence:

1. Run `"$BROWSER_CONTEXT_BROKER_BIN" acquire` with the exact alias or JSON claim request, a distinct lease owner, and the intended recovery mode.
2. Start `"$BROWSER_CONTEXT_BROKER_BIN" proxy` for the returned lease and wait for its owner-private readiness file.
3. Start Playwright MCP with `--cdp-endpoint` set to the lease proxy endpoint from that file.
4. Run `"$BROWSER_CONTEXT_BROKER_BIN" release` for the exact lease when Playwright MCP exits.

Example contract:

```bash
"$BROWSER_CONTEXT_BROKER_BIN" acquire \
  --config "$BROWSER_CONTEXT_CONFIG" \
  --state-dir "$BROWSER_CONTEXT_STATE" \
  --alias "$BROWSER_CONTEXT_ALIAS" \
  --owner "$BROWSER_CONTEXT_LEASE_OWNER" \
  --recovery-mode full \
  --json

"$BROWSER_CONTEXT_BROKER_BIN" proxy \
  --config "$BROWSER_CONTEXT_CONFIG" \
  --state-dir "$BROWSER_CONTEXT_STATE" \
  --lease "$LEASE_ID" \
  --json-ready "$PROXY_READY_FILE"

npx -y @playwright/mcp@latest --cdp-endpoint "$LEASE_PROXY_ENDPOINT"

"$BROWSER_CONTEXT_BROKER_BIN" release \
  --config "$BROWSER_CONTEXT_CONFIG" \
  --state-dir "$BROWSER_CONTEXT_STATE" \
  --lease "$LEASE_ID" \
  --json
```

`acquire` returns only non-secret lease and context metadata. The proxy reads its raw endpoint and credential from the owner-private registry, then publishes the authenticated endpoint only through the mode-0600 readiness file. Treat that endpoint as lease-scoped connection material; do not place it in logs, status reports, task records, or shared configuration.

## Lease isolation

Every acquisition creates a distinct lease and an initial background target. The lease proxy:

- Filters target discovery and target events to lease-owned targets.
- Owns targets returned by `Target.createTarget`.
- Inherits popup descendants whose opener is lease-owned.
- Rejects attaching to, activating, or closing an unowned target.
- Rejects commands addressed to an unowned target session.
- Allows only the browser-level commands required to discover, create, attach to, and close owned targets.
- Rewrites browser-level `Target.getTargetInfo` barriers to an owned target, so current Playwright can complete its CDP handshake without learning about another lease's target.
- Rejects browser termination and other browser-global mutation; target-session commands are forwarded only for sessions owned by the lease.

Never search a persistent browser's global page list for a convenient existing tab. Work only through the lease proxy; all pages visible there are owned targets for that lease.

The persistent profile is the security-principal boundary. Leases separate target visibility, ownership, and cleanup for cooperating callers that intentionally share that profile; they do not make those callers mutually untrusted. A caller that can navigate its owned page can act with the authentication that profile presents to the loaded origin. Different identities, tenants, trust postures, or mutually untrusted callers require separate declarations backed by provider-isolated profiles or browsers.

## Focus preservation

A brokered headed browser is background infrastructure, not a remote-control surface. Never call `page.bringToFront()` or `Target.activateTarget` during unattended automation. The lease proxy rejects activation commands. This includes the first window a context opens: there is no first-window focus-stealing exception. The explicit signed-in native controller above has the same no-activation rule.

When a new page is required, create it in the background:

```js
const cdp = await browser.newBrowserCDPSession();
const { targetId } = await cdp.send("Target.createTarget", {
  url: targetUrl,
  background: true,
});
```

The proxy records the returned target for the current lease. Popup targets inherit ownership only when their opener is already owned.

Playwright's synthesized click and fill events do not require foreground activation. If an action genuinely requires an operating-system dialog or visible human interaction, surface that requirement instead of grabbing focus.

## Direct `connectOverCDP` use

When a short Node script must connect directly, use only the lease proxy endpoint produced by `proxy`:

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.LEASE_PROXY_ENDPOINT);
const context = browser.contexts()[0];
const page = context.pages()[0];

// Interact only with pages visible through this lease proxy.

await browser.close({ reason: "lease client detached" });
```

For an attached client, `browser.close()` detaches that client; it does not terminate the persistent provider-owned browser. The launcher still releases the lease separately so owned targets are closed and registry state is removed.

## Status and recovery

Use broker diagnostics rather than inspecting ports or process-name patterns:

```bash
"$BROWSER_CONTEXT_BROKER_BIN" status \
  --state-dir "$BROWSER_CONTEXT_STATE" \
  --json

"$BROWSER_CONTEXT_BROKER_BIN" doctor \
  --config "$BROWSER_CONTEXT_CONFIG" \
  --state-dir "$BROWSER_CONTEXT_STATE" \
  --json
```

`status` reports non-secret context observations, loopback context endpoints, claims, process identities, attestation/recovery summaries, owners, and leases. `doctor` identifies expired leases, restart authorization, autonomous-recovery eligibility, blocking lease owners, and actionable reconciliation problems without exposing lease-proxy endpoints, provider environment, credentials, cookies, or tokens.

Recovery is requested-context-only:

- A stale observation is discarded only after fresh provider attestation fails.
- An absent requested context is provisioned without selecting or modifying another live context.
- Endpoint collisions allocate another dynamic endpoint.
- An unhealthy exact context first receives bounded non-destructive recovery.
- Destructive restart is allowed only when the declaration authorizes it and no active lease blocks it. Active leases return `CONTEXT_RECOVERY_CONFLICT` with their non-secret owners instead of disrupting them.
- The provider must freshly prove the exact process generation immediately before any destructive action and re-attest the replacement before acquisition succeeds.
- A crashed requested context is repaired on the next acquisition when those safety checks pass.
- An unrelated context is never stopped, relaunched, or substituted.
- Browser-visible claim mismatch, ambiguous evidence, process-generation change, and human authentication requirements fail closed without restart.

## Cleanup

Normal completion uses `release` for the exact lease. It closes only targets recorded to that lease, removes only that lease record, and leaves the persistent browser alive.

For an expired lease identified by `doctor`, use exact cleanup:

```bash
"$BROWSER_CONTEXT_BROKER_BIN" cleanup \
  --config "$BROWSER_CONTEXT_CONFIG" \
  --state-dir "$BROWSER_CONTEXT_STATE" \
  --lease "$STALE_LEASE_ID" \
  --json
```

Cleanup freshly attests the process generation recorded on that exact lease. If it is still the same live generation, cleanup closes the recorded targets and removes the lease. If the provider proves that original generation is absent or disconnected, cleanup removes the stale lease without connecting to the endpoint and reports the recorded targets as unclosed because their owner generation is gone. A live replacement or mismatched generation remains `CONTEXT_DISCONNECTED`; cleanup never follows it or touches its targets.

Do not terminate browsers by executable name, profile-name pattern, or guessed process identifier. Context termination, when genuinely required, belongs to the attesting provider and must operate only on a process identity it proves it owns.

### Disposable browser qualification profiles

For browser testing, invoke this skill even when sign-in is not required. Before creating a fixture, record its exact disposable profile root separately from real/provider-owned authentication state, allocated bytes, host free space, maximum concurrent profile count, maximum total fixture bytes and minimum free-space reserve. Choose limits before the first allocation; include browser component downloads and other concurrent work in the headroom. Recheck actual allocation and free space before every attempt, and refuse another allocation if its expected growth would breach either limit or the reserve. Unknown growth calls for one bounded measured attempt, not repeated fresh profiles.

After every successful or failed terminal attempt, preserve compact scripts, logs, screenshots and receipts, then remove that attempt's inactive disposable profile before allocating its replacement. Fresh-state comparisons can require several profiles simultaneously; bound their count and total bytes in advance and dispose of them when the comparison ends. Whole profiles are not necessary merely because evidence must survive or acceptance is pending.

Before removal, verify the exact resolved path, ownership and disposable provenance; freshly verify no process uses it and no live or unverifiable profile lock remains. Unknown ownership or liveness means no deletion and no replacement allocation that breaches the budget. Never delete by broad prefix, glob or browser name; use exact scoped paths through an authorized filesystem operation. A private fixture can acquire authentication during testing: never export it as evidence, and deleting that proven disposable fixture does not authorize deleting the operator's persistent profile.

Before delivery, read back profile absence, retained scratch bytes and host free space. Quitting a browser, moving data to Trash, or writing a future cleanup trigger does not prove space reclaimed. A specifically necessary retained fixture needs a bounded byte/count disposition, reason, owner and executable cleanup trigger; otherwise remove it now. Report unresolved cleanup as unfinished work, not completed browser cleanup.

## Failure modes

- **`NO_CONTEXT_MATCH`** — no declaration contains all requested evidence. Fix the request or provider configuration; do not broaden matching.
- **`AMBIGUOUS_CONTEXT_MATCH`** — several declarations match. Make their claims distinct; do not choose by ordering.
- **`LAUNCH_ATTESTATION_FAILED`** — the provider launched something that did not prove the declared executable, profile, owner, endpoint correlation, or configured visible claims.
- **`ENDPOINT_COLLISION`** — dynamic allocation could not find a usable endpoint within the configured attempts.
- **`UNSUPPORTED_CONTEXT_RECOVERY`** — the provider proved the requested context exists but cannot safely recover that exact process generation. Preserve its provider-supplied reason and generation evidence; do not substitute another browser or collapse it to a generic launch failure.
- **`CONTEXT_RECOVERY_CONFLICT`** — destructive recovery is blocked by one or more active leases. Preserve the listed lease owners; do not remove their leases or restart the context.
- **`DESTRUCTIVE_RECOVERY_DISABLED`** — acquisition was explicitly limited to non-destructive recovery, or the declaration does not authorize restart.
- **`RECOVERY_PROCESS_CHANGED`** — exact process identity changed during recovery. Nothing may be signaled until a later fresh acquisition proves a stable generation.
- **`RECOVERY_TERMINATION_FAILED`** — the provider could not prove the exact declared process tree exited. Do not launch a replacement against the same profile.
- **`HUMAN_AUTH_REQUIRED`** — authoritative provider evidence proves the requested context has no usable authenticated principal and requires genuine interactive authentication.
- **`VISIBLE_CLAIM_MISMATCH` / `VISIBLE_ATTESTATION_INDETERMINATE` / `VISIBLE_ATTESTATION_CLEANUP_FAILED`** — browser-visible evidence did not match, could not be interpreted uniquely, or its exact temporary attestation target could not be proven removed. All fail closed without substituting or restarting another context.
- **`LEASE_NOT_FOUND`** — the lease was released, expired and cleaned, or the wrong state directory was supplied.
- **`STALE_LEASE` from `doctor`** — run `cleanup` for that exact lease after confirming it is no longer active.
- **Cleanup reports `OWNER_GENERATION_GONE`** — the provider freshly proved the lease's original process generation absent/disconnected. The lease record was removed, no replacement endpoint was contacted, and its recorded target IDs could not be closed.
- **Disconnected context** — reacquire the same requested context. Never attach to a different live browser as a fallback.

## Cross-references

- **Workspace MCP configuration:** use `desk:add-workspace-mcp` for the runtime's stdio server shape.
- **Provider-specific launch and attestation:** follow the consuming overlay's browser-provider skill.
- **Persistent profiles:** provider-owned profile roots are durable authentication state. Never delete or repurpose them as cleanup.
