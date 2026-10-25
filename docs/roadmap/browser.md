# Browser roadmap

On October 25, 2026 Desk's browser became two choices, `fresh` and `mine`, run headless through the Playwright CLI (see the [RFC, section 3.1](../../plugins/desk/docs/agentic-engineering-v2-rfc.md#31-effortless-browser-contract)). Each capability removed then is listed below with the problem it would solve if it comes back.

- **Visible browser window:** a site that refuses headless browsers, or a sign-in step the person must complete by hand, could open in a window that does not take focus.
- **Driving the person's open browser through the Playwright Extension:** an agent could use tabs and sign-ins that exist only in the running browser, without a copy, and the person could watch it work.
- **Native messaging helper and its per-platform binaries:** the extension could reach Desk without a connection token the person copies by hand.
- **Managed agent profiles that persist between sessions:** an agent could stay signed in to sites the person signed it into once, without copying the person's own profile.
- **Real-profile declaration (`desk.browser` in a plugin):** a plugin could choose which browser and which signed-in profile `mine` uses, for example a work profile instead of the last-used one.
- **Browser-context broker with leases and claims:** several agents could share one long-lived signed-in browser with each one limited to the tabs it owns.
- **Recovery loops and the launcher proxy:** a session could keep working through a browser crash or a slow first install without the agent opening a new browser.
- **Private contexts that survive a Desk restart:** an agent could reopen the same browser after its MCP server restarts instead of opening a new one.
- **Tab groups named after each agent:** the person could see which agent owns which tabs in their own browser.

## Known gap

- **All sign-ins in `mine` on Windows while Edge is open:** Windows locks Edge's cookie file and a few others while Edge runs, so Desk copies everything else and skips them. The Microsoft work sign-in still carries over through the Windows account, but ordinary site sign-ins do not, and `browser_context` says so. Closing Edge first carries them all. Reading the locked files would need an administrator-only snapshot or touching the running Edge, and Desk does neither.
