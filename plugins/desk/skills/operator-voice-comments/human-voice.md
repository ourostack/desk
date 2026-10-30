# Human voice

Use this when the person asks to humanize text, make it sound less AI-written, write like a person, or explain why a draft reads as robotic. Plain Language still applies, and anything sent in the operator's name still needs approval (`SKILL.md`). Keep every fact, quantity, qualifier and warning. Condensed from [harshaneel/humanize](https://github.com/harshaneel/humanize) (MIT, © 2026 Harshaneel Gokhale; see `LICENSE-humanize` beside this file).

## What reads as machine-written

When humanizing attribution of authorized work, apply Plain Language's [Attribute work to the person](../../../plain-language/skills/plain-language/SKILL.md#attribute-work-to-the-person).

Detectors and readers react to the same signals: predictable word choice, uniform sentence length, hedges, lists for everything, generic claims with no anchors, and the polite "helpful assistant" voice. Move every signal in the human direction, not just one.

## Rewrite rules

- **Words.** Pick the word a practitioner in this field would use ("flush the buffer", not "clear the temporary data storage"). Use one name for one thing and a pronoun for variety, never a cycle of synonyms. Prefer "is" and "has" to "serves as", "stands as", "boasts" or "features".
- **Rhythm.** Vary sentence length on purpose. Every few sentences, use a very short one. Let another earn its length. Never write three sentences in a row of about the same length, and pair a run of short sentences with a longer one.
- **Hedges.** Delete "it is important to note", "generally speaking", "in many cases", "it can be argued" and "typically" unless they carry real uncertainty. When uncertainty is real, say what you are unsure of. Do not announce a point ("The key insight:"); make it.
- **Filler.** "In order to" becomes "to", "due to the fact that" becomes "because", "prior to" becomes "before", "has the ability to" becomes "can", "make a decision" becomes "decide".
- **Structure.** Use prose where the items flow; keep lists for genuinely parallel or ordered items. Do not recap what you just said. Drop these scaffolds: "It's not X, it's Y", "more X than Y", either/or framing of a spectrum, tricolons, anaphora, chiasmus, "turns out", "What changed was X", thesis-first openers, and the four-to-seven-word aphorism that closes a paragraph ("That's the part that stuck."). Real trade-offs are asymmetric; say which side wins.
- **Specifics.** Anchor abstract claims with real numbers, names, dates and examples from the source. Never invent them. If the input has no anchors and no writing sample, say so and ask for specifics or a sample, or for confirmation to go ahead anyway.
- **Voice.** Use first person, direct address and contractions where the register allows. Cut the assistant register: "Let me walk you through", "Great question", "I hope this helps", "Let me know if you'd like more", knowledge-cutoff disclaimers, unrequested option lists and caveats on every claim. Pick a position.
- **Transitions.** Drop "Furthermore", "Moreover", "In addition to the above", "It is clear that", "As previously mentioned" and "This highlights the importance of". Let the next sentence follow, or use "and", "also" or "so".
- **Punctuation.** At most one em dash per 300 words, and never a pair wrapping a clause. Replace semicolons with a period or "and", "but" or "so", except in lists whose items contain commas. Put a colon only after a complete sentence. Use straight quotes and apostrophes unless the publication's house style is typographic.

## Words and phrases to remove

delve, leverage (verb), utilize, robust, comprehensive, streamline, foster, facilitate, pivotal, nuanced, multifaceted, crucial, garner, vibrant, tapestry, testament, interplay, intricate, landscape (abstract), showcase, underscore, highlight (verb), notably, in today's fast-paced world, in conclusion, at the end of the day, at its core, needless to say, stands as a testament to, marks a pivotal moment, evolving landscape, setting the stage for, plays a vital role, nestled in the heart of, breathtaking, renowned for, groundbreaking, a myriad of, a plethora of, in the realm of, the real question is, fundamentally, let's dive in, let's break this down, here's what you need to know, without further ado, great question, you're absolutely right, certainly, happy to jump on a call, feel free to reach out, vague attributions such as "experts argue" or "industry observers have noted" (name the source or drop the claim).

## Register

- **Technical:** domain vocabulary, real tool names, versions and error messages, short sentences for definite claims ("This is O(n²). Don't do it at scale.").
- **Essay or blog:** open on a scene or moment, let the argument emerge, allow a deliberate fragment, admit a changed mind.
- **Business:** no throat-clearing; the ask in the first two sentences; numbers and deadlines; short paragraphs.
- **Chat or Slack:** fragments, numerals with approximations (`~3 days`), common abbreviations, lowercase where the team writes that way, and a structure that actually breaks instead of accomplishment, caveat, next steps.

## Protocol

1. Read the whole input. Note the audience, register and length. If the person gave writing samples, list five to ten specific habits from them (sentence lengths, openers, punctuation, recurring phrases) and match those instead of these defaults where they conflict.
2. Rewrite in one pass with real structural change, not light editing.
3. Check before output: em dashes, semicolons, the word list, "more ... than" and "not X, it's Y" framing, sentence-length runs, at least one anchor per paragraph, and a consistent voice.
4. For more than about 150 words, ask "what still reads as AI?", name two or three remaining patterns, and fix them once. Remove a flagged pattern rather than justifying it; if a paragraph is too thin without it, merge or cut the paragraph.
5. If the output is under half the input's length, do not pad it. Add one line after the text saying it is shorter because the input was mostly filler, and that specific anchors would let it grow.
6. Output the rewritten text only, with no preamble or change notes unless asked.

This guidance cannot guarantee a low score on any detector, and it never changes the facts, only how they are said.
