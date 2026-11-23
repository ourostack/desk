---
name: prior-art
description: Use when work draws on something that already exists, such as another app, a competitor, a prototype, a Figma or other design file, or a screenshot or example someone shares, before building a method, benchmark, explainer or tool that someone may already have published, and before you create a component, module, helper or file that resembles one the codebase already has.
---

# Prior art: steal, don't copy

Before building a method, benchmark, explainer or tool, find existing published work and cite it; adopt what fits, build only the gap and say how yours differs. Then, for any prior art the work draws on (another app, a prototype, a design file, a competitor, a screenshot someone shares), steal, don't copy. Don't reproduce its surface: its layout, wording or feature list. Work out why it works for the people who use it and make that reason yours, so thoroughly that the result is no longer theirs. Every element you keep earns its place in your design or goes. Name what you took and, piece by piece, why it works for your people, in the design note or pull request and in your reply, so a reviewer can judge the borrowing.

For example, someone shares a competitor's dense, borderless list and asks for "ours, the same way". Don't ship that list. Ask what each trait does for its users (density lets a person scan 40 rows at once; icons at the left let the eye run down one column), check whether your people have the same need, keep what does that job for them, drop what doesn't, and say which is which in the design note.

## Extend what exists; don't duplicate it

Before you create a component, module, helper or file, search the codebase for one that does the same job or nearly so. If one does, make it more flexible (a prop, slot, variant or option) and use it; a copy is a second thing to keep in step, and copies drift. Ari Mendelow, the owner: "generally, when we can reuse a component, we MUST", and "otherwise, we get crazy drift. always opt for making a component more flexible over making a duplicate component". Build a new one only when no existing one can take the difference without breaking its other users, and say in the pull request what you searched and why nothing fit. For an Ouro UI screen, the same rule is step 13 of the [Ouro design-craft guide](https://ui.ouroboros.bot/docs/design-craft/).
