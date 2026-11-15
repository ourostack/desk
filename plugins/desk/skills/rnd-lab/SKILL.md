---
name: rnd-lab
description: Use when asked to stand up an R&D lab, run a bunch of spikes, do R&D on an engineering problem, prototype a few approaches before committing, or try several routes to see which one works. Not for experiments that test a customer hunch, which have their own owner and records.
---

# R&D lab

An R&D lab is a set of spikes that ends in a design. It exists to find out what works before anything durable is built, so the code is throwaway and the learning is not. One spike to feel something out is `superpowers:brainstorming`'s "Spike to feel things out"; this skill is for many of them, run in parallel and watched by someone who may be away.

## One spike, one file

Make a lab folder the operator can read (in the repository on a branch, or on the desk) with one file per spike: `<lab>/spikes/<nn>-<slug>.md`. Parallel lanes then never edit the same file. Nobody hand-edits a shared index; if the operator wants to watch, generate a page or table from the files.

Each file holds, in this order:

1. **Question.** One sentence a spike can answer yes or no.
2. **Pass bar.** The result that counts as yes, with numbers, written before the spike runs and never changed after. A changed bar is a different spike: add a new file.
3. **Status.** `queued`, `running`, `passed`, `failed` or `blocked`.
4. **Routes.** One row per route tried: what you did, the outcome, and why it came out that way.
5. **Evidence.** The command, its output and the commit, so a reviewer can rerun it. Label anything you are inferring as inference (`desk:evidence-discipline`).

## Spike rules

- The code is throwaway: no plan, minimal tests, no polish. Keep it in the lab folder, never in product code.
- Use made-up data shaped like the real thing: the same sizes, fields, skew, duplicates and bad rows. Never point a spike at production data or services.
- Check the evidence against the pass bar before you write `passed`. Write `failed` only when the question is answered no, with the reason.

## When it doesn't work

Every "that didn't work" gets three steps, in this order:

1. **Find why.** Read the error, the source or the docs until you can say what happened and why. Label a guess as a guess.
2. **Change the route.** Think outside the box: a different tool, a local stand-in for a service you can't reach (a container, a fake, an in-memory version), the same idea built another way, a smaller version of the question (measure the part you can reach, such as the network round trip to a vendor's public endpoint without its key), or the opposite approach. Add a row to the routes table and try it.
3. **Repeat** until the question is answered or every route inside what the operator granted is tried.

Never write "I'm blocked, I need a human to tell me what to do" while an untried route remains. The access you were given limits where you may run, not what you may learn: if the only database is behind a pooler that breaks the feature, run the same test against a local one and say which environment each result came from. Set a spike `blocked` only when its routes table shows what you tried around it and the one thing only a person can give, such as a credential, spend or an approval. Then carry on with the other spikes.

| Thought | Reality |
|---|---|
| "The environment doesn't allow it, so the spike is done" | Route around it with a stand-in and record which one you used. |
| "I'll report it as unvalidated and move on" | Unvalidated with routes untried is unfinished, not a result. |
| "I should ask before trying another approach" | Another approach inside the grant needs no ask. |
| "One shared log keeps it neat" | Parallel lanes collide. One file per spike. |
| "The spike works and is tidy, I'll keep it" | Keeping it is a new request that goes through the design. |

## Running lanes

Group related spikes into lanes and run the lanes in parallel, each with its own subagent that owns its spike files. Give every lane the shared made-up data and the pass bars. Where the operator allows it, have a subagent reviewer check each lane's evidence against its pass bar, instead of waiting for a person.

## Ending the lab

A lab ends in a written design, not in spike code. Write it the way `superpowers:brainstorming` writes a design: the chosen approach, the options the spikes ruled out and why, and what each result rests on, linking each spike file. Have an independent reviewer agent read the design and the evidence before the design is called finished (`desk:independent-review`). The spike code stays labeled throwaway; building the chosen approach for real is new work that starts from the approved design.
