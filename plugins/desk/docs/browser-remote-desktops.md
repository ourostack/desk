# Driving a remote desktop in the browser

An agent can use a cloud PC or virtual desktop that has a web client through Desk's own browser, with no remote-access daemon, no extra software and no new sign-in. It uses `browser_context` and `browser_command` with `browser: "mine"`, so the person's existing sign-in comes with the private copy. Below are the steps, as tested on a cloud PC web portal, from opening the browser to running a PowerShell command in the remote session. Commands are shown as `browser_command` `args` lists; `<ref>` stands for a ref from the agent's latest read.

## 1. Open the portal

1. `browser_context` `{ "action": "open", "browser": "mine" }`, then keep the `contextId`.
2. `["goto", "<the web portal of your remote desktop service>"]`
3. `["wait", "<text you expect on the page, such as the machine's name>"]`. `wait` returns a snapshot once that text shows.

If the portal asks for a sign-in, `mine` didn't get one from the person's browser. Stop and tell the person. Don't type credentials or start a sign-in the person didn't ask for.

## 2. Keep refs fresh

A ref belongs to one read of one tab. It works while it comes from one of that tab's last three reads (`snapshot` or `find`) and its element is unchanged. After a tab switch, navigation or anything else that redraws the page, an old ref is refused:

- `AUTH_SNAPSHOT_INVALIDATED`: the page replaced that element, or navigated, after the read.
- `AUTH_TARGET_REFUSED`: the ref isn't from one of the tab's last three reads, or its element has gone.

Both mean read again and act on the new ref: `["snapshot", "--interactive"]`, or `["find", "<label text>"]`, which returns just the matching lines with their refs. A new read also renews refs inside child frames, where a remote desktop's screen usually lives. Desk already retries its own reads while a page settles, so a refusal on a ref means that element really changed. Retrying the old ref won't help.

Refs can change between two actions on the same page. To uncheck one setting and check another, read again before each action.

## 3. Open the session

1. `["find", "<machine name or its actions menu>"]`, then `["click", "<ref>"]`. Choose the item that opens the desktop in the browser.
2. If it opens a new tab: `["tab-list"]`, then `["tab-select", "<n>"]`, then `["snapshot", "--interactive"]`. Every ref from the old tab is now stale.
3. Set the session's options on its settings page, such as clipboard or printer, with `check` or `uncheck` on fresh refs.
4. `["find", "Connect"]`, then `["click", "<ref>"]`. The page shows a connecting state. Wait about 15 to 30 seconds with `["wait", "<seconds>"]`, then `["screenshot"]`. Dismiss any first-run dialog (`find` its button, then `click`).

## 4. Type into the remote screen

The remote screen is a canvas. A read shows it as a `textbox`, usually next to text that says it's the remote session. Use that `textbox` ref for keys:

1. `["click", "<canvas ref>"]` to give it focus.
2. To open PowerShell on a Windows desktop: `["press", "Control+Escape"]`, then `["type", "<canvas ref>", "windows powershell"]`, then `["press", "Enter"]`. Wait about 10 seconds and read again for a fresh canvas ref.
3. `["type", "<canvas ref>", "Write-Output <nonce>; Get-Date"]`, then `["press", "Enter"]`. Use a fresh random nonce each time.

`type` focuses the target, checks it still has the focus before every key and stops with `AUTH_FOCUS_MOVED` if something else takes it. The field may then hold part of the text. Read again, check what landed and type again.

`AUTH_FOCUS_MOVED` also comes up, by design, in two common cases. Keep the focus check on and handle them like this:

- **The ref is the session's image, not its textbox.** The image can't hold focus. Read again and use the `textbox` ref next to it.
- **A code split across several boxes** (one box per character or group) moves focus to the next box by itself. Fill each box on its own: read, `["fill", "<box ref>", "<that box's part>"]`, then read again before the next box. Never type the whole code into the first box.

## 5. Check the result in a screenshot

On a canvas, `type` returns `"typed": { "verified": false }`, because Desk can't read characters back from pixels. Don't report typing as verified, and don't take the canvas's own text as proof. The proof is a `["screenshot"]` that shows the nonce echoed and the date printed.

Screenshots mask every input, textarea and editable region, so the canvas's input layer shows as `[redacted]`, and the remote session's pixels show around it. A screenshot is refused with no file when part of the page is in a closed shadow root (`AUTH_SHADOW_COVERAGE_REFUSED`) or a child frame can't be read (`AUTH_FRAME_COVERAGE_REFUSED`). Wait and try again, or `goto` that frame's own page.

## 6. Finish

`browser_context` `{ "action": "close", "contextId": "<id>" }`. Closing deletes the private copy. Sign out of the remote session first if the person asked for that. Leaving it connected keeps the remote session running.

## Next: a coding agent in the remote session

With a PowerShell window open, the person can set up a coding agent there by following that tool's own install guide. For GitHub Copilot CLI that's [Installing GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli). It needs the Node.js version that guide names inside the remote session, which is separate from the Node.js that runs Desk on the agent's own machine. Installing software on the remote machine needs the person's go-ahead. Sign-ins there (`/login`, `gh auth login`) are the person's: when one shows a device code, give it to them and let them finish it in their own browser. Never carry a token or a second factor across.

## When it stops

- `AUTH_TIMEOUT`: the command ran too long and the context is closed. Open a new one, start again from step 1 and keep waits under a minute.
- `AUTH_ACTION_COVERED`, `AUTH_ACTION_NOT_READY` or `AUTH_ACTION_TIMEOUT`: that one control could not be used in time, and the context is still open. Look at the page with a snapshot or a find, clear what covers the control or wait for the page to settle, then act on a fresh ref.
- `AUTH_CONTEXT_REFUSED`: the tab or context is gone. Open a new one.
- `AUTH_COMMAND_REFUSED`: the command isn't one `mine` runs. The line lists the ones it does.
- Each of these failures also names the one call that files a bug with its evidence: `friction_add` with `{"error_code":"auth_timeout"}` (the code, lowercased).
- A certificate, unsafe-site or operating-system authentication prompt: stop and tell the person. Desk never clicks through these.
