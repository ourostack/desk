# Browser production contract and implementation plan

> **For agentic workers:** Execute the bounded tasks below in order. Use test-driven development and verification-before-completion. The operator has authorized implementation; another operator approval or execution-menu prompt is not a prerequisite.

**Goal:** Make the installed Desk browser an unattended, signed-in, foreground-preserving, independently owned browser for every supported agent, including subagents. Carry the question-tool exclusion work in a separate worktree. Do not describe the full release as ready until the installed host matrix passes.

**Architecture:** Retain Desk's existing bootstrap, package resolver, Playwright MCP, extension connection, and generation-based installer. Small, explicit maintained Playwright patches are authorized. Patch dependency source during staging, never an installation a running client may use. No replacement browser framework, protocol interposer, caller-ID adapter, broker, daemon, ownership database, credential store, or security-policy bypass.

**Ownership:** This branch owns browser engineering and evidence. A separate branch owns generic question-tool exclusion. The branding lane owns public copy, visual design, RFC presentation/navigation, and Factory presentation. Engineering owns capability accuracy and verifies the resulting rendered surfaces; do not overwrite the branding lane's files.

## Release acceptance, not a claim of current behavior

| Requirement | Required evidence | Present disposition |
| --- | --- | --- |
| Acquisition | Authorized installation and extension binding without operator install/configuration/token chores | Open: supported unattended distribution path not admitted |
| Foreground | First and subsequent connections preserve application, window, selected tab and desktop | Open: stock extension deliberately activates/focuses |
| Ownership | A clearly named private group per actual agent instance, including native parents and built-ins | Partial: selected custom Copilot children passed; default/shared and Claude coverage not admitted |
| Cleanup | Failed acquisition does not acquire again; healthy close/disconnect affects only owned resources | Failed acquisition counterexample reproduced; first implementation slice below |
| Credentials | Legitimate acquisition/rotation boundary; no stale global override or persisted secret/baseline | Open: absent/empty readiness is not rotation ownership |
| Installed consumption | Fresh, resumed and updated sessions, concurrent agents, real profile and rendered workflow | Partial evidence only; blocked combinations remain unqualified |
| Questions | Structured question tools absent where host supports exclusion; ordinary chat questions remain allowed | Separate implementation lane; denial alone is insufficient |
| Shared product | Operator-neutral defaults; Desk + Crew public and opt-in; no blanket alpha/invite-only core framing | Engineering audit and branding coordination remain open |
| RFC and Factory | One coherent RFC/pointer journey; public Factory claims agree with actual engineering behavior | Rendered and end-to-end verification remains open |

Existing scoped-child, startup-repair and awaited-compound results remain narrowly scoped. In particular, a plugin-global parent is not per-agent isolation, one awaited compound action does not fix parallel dependent calls, and a successful build is not installed or rendered acceptance.

## Task 1: Failed-acquisition close safety

**Files**

- Create `plugins/desk/mcp/web-playwright-patch.cjs`.
- Create `tests/desk/mcp/__tests__/launch/web_playwright_patch.test.js`.
- Later integrate through `plugins/desk/mcp/web.cjs` and its existing launcher tests.
- Add one release fragment only when the runtime implementation is verified.

**Observed cause:** Playwright's MCP `createServer` initializes a backend before every first call. `factory.create` acquires the browser before constructing `BrowserBackend`. Initialization failure clears `backendPromise`; a subsequent `browser_close` therefore launches/acquires again. This is inside the dependency's lifecycle, not Desk's tool proxy.

**Smallest change:** In the server call handler, before initialization, recognize a declared `browser_close` only when no backend promise exists. Validate arguments using that declared tool's existing schema. Return an explicit no-session-open result without invoking the factory. Existing initialized and in-flight paths remain unchanged. An in-flight failed acquisition may still return its original error to a waiting close; it must never create a second backend. Preserve JSON/text response intent and shared-context safeguards on existing backends. Do not fabricate a stock screenshot, page-close action, or evidence that a browser was closed.

1. Extract a minimal, attributed lifecycle fixture from the inspected upstream implementation; retain the Apache provenance. Drive the handler with an injected factory, real argument schema where available, and acquisition/disposal counters.
2. Write RED tests: close before any call; acquisition failure then close; repeated idle close; failed in-flight acquisition plus close; healthy backend close; subsequent navigation after idle close; invalid close arguments; unknown tool. Add same-tick navigate/close in both invocation orders: the idle check and result construction must remain synchronous. Cover both `_meta.json` and `_meta.raw` with the normal serializer's formatting contract. Assert acquisition counts, actual disposal counts, output shape and error state, not just success strings.
3. Implement an explicit exact-source patch with a named revision. Require unique original context; reject absent, duplicate or partially changed context. Verify the installed server uses the inspected `factory.create` initialization contract. Do not silently run an unsupported unpatched package or use broad regular-expression replacement.
4. Run the targeted lifecycle tests to GREEN. Parse the patched source. Exercise the actual installed package through MCP with owned fixtures and blocked browser launch, reproducing the original counterexample: navigation acquisition count one, close count still one, no physical browser. Record unpatched RED and patched GREEN separately.
5. Review the affected lifecycle and error behavior before installer integration. No upstream issue/comment publication is authorized by this plan.

