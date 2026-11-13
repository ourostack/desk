desk-web's `mine` replies now tell an agent where it is, what its action did and what to do next.

Every `goto`, `click`, `snapshot`, `find` and `wait` reply carries `page`: the tab's address (no query or fragment, and a path that looks like a token is hidden) and its title, with typed values redacted as in any snapshot. An action (`click`, `dblclick`, `hover`, `check`, `uncheck`, `select`, `press`) also says whether it navigated, changed the page in place, or left it as the agent's last read showed it, in `change` and a one-sentence `changeNote`. Clicking "Use the web app" a second time and getting the same page back now says "no navigation and no visible change" and points to another control, instead of leaving the agent to guess.

A `wait` for text stops early, instead of sitting for up to a minute, once no request has started or ended and no line of the page has changed for 10 seconds. The reply carries `waited.stuck`, and the hint says the page finished loading without that text, so waiting longer will not help, and suggests `find` with a shorter phrase or a ref from `snapshot --interactive`.

The not-ready hints for a `mine` context no longer suggest a fresh browser, another profile or the desktop app: the context holds the person's own sign-ins, so the hints say to reload, wait again or work from another page.

`find` already matches every visible text leaf a snapshot shows (since the whitespace and split-text fix), which a real-browser check over a page of varied text confirmed, so it needed no change.
