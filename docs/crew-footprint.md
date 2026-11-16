# Crew's footprint against Epoch 3

What every part of the `crew` plugin costs an agent that never uses it ("always on"), what it costs once used, and how often it is used. The standard is the [Epoch 3 RFC](../plugins/desk/docs/agentic-engineering-v3-rfc.md): a tiny always-on context, a skill that costs only its name and description until used, no guards or rituals, one home for each piece of knowledge, and a CLI plus README over a tool server.

## What Crew puts in front of an agent

Crew has no hook and no tool server of its own. Its always-on cost is its skills' name and description, plus the pieces of Desk that exist for it.

| Surface | Always-on bytes | Where |
|---|---|---|
| Skill name and description, 7 skills | 1568 | `plugins/crew/skills/*/SKILL.md` front matter |
| `note` tool: description and input schema | 444 + 863 | `plugins/desk/mcp/src/tool-names.js`, `tool-schemas.js` |
| Session start, in a Crew workspace: the person line | about 50 | `boot-text.js` |
| Session start, only while a teammate has left a note: the instruction and up to five list lines | about 490 + 90 per note | `boot-text.js` |
| `crew.js` (`status`, `start`, `join`, `initiative`) | 0: a CLI the skills name | `plugins/desk/mcp/scripts/crew.js` |
| Hooks | 0 | none |

The `note` tool and the boot lines are not Crew's to cut: a note has to reach the next session, and the tool's description is the only guidance now that its skill is gone. They are listed so the total is honest.

## Usage

The repository holds no per-skill telemetry, so "how often" comes from the one eval suite that exercises Crew, `crew-shared-initiatives` (6 cases), and the tools' own tests. The tool requests the runs kept show which skills the subject agent loaded (one run of the unchanged skills, before this change):

| Skill | Loaded in the 6 cases | Other evidence |
|---|---|---|
| `shared-desk-conventions` | 6 | `shared_desk_saved.test.js`, `content_routing.test.js` |
| `shared-initiative` | 5 | `initiative.test.js`, `crew_cli*.test.js` |
| `perspective-query` | 1 (the one case that asks what is decided) | none |
| `join-crew` | 0 | `workspace_join.test.js` and the other `crew/` tests drive the script it names |
| `start-crew` | 0 | `workspace_setup.test.js` and the other `crew/` tests drive the script it names |
| `roster` | 0 | none |
| `leave-note` | 0 | `note` tool tests |

## Decision for each

| Skill | Always-on before | Body before | Decision | Reason |
|---|---|---|---|---|
| `shared-desk-conventions` | 213 B | 23793 B, 208 lines | **Shorten** to 7.8 KB and absorb three skills | Loaded in every case, so it should be small. It restated the layout, the write protocol and the lessons rules several times, repeated what `desk:directory-structure`, `desk:content-routing` and `lesson_add` already say, and carried a long refusal-shaped paragraph on cross-desk writes. The description now also fires on the questions the merged skills answered. |
| `perspective-query` | 172 B | 7746 B, 70 lines | **Merge** into `shared-desk-conventions` | Loaded once in six cases. It re-stated the taxonomy it reads against, so it held the same knowledge twice. Its four question shapes now take a paragraph each. |
| `roster` | 159 B | 2273 B, 28 lines | **Merge** into `shared-desk-conventions` | Never loaded; "who is X" is a question about people, which that skill already answers, and the roster is a shared path the skill's write rule covers. |
| `leave-note` | 189 B | 3972 B, 51 lines | **Delete** | The `note` tool's description and the boot instruction already say when to leave a note, how to write it and when to acknowledge it. The reply says what happened. The remaining judgment (your own voice, nothing private) is two sentences in `shared-desk-conventions`. |
| `shared-initiative` | 478 B | 7699 B, 68 lines | **Shorten** | The description listed every trigger twice, so it cost three times the others. The body repeated its own rules in two places. |
| `join-crew` | 172 B | 19226 B, 111 lines | **Shorten** to 7.3 KB | It carried a nine-step migration of Epoch 1 Crew workspaces that the script does not run, and a paragraph per script result where the script's own `message` already says it. |
| `start-crew` | 185 B | 10421 B, 75 lines | **Shorten** to 5.6 KB | Same: the results are each a clause now, and the placeholder-content move is three steps. |

## Before and after

| | Before | After |
|---|---|---|
| Crew skills | 7 | 4 |
| Always-on skill name and description bytes | 1568 | 898 |
| Skill body bytes (loaded on use) | 75130 | 25837 |
| Skill body lines | 611 | 221 |

Hooks and tool servers: none before, none after. The `note` tool and the boot lines are unchanged.

## Checking the triggers

The `crew-shared-initiatives` suite is the check. The deleted skills were never a source of its cases' behavior except `perspective-query`, so it came out of the suite's sources. The suite was rerun on the new skills with the repository's own runner and its receipt rewritten from that run, not edited (`evals/receipts/crew-shared-initiatives.json`).

Result on the new skills: 20/20 checks across 6 cases (baseline 20/20), receipt written by the runner. Triggers for teammate-perspective and roster questions now land on `shared-desk-conventions`.
