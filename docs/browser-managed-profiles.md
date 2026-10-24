# Agent-owned managed browser profiles

## Intent and approved direction

Agents need authenticated web access without controlling a person's everyday browser, disturbing another agent, or asking a person to install extensions or configure connection details. Device-management requirements must remain effective. Use the maintained Playwright CLI with an installed browser and a separate persistent profile for each context; keep explicitly private browsing unchanged. This direction was approved on October 22, 2026 after an actual managed macOS experiment authenticated to a work account portal, survived a clean restart, and worked headlessly without copying browser state or changing policy.

This is not an authentication implementation. Browser and operating-system SSO supply identity according to their normal policy. Separate profiles isolate browser data; they do not prevent OS SSO from supplying an account or implement a per-site authorization boundary.

## Contract

- Preserve `browser_context` and `browser_command`, generated handles, required useful signed-in labels, and explicit private mode. An agent must keep and resume its exact returned handle.
- New signed-in contexts use an installed declared browser, or installed Edge then Chrome when no browser is declared. Never substitute a bundled unsigned-in browser, another context, or the operator's profile when this fails.
- Give each signed-in context its own owner-private profile under its existing context directory. A context exclusively owns its maintained CLI session, browser profile, socket namespace and exports.
- Preserve the real OS account home and native identity environment for signed-in mode. Generate a context-local CLI registry and socket namespace. Never inherit caller-supplied Playwright session, connection, configuration, profile, test or preload overrides.
- Signed-in contexts normally launch headlessly, with the browser sandbox enabled. Optional `interactive: true` on signed-in creation opens a visible context for an operator-approved genuine sign-in; it is not an instruction to automate credentials, MFA, consent, or account selection. Existing contexts are never silently replaced with an interactive one.
- After the operator finishes genuine sign-in, explicit `finish-sign-in` closes only that interactive browser, proves its daemon stopped and its same owned profile is unused, then reopens that profile headlessly. Authentication persists through the browser's own profile, not copying. Sign-in pages close without replay; authentication must be inspected again. Ordinary headless, private and legacy contexts refuse this transition.
- An interrupted sign-in transition retains independent handoff provenance and atomically published configuration. Only explicit `finish-sign-in` may reconcile or retry an incomplete handoff after exact replacement-daemon presence/absence proof; unknown startup remains unconfirmed, and ordinary work cannot restart it.
- Do not inspect or copy the operator's browser profile, cookies, tokens, or saved authentication state. Do not change enterprise policy or relax management checks.
- `keep` and `resume` connect to the existing context. A disconnected frontend does not terminate the maintained browser daemon. They do not silently recreate a missing browser or replay a command whose acknowledgement was lost; return an explicit retained-context error and require inspection or a deliberate new context when necessary.
- Serialize signed-in operations with the existing per-context lock. A malformed, incompatible, changed, foreign, or unreadable owner/session record refuses before page execution.
- `discard` stops only the owned maintained session, verifies its acknowledgement, metadata and socket disposition, and records retirement so the old handle cannot recreate work. Preserve exports. Authentication/profile data is secret state, not an evidence artifact; report its exact retention/disposal rather than claiming a stop deleted it.
- Retirement is resumable cleanup, not proof of deletion. Persist the exact owned profile identity before shutdown; a lost acknowledgement or transient removal failure keeps the handle retired while explicit discard retries under its lock, freshly reconciling daemon exit and profile non-use. Missing metadata alone never proves disposal.
- Existing extension-backed handles remain bound to their original backend through explicit compatibility dispatch. New creation never invokes that backend. Do not migrate old pages, effects or authentication implicitly.
- Errors preserve unknown outcomes and cleanup obligations. A sign-in page or a policy block is not authenticated success. Stop for genuine human authentication rather than bypassing it.

## Implementation shape

Extract the existing private maintained-CLI facade into one local-browser controller used by private and managed modes. Extend the existing worker's local-session validation for an owned persistent profile instead of introducing another runner, protocol, browser server or extension. Keep the private wrapper and the existing public CLI entrypoints compatible.

Move the old extension-backed controller behind a compatibility module. Share its input validation and bootstrap entry rather than duplicating them. Use existing owner-only filesystem protection, browser discovery, locking, error scrubbing and maintained CLI lifecycle code. Keep backend-specific execution checks separate: a managed session is never admitted as an existing native session or vice versa.

## Acceptance and release

Unit tests must cover immutable profile binding, preserved OS identity environment with rejected ambient overrides, independent contexts, private-mode regression, absent/malformed sessions, changed records, command failure, uncertain acknowledgement, exact discard and legacy-handle dispatch. Exercise the actual maintained CLI and installed browser, not only models of its config.

Run real Claude and Copilot clients simultaneously against the production-shaped tools, with authenticated read-only work-page checks and a safe multistep fixture for forms, popups and observable effects. Verify peer isolation, frontend termination after an effect but before acknowledgement, inspection without replay, resumed pages, and independent cleanup while the operator's browser remains available. Check ordinary installed acquisition after release; source paths or successful test processes alone are not delivery.

Keep platform and policy scope explicit. The feasibility experiment proves one managed Mac, not Windows device enrollment, every tenant/application, fresh headless-only provisioning, expired-token recovery or mutually untrusted identity isolation. Do not infer these from private fixtures or from HTTP 200.

The browser owner delivers the reviewed source, actual client evidence, remaining limits and exact resource dispositions directly through the canonical task to the promotion owner. Overall out-of-alpha promotion remains with that owner.
