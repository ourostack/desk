---
name: operator-voice-comments
description: Invoke before anything is sent or scheduled in the operator's name (a chat message, email, calendar invitation, PR or work-item comment or description), when drafting in their voice, and when asked to humanize text or make it sound less AI-written. Owns the approval rule and the voice rules. Not for commit messages or your own replies.
---

# operator-voice-comments

This skill owns everything sent or scheduled in the operator's name: the approval rule applies to every such send, and the voice rules apply wherever you draft that content. `pr-feedback-on-own-pr`, `pr-surface-hygiene`, `pr-self-review` and `peer-pr-review` use it at their drafting steps; the calling skill owns the workflow and the surface choice. When the ask is to make text sound human or less AI-written, follow `human-voice.md` beside this file as well.

The operator's name rides on every word under their account. The agent's default prose is the opposite of a direct human voice: softer, longer, hedged, padded with retreats and inferred mechanism claims. The rules below correct that drift.

For ownership of authorized work in the operator's voice, apply Plain Language's [Attribute work to the person](../../../plain-language/skills/plain-language/SKILL.md#attribute-work-to-the-person). The approval rule below still governs sending.

## Approval before anything is sent

Anything sent or scheduled in the operator's name — a chat message, an email, a calendar invitation, a PR comment or description, a work-item comment — needs the operator's approval of the exact audience and content before it goes. A "go" on the work is not approval to send; neither is an earlier approval of different wording or a different audience. Show the final audience and text, wait for a clear yes, and send exactly that. When the operator has seen the final audience and text and says "send it", that is the approval; do not ask again. First-person future phrasing such as "I'll send it" leaves the send with the operator (`interaction-style` §6). An action in the agent's own role that does not speak for the operator, such as a work-item state change or a bot or channel-role update, follows `preflight-actions` instead.

Before you show a draft, check it with a zero-context reviewer (below), so the operator sees a clean draft and any open judgment call at once. The review never replaces the approval.

## Surfaces in scope

In scope: replies in reviewer threads, top-level PR comments, PR descriptions you draft or audit, work-item comments and descriptions, group-chat messages, and emails and calendar invitations in the operator's name. Out of scope: skill, planning and doing prose, commit messages, your own replies to the operator, friction entries and cards.

Most surfaces render Markdown. Some chat systems collapse newlines and bullets into one block; check what the target renders and adjust the shape (an overlay may document the system's quirks).

## Anchor placement

Anchor a PR comment in the operator's voice to the most specific file and method it concerns. An anchored comment sits beside the code during follow-up, survives re-pushes and shows up when a reviewer scans unresolved threads. Architectural, scoping and contract concerns still have a file where they land hardest; if a concern spans files equally, anchor at the most central one and say it is cross-cutting. Use a top-level comment only for a status post ("ready for re-review"), a point about the PR's existence or framing ("this should be two PRs because X"), or a reply to a top-level question.

## Two registers

Surfaces a third party reads cold, possibly months later (PR descriptions, work-item comments, thread replies), take the formal register: rationale first, no double punctuation, no chat contractions. Live chat between collaborators (group chats, DMs, channel threads) takes a warm, loose register:

- **Lead with thanks.** Open a nudge to reviewers with "hi <name>!! thanks for <X>" before the ask, so the ask reads as a favor, not a debt.
- **Dual ask.** Pair "more thoughts there or if we can resolve", inviting both input and closure, not "lmk when you've got cycles".
- **Invite more at the close** ("also let me know if you have more feedback"); do not close with "no rush".
- **Markers** such as `!!`, `y'all's`, `lmk`, `wdyt`, lowercase openers and "sweet" fit chat and read as unprofessional in a PR.

| Transactional | Collaborative |
|---|---|
| "Hi both — replies are up on the last 3 active threads. lmk when you've got cycles 🙏" | "hi both!! thanks for reviewing — have 3 comments still open awaiting y'all's resolution. lmk if you have more thoughts or if we can resolve" |
| "Reminder: PR <id> has X open threads from you" | Do not send a reminder; send the thanks-first version. |

For a hybrid surface, follow its main read mode (live between peers, or cold and formal); if unsure, ask the operator which it is for.

## No fabrication

Never attach a fact-shaped claim the operator did not supply and cannot verify to their name.

- **History.** Verify any reference to past events ("the recent X cleanup", "we hit this before with Y") in the desk, chat history, the operator's documents or the tracker before naming it. If you cannot, gesture without specifics ("the recent cleanup of overlapping ID names") or drop it; a recommendation stands on its own merits. Test: if a reviewer asked "where is that documented?", could you point to the source?
- **Calendar timelines.** Put a timeline ("60-day follow-up", "revisit in Q3") on a lasting surface only if the operator named it. Otherwise frame follow-ups on data ("once usage telemetry lands", "after 100 events"). When an existing title carries a timeline the agent invented, ask before reusing it.
- **Estimates.** A duration, cost or scope number ("~2 hr", "~3 PRs") follows `evidence-discipline` "Fixtures or refusal", including one that rode in from another agent's plan.
- **Code mechanism.** Verify every step of a chain like "X happens because Y, so Z is discarded" by reading the exact lines. Phrases such as "probably returns null", "the typical pattern is", "it likely does X" mean the claim is inferred. Read the function, trace each `try`, `catch`, `return` and `throw`, or drop the mechanism, ask it as a question ("what does the outer catch do with X?"), or cut the comment.
- **Static-analysis claims** (dead code, unreachable, cannot be null) need the analyzer, not a read: exception filters (`catch ... when`), async state machines, method tails and retry wrappers fool hand tracing. Run the build (for example `dotnet build`, with warnings as errors if the repo sets it) or ask "is this reachable?" instead of "remove this dead code".
- **Bot urgency.** SLA badges, queue age and bot nudges are the bot's clock, not the author's. Do not write "the author is waiting" or "we should move fast" unless the operator confirmed pressure; their "no rush" overrides any bot signal.
- **Business-model claims.** Before critiquing pricing, charging, quota or budget flow, ask who covers the cost if the change lands, which layer is the real lever (rate limits and budget caps bound abuse, not unit price), and what the customer's contract implies. If a check fails, reframe to the real lever or drop the draft.

## No padding

Padding puts words in the operator's mouth, pre-writes the recipient's answer and reads as not their voice.

- **Cut pre-emptive accommodation:** "happy to", "would you be open to", "would it be possible to", "if you have time", "no pressure", "if it feels", "if you'd like", "feel free to", "totally fine to".
- **Cut pre-emptive scope defense and concession** ("strictly scoped to X", "happy to file separately", "no need to address now") unless the recipient has pushed back on scope before.
- **Add value or stay quiet.** Before following on in a thread, check that the comment adds new substance (a claim, a number, a cross-team angle, a counter-proposal), that the thread would not reach it anyway, and that the operator has context the thread lacks. If not, drop it.
- **Respect expertise.** Do not explain the author's own code back to them, anchor feedback on test names, or give a system owner a tutorial or a tour of links they already use. Give the evidence trail: the two or three queries or facts behind the diagnosis and what each shows.
- **No trailing period** on the final sentence of a PR comment of any length (internal periods, `?` and `!` stay). The operator removed every one on six of six comments in one review.
- **Soften recommendations.** Prefix "consider" or "suggest", or end with `?`. A bare "worth adding X" reads as a directive; this is the operator's most common edit.
- **No internal vocabulary.** No agent skill or phase names (`pr-self-review`, "Phase 7", "the convergence loop"), no abbreviations the reader does not use ("impl-PR"), no track slugs, phase or deliverable numbers, iteration labels, private names for public artifacts (use `#<id>` or the URL), reviewer-group nicknames, or code-flag descriptors outside their code context ("the hardened endpoint"). Describe what is happening in terms the reader can decode. Test: would a reader who never saw the desk understand every sentence?
- **Send what was approved.** No added subject line, header field, emoji, bold metadata or reformatting; if the approved draft says "hi all!!", send "hi all!!". A rendering choice that preserves the approved content (such as an HTML content type so line breaks show) is yours to make.

## Match the operator's voice

- **Ask, then the reason, in one sentence:** "why drop the cancellation token here — pattern elsewhere in this layer threads it through".
- **Use their prefixes and casing.** If they write "nit:", "naming:" or "q:", or write in lowercase, match it on every line, bold leads included. Backticked identifiers keep their casing, and formal wide-audience surfaces get normal capitalization.
- **Questions are questions** ("is there a reason we don't try all channel team members?"); decisions are statements ("swap to the all-members path — current shape misses the SMB case"). Not "I wonder if we might consider".
- **One ask per comment.** Two concerns are two comments.

| Operator voice | Padded |
|---|---|
| "naming: X → Y? reads as A rather than B" | "Quick naming nit (no pressure!): would you be open to renaming X to Y? It could be slightly clearer." |
| "is there a reason we drop the cancellation token here" | "I see that CancellationToken.None is being passed here. Could you help me understand why we don't propagate the token like similar code elsewhere?" |

## Verify before you show the draft

Run both reads on every draft:

- **Voice test.** Read it aloud as the operator. Cut anything apologetic, more deferential than their real posture, or retreating before anyone objected.
- **Dial test.** Read it as the recipient, with no session context. For each factual claim ask: "if they push back, do I have evidence?" If not, verify it, soften it to match the evidence, or cut it. Hedging ("I think", "probably", "if I'm reading this right") does not rescue an unverified claim; it signals the check was skipped.

Then hand the draft and this skill's rules, nothing else, to a zero-context reviewer. Ask whether it reads evergreen and audience-first (`pr-surface-hygiene`), leaks internal names, paths or session details, describes any commit accurately, matches the operator's voice and holds to every no-fabrication rule. Fix what it finds. Show the operator the final audience and text with only the judgment calls the reviewer could not settle (cross-team implications, timing, something the operator has not seen yet, a surface you have never posted to); the send waits for their approval.
