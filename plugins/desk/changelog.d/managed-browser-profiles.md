### Authenticated browsing without borrowing your browser

New signed-in browser contexts use standard Playwright with an installed Edge or Chrome browser and a separate persistent profile for each agent. They normally run headlessly, preserve normal OS/device SSO, and require no manual extension installation, token export or custom broker setup. Separate profiles are not account or per-site authorization boundaries: agents inspect the actual authenticated page.

An explicitly approved interactive sign-in context can return to background operation through `finish-sign-in`, preserving its same profile without replaying sign-in pages. Existing work contexts retain their handles across frontend interruptions; missing sessions and unknown outcomes never trigger automatic recreation or action replay. Explicit discard verifies owned shutdown, removes the authentication profile and preserves exports. Private browsing and existing extension-backed handles retain their compatibility paths.

The [browser guide](skills/cdp-headed-browser/SKILL.md) now describes the two-tool workflow and explicit inline snapshots rather than requiring ordinary agents to configure the optional broker.
