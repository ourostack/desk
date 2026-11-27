---
name: live-ui-iteration
description: Use when you iterate on a UI with a person, such as being asked for feedback on a screen, polishing a screen with them, showing them a design or prototype, or receiving their notes on how something looks, moves or feels.
---

# Live UI iteration

Iterate on a UI with the person watching it change, not by sending them screenshots. A screenshot is a round trip they have to open, judge and answer; a live page they already have open shows each edit in about a second, and their notes arrive while they look.

## Set up the loop

1. **Run a live mock where they already look.** Keep a hot-reload dev server running on made-up data (never their real data or account). Give each state a URL parameter, such as place, theme and chrome, so any state is one link away. If the app needs native chrome, add a dev-only stand-in so headless runs render the whole window. Open the URL in the panel beside their chat, or hand it to whoever holds their screen (a lead session opens it for a lane); each save then reaches their eyes without a message.
2. **Keep your own run apart from their view.** Run checks on a second server and daemon with their own ports and home. Drive it headless. Never open a window on the person's screen and never click or type in the view they are watching: a headless click once typed a stray "e" into someone's live page.
3. **Veil what isn't designed.** Cover states and widths nobody has designed with a "not designed yet" veil, so the person never judges a layout you haven't made. Fit by measurement, not breakpoints: put the veil below the narrowest designed width.
4. **Tell them how the loop works when you hand it over.** In the same message as the live URL, say how to reach each state, that each of their notes becomes one small edit that shows up on that page, and that every decision they make becomes a deterministic check that runs on every edit instead of something you re-inspect by eye. They can't rely on a loop they were never told about.

## Run the loop

- **One note, one small edit, one-line reply.** Land each edit in under a minute and say in one line what changed. Never batch notes: a full stylesheet rewrite once dropped its own tail and brought back what the person had rejected.
- **Every decision becomes a check.** When the person decides something ("the gap is 12", "the header stays pinned"), write it as a deterministic check that runs on every edit, in the repository's own test or lint suite. Run the suite after every edit, so nothing approved regresses. Never ask an agent to check by eye what a check can measure (`visual-proof`).
- **Critics judge taste only, in the background.** Start critic agents on the live result for what no check can judge (does it make sense, feel right, match the intent). They never block an edit, and what they find becomes a note you weigh like any other.
- **Believe their eye over your number.** Measure motion from the person's own recording: pull the frames with `ffmpeg` at full rate, track the region frame by frame and fit the curve. Where the measurement and their eye disagree, the eye wins and the number moves: a band measured 90% done by 400 ms still read "way too slow" at 500 ms.

## Ouro apps

For an app built on Ouro, the watch mode that reruns the checks on every edit, decisions recorded in `ouro-check.json` and the not-designed veil are in the "Live iteration" section of the [Ouro design-craft guide](https://ui.ouroboros.bot/docs/design-craft/). Follow it instead of rebuilding them.

## Red flags

| Thought | Reality |
|---|---|
| "I'll send a screenshot and ask what they think" | That is the round trip this skill removes. Give them the live URL. |
| "I'll open the page for them" | Never open windows on their screen. Hand the URL to whoever holds their view. |
| "Several notes touch the same file, I'll do them together" | One note, one edit, one reply. Batches drop things and bring back rejected ones. |
| "I'll eyeball the spacing after each edit" | A decision about spacing is a check. Write it once. |
| "My measurement says it's fine" | If their eye disagrees, the eye wins. |
