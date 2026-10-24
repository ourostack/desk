---
name: cdp-headed-browser
description: Use when authenticated browsing, interactive sign-in, independent concurrent browser contexts, interrupted browser work, or disposable browser qualification is required.
---

# Agent-owned browser contexts

Use `desk-web`'s two tools, `browser_context` and `browser_command`. A new default context owns a persistent profile in installed Edge or Chrome, normally headless. It does not borrow the person's browser, require an extension, or use a custom broker. Separate profiles do not prevent normal OS SSO from supplying an account; inspect authentication rather than promise account or per-site isolation.

## Ordinary work

1. Each actual agent, including a child sharing MCP transport, creates its own handle: `browser_context {"action":"create","label":"Research: compare renewal terms"}`.
2. Keep the exact returned `contextId`. Navigate with `browser_command {"contextId":"<returned-id>","args":["goto","https://example.org"]}`.
3. Call `["snapshot"]` explicitly for inline accessibility state and element refs. Navigation's automatic snapshot can be a file path; another explicit snapshot avoids filesystem access. Then use ordinary maintained CLI argv such as `["fill","e4","value"]`, `["click","e7"]`, `["tab-list"]`, or `["eval","document.title"]`.
4. Await an action before its dependent snapshot. Verify the actual page and effect, not HTTP success alone.
5. Across turns use `{"action":"keep","contextId":"<returned-id>"}` or `resume`. Neither opens a replacement or needs another approval. When finished, `discard` that exact handle and inspect cleanup resources.

Use `{"action":"create","mode":"private"}` for fresh in-memory state; labels are optional there. Private handles include `private-`; signed-in handles are plain UUIDv4. There is no ambient default. A parent cannot share one handle among children and call that independent ownership.

Page arguments are arrays, not shell text. Session, profile, connection, configuration, global/output and browser-lifecycle overrides are reserved. For literal leading-dash page data, use an inner delimiter: `["fill","e4","--","--session=page-data"]`. Do not evade these guards through page code or another connection.

## Genuine sign-in

First inspect the default headless context: managed OS SSO may already authenticate it. A login page, MFA or device-policy block is not success. Do not copy cookies/tokens/profiles, change policy, automate security consent, or operate the person's browser.

A remembered account or cookies do not prove compliant-device access. A device-policy refusal needs SSO/policy diagnosis, not another account click or repeated sign-in. Verify the actual required application; success at an account portal is not proof that every application admits the profile.

When a visible window is genuinely required, obtain the operator's agreement and create a **sign-in-only** context with `interactive:true`. Let the human complete credentials/MFA/account selection. After they finish, call `{"action":"finish-sign-in","contextId":"<that-id>"}`. This explicitly closes sign-in pages and reopens the same owned profile headlessly without replay; inspect the work site again before starting work. It refuses ordinary headless, private and legacy contexts. Never use it to restart uncertain work.

## Interruption and cleanup

Keep the handle, original error and both `resources` and `contextResources`. A lost acknowledgement may follow a completed write: resume the same context, inspect tabs/page and the system of record, and reconcile before retrying. A missing or incompatible daemon is an explicit error, not permission to recreate, select another browser, or replay.

Managed discard verifies owned shutdown before removing only its authentication profile and retiring the handle. Exports remain. Read back `profileDisposition`; stopping a process alone is not profile removal. Failed/unknown cleanup stays unfinished. Existing extension-backed handles retain their original compatibility behavior; never migrate them implicitly.

## Qualification resources

Before creating test profiles, record exact owned roots, current bytes/free space, maximum concurrent profiles/total bytes and a minimum free-space reserve, including component-download headroom. Recheck before each allocation. Unknown growth permits one bounded measurement, not repeated fresh profiles.

Keep compact receipts outside authentication state. Before disposing of an exact profile, prove its ownership, disposable provenance and process/lock absence; unknown liveness forbids deletion. Read back absence, retained bytes and host free space. Necessary retention needs a bounded count/byte budget, named owner and executable cleanup trigger. Never export an authenticated profile as evidence.

## Shell and optional providers

The same installed entry supports `create --label <label> [--interactive]`, `create --mode private`, `keep|resume|discard|finish-sign-in <id>`, and `run <id> -- <page-command>`: `node <installed-desk>/mcp/browser-context.cjs ...`.

An overlay may separately declare the optional claims-based [browser context broker](../../browser-context-broker/README.md). That interface has its own provider/lease contract; it is not a normal setup requirement or a fallback for `desk-web`.
