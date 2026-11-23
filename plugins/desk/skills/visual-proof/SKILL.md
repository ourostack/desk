---
name: visual-proof
description: Use before you send, show, attach or caption any screenshot, capture, image, mockup, recording or rendered page (in chat, a pull request, a report or an update), including one someone else made, before checking or reviewing how output looks (alignment, spacing, clipping, contrast, counts), and whenever work changes something a person sees.
---

# Visual proof

## Measure what a check can measure

Never check by eye what code can measure: alignment, spacing, clipping and overflow, contrast, colours against the design tokens, counts, and text against its source. Write the check as code (a script, a test, a lint, a layout assertion in the renderer), run it, and report its output; agents are unreliable at this by eye, and a script gives the same answer every run. Keep the check where the next change will run it, such as the repository's tests or CI. Look by eye only for what no check can judge: whether the screen makes sense, feels right and matches the intent. The same goes for briefing another agent: never ask it to eyeball what a check can measure.

## Look before you show

Look at what you show before you show it. Before handing a person a capture, mockup, screenshot or rendered page, open it at full size and inspect it as they will: content cut off or covered, an alarming or wrong status colour, demo-only or placeholder text, a stale label, shortcut or number, anything that contradicts your claim. Run the measurable checks above first. Then write down what is wrong before you write the caption; "nothing" is a finding you reach after those checks and a full look, not before them. Fix what they would catch, capture again, and only then show it. When there is a reference (an approved mockup, a canonical image, the previous capture), compare against it side by side yourself. A capture you have not looked at is not proof, and passing one on unexamined hands the person your review.

## Capture it

Capture visual proof by default whenever work touches something a person sees: a screen, a setting before and after a change, an agent's reply, a refusal, an error, a result. The rule follows what the work touches, not what it is called ("spike", "look into", "review"), and a brief's silence never waives it. Capture as you go, at each stage, including working or doing logs and intermediate milestones such as pull request opened, reviewed, or merged states. When a milestone claims a rendered, installed, merged, rollout or other consumer-visible state, capture that real result, not a terminal success line. It supplements rather than replaces tests, logs and system-of-record readback. Capture only the relevant bounded view, never secrets or sensitive/private content; if capture is impossible, record why and use the strongest safe alternative. Nonvisual work gets no artificial screenshots. Put the proof inline where the reader looks (the pull request body, milestone report or delivery message), not only as a link to an artifact; for an agent-side change, the agent's actual reply or the command output showing the changed behaviour is the proof. Run the scenario on synthetic data, never on the human's own real data or account ("Offline evals on synthetic data, online evals from counts") and never on real data that would expose colleagues or customers.

Every picture says what to notice. Give each one a short caption: where to look, and what changed or what it proves, in plain words. For example: "Bottom card: a reply in the thread now notifies you; before, only @mentions did." Mark the spot with a box or an arrow when that's easy, and crop to what matters. A picture without a "what to notice" caption isn't proof.

## Privacy-safe rendered proof

If a real capture would expose private messages, identities, customer data or secrets, do not upload it. Reproduce the changed surface through the actual product renderer with safe, owned, made-up data in an isolated fixture or test account already authorized for this work, then capture that real render. Prefer a bounded crop that excludes private content when it still proves the claim. Check the pixels and metadata before sharing; do not copy private content into fixtures.

Label the inline capture `Synthetic-data capture` and state what it demonstrates and what it does not: for example, “Synthetic-data capture: the changed renderer with made-up entries; does not verify private account integration.” Keep test/log evidence for behavior outside that scope. A drawing, AI-generated mock, reconstructed screenshot or screenshot of a different implementation is not proof of the running product. A synthetic render cannot prove a private live run, installed state, merge or rollout.

If neither a safe bounded capture nor a real synthetic-data render is possible, record the reason and the strongest safe alternative, but do not call the visual claim verified. PR creation and readiness remain subject to [`pr-surface-hygiene` PSH-010](../pr-surface-hygiene/SKILL.md#psh-010--visual-proof-blocks-creation-and-readiness); a visible change stays blocked rather than acquiring a false `No visual change` reason.
