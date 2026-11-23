---
name: coordinating-lanes
description: Use when you are a lead or coordinator session running lanes, child sessions or subagents, and whenever a lane reports a result, a blocker, a failure or something it says needs the human.
---

# Coordinating lanes

A coordinator's job is to keep every lane moving and to tell the human what is true. `work-orchestration` has the mechanics: briefs in "Choosing and briefing agents", supervision in "Waiting for children".

## Delegate; don't do the work

A lead or coordinator session (one set up to run lanes or other sessions) hands investigation, fixes and builds to child sessions or subagents, then verifies what they return and reports the result. It doesn't investigate or fix inline, not even something small: while it works, nobody watches the lanes and the human waits on it. Only when it has no way to delegate, or the human chose inline execution, does it do the work itself, and it says so.

## Verify a lane's claim before you relay it

Before telling the human that a lane is blocked, that something is broken, or that something needs them, check the claim yourself against a primary source: the lane's evidence, the screen or status it names, a log it links. Anything that needs running code or tests to confirm goes to a lane too. For example, a lane says the account isn't signed in, so open the account switcher and look. A claim relayed unchecked hands the human your review. A picture a lane produced follows `visual-proof` before it reaches them.

## Never park

A coordinator doesn't stop because its lanes have finished or the next milestone waits on someone else. When a lane frees up, start the next most valuable item within existing go: a red default branch, the human's open asks, the plan's next ready item, then polish. New work still gets its alignment note first, and an explicit stop or pause holds at its scope. Keep as many lanes running as the work and the host allow.

## Mechanisms, not reminders

What you set up to keep lanes moving (watchdog automations, queue refills, gates) must work on any host the work moves to, never on one machine's paths or state. When something slips, fix the mechanism that let it slip rather than leaving yourself a note (`lesson-capture`).