**Compatibility failure policy:** Never run an unsupported unpatched generation as a success-shaped fallback. During refresh, keep the last verified compatible generation and report incompatibility. On a cold install or migration with no verified compatible generation, report an explicit degraded browser state without publishing the incompatible generation. This intentionally favors known cleanup safety over running an unknown lifecycle; it does not block the rest of Desk or ask the operator to repair configuration.

## Task 2: Safe staged delivery and upgrades

**Files:** `plugins/desk/mcp/web.cjs`, `plugins/desk/mcp/web-playwright-patch.cjs`, `tests/desk/mcp/__tests__/launch/web.test.js`, and the Task 1 tests.

1. Add a patch-revision receipt to an install generation, separate from npm package version. Apply and verify patches before publishing `current.json`. Record package/core versions and patch revision, never credentials.
2. For an existing unpatched generation, stage a new generation under the existing installer lock. Prefer an offline copy of only its installed package tree, with symlink semantics preserved, using the compatible runtime selected by bootstrap; do not copy browser profiles or mutate the old generation. If safe staging is unavailable, report a visible degraded state rather than run an unqualified dependency. Do not introduce a foreground network requirement merely to patch an already installed compatible package.
3. Make refresh revision-aware even when npm's latest package version is unchanged. Keep tracking `@latest`; a patch compatibility check is not a permanent package pin. An unsupported new package must not replace the last compatible generation. Record refresh failure visibly using the existing diagnostic surface.
4. RED/GREEN installer cases: fresh install; warm patched launch without npm; offline migration; concurrent migration; same-version revision update; unknown source; patch failure before pointer publication; old client keeps old files; fresh client gets patched files; refresh preserves a compatible pointer on incompatibility. Update fake npm fixtures explicitly rather than teaching production code to accept stub packages.
5. Run the smallest combined launcher/lifecycle test selection, then the repository's applicable coverage and Windows validation. Verify actual clean installation and an upgrade from the retained stock generation, without editing the operator's global config or active browser.

## Task 3: Resolve the remaining browser acquisition contracts

These are engineering tasks, not permissions to bypass missing capabilities. Do not implement a substitute path that weakens the release acceptance above.

1. **Unattended extension provisioning:** identify a supported authorized distribution path for the supported browser/host combinations. Existing enterprise eligibility does not itself authorize policy creation. No production unpacked extension, consent clicking, browser restart or operator setup handoff. If none exists, retain the blocked gate and present the exact support decision required.
2. **Foreground:** revise the extension's deliberate `tabs.update({active:true})` / `windows.update({focused:true})` behavior only through an authorized maintained build/distribution path. Test first connection and reconnect with an owned headed fixture and an independently observed foreground application/window/tab/desktop. An MCP-only launch flag cannot fix extension focus.
3. **All-agent ownership:** identify a supported native per-instance launch/binding interface for each host's default, built-in and custom agents. Prove actual instance identities and owned groups; same agent type, same absolute entrypoint or separate PID alone does not establish ownership. No shared-context waiver or caller-ID protocol bridge.
4. **Rotation:** locate the legitimate initializer and rotation boundary. Keep credentials in memory only; test absent, empty, present-current and present-stale cases without capturing token values, hashes or token-bearing screenshots. Do not replace another process's global export or make global configuration a hidden source of truth.
5. After each admitted interface, write the smallest source-level RED/GREEN change and affected review. Reuse Task 2's auditable staging/update path for dependency changes. Do not accumulate an unbounded vendored fork.

## Task 4: Installed release and coordination

1. Merge reviewed runtime changes through normal CI and release. Pin evidence to source commit, release version, package/core versions, patch revision, host version and actual native instance scope.
2. Verify clean install, existing cache, fresh session, resumed session, updated session, two independent parents/children, failed first call, healthy close, disconnect, rotation and foreground preservation. Retain raw failures and ownership/cleanup receipts. Never mark an unrun host cell as passing.
3. Consume the separate question-policy result. Verify actual native model tool visibility, not merely hook denial or instruction text, and retain ordinary chat questions. Do not alter personal global hooks again.
4. Audit shared runtime/instruction/setup examples for operator-policy leakage. Preserve legitimate authorship/provenance. Coordinate any overlapping RFC or public positioning file with the branding lane rather than performing a competing rewrite.
5. Exercise real rendered RFC/pointer and Factory paths and the engineering behavior behind public claims. Existing pages/builds are not acceptance. Keep implemented behavior distinct from aspiration.
6. Update the canonical task with merged/released evidence and remaining failed/blocked cells. Stop only when every required cell passes or an explicit support/scope decision changes the release contract; never quietly redefine production-ready to the passed subset.

## Targeted commands

Run from `plugins/desk/mcp` using the compatible Node runtime:

```sh
node --import ../../../tests/desk/mcp/__tests__/_isolated_env.mjs --test ../../../tests/desk/mcp/__tests__/launch/web_playwright_patch.test.js
node --import ../../../tests/desk/mcp/__tests__/_isolated_env.mjs --test ../../../tests/desk/mcp/__tests__/launch/web_playwright_patch.test.js ../../../tests/desk/mcp/__tests__/launch/web.test.js
```

The actual-package differential test must name its owned package tree explicitly and must not use the operator's browser/profile. Runtime coverage and installed native-host commands are selected after the precise implementation and fixture are known; no passing result is implied by this plan.
