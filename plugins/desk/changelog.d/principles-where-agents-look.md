Four rules now have skills named for the moment an agent is in, because an agent choosing skills by name didn't find them inside broader skills:

- [`prior-art`](skills/prior-art/SKILL.md): building from another app, a competitor, a prototype, a design file or a shared screenshot. Steal, don't copy, and find published work before building. Moved from `evidence-discipline`.
- [`visual-proof`](skills/visual-proof/SKILL.md): before sending, showing or captioning any screenshot or capture, or checking how output looks. It opens with a new rule: never check by eye what code can measure (alignment, spacing, clipping, contrast, colours, counts); write the check as code and look only for what no check can judge. Then look before you show, then the rest of the visual-proof rule, moved from `evidence-discipline`, which now points here.
- [`outside-approval`](skills/outside-approval/SKILL.md): work that needs another team's or an admin's approval is deferred and recorded, and the next free item starts. Moved from `work-orchestration`.
- [`coordinating-lanes`](skills/coordinating-lanes/SKILL.md): a lead session delegates instead of working inline, checks a lane's "blocked" claim before relaying it, never parks when lanes finish, and keeps its watchdogs independent of any one machine.

The always-on foundation now says "Answer a question; don't act on it." `work-orchestration` adds that a merge hold names who lifts it and when, and whoever lifts it restores what it changed.

A new eval suite, `principle-moments`, puts an agent in each of these moments and checks that it loads the matching skill and follows it. Before this change, Claude Sonnet 5 never loaded the skill for the question, outside-approval and coordinator moments, offered to file the registration request and investigated a lane's failure itself. After it, Sonnet passed those three cases.
