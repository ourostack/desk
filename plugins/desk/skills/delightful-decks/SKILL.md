---
name: delightful-decks
description: Make a presentation deck beautiful and engaging, one that surprises and delights, for a person who will present it live. Use when asked to make, redo or polish slides for a talk, meeting or demo, or when a deck is judged dull, wordy or cluttered. Not for turning a finished document into slides with a script; use a document-to-deck skill for that if one is installed.
---

# Delightful decks

A deck is a visual aid for a person who talks. The audience should feel something on every slide, and the presenter carries the explanation. The usual failure is a deck that is correct, tidy and fits on every slide, and still scores 2 out of 10 because it explains instead of showing.

Turning an existing document into slides, with speaker notes and a script, is a different job. If that is the ask, use a document-to-deck skill if one is installed, and use this skill's bar for the look.

## The bar

Check every slide against this list. The builder's own checks, such as "it fits, nothing overflows", prove layout, not quality, and never stand in for this list.

- [ ] **Visual aid, not explainer.** Nothing the presenter will say is on the slide. The presenter talks; they won't read a script or speaker notes.
- [ ] **Only the words that must be there.** No credit lines, captions, footers, source lines, labels or explanations. A diagram names its parts and says nothing else.
- [ ] **Surprises and delights.** Every slide has beautiful art: as the hero, or around and behind a screenshot or diagram. No slide is just text on a plain background.
- [ ] **It breathes.** Huge type, generous empty space, one idea per slide.
- [ ] **Soft depth only.** Subtle shadows or none. No heavy drop shadows and no hard frames around screenshots.
- [ ] **Titles wrap like speech.** Two-tone titles work well, but each line is a natural phrase with enough words that the break makes sense. No lines of one or two stranded words.
- [ ] **The real thing, unredacted.** If the audience may see an artifact, show the whole artifact, large. Don't crop it to its title or blur it.
- [ ] **Ideas visualized.** Prefer generated art that shows the idea over a screenshot of a tool's interface. Use a screenshot only when the screen itself is the point.
- [ ] **The right promise.** A teaser or overview shows what to expect and why it matters; it doesn't teach the steps. Steps live in the guides.
- [ ] **One story.** Lead with the one problem being solved. A timeline or history usually matters less than that.
- [ ] **One visual language** across every slide and every presenter's file.

## The process

1. **Agree the spec with the presenter before building anything.** Write it slide by slide: the slide's job, its art, and the exact words on it, which are the only words that will appear. Settle the audience, the length, and whether it's a teaser or a lesson. Record every explicit decision the presenter makes, such as "no credit lines" or "names only on the diagram"; that list governs every later review. Rebuilding a deck the presenter never agreed to is the costliest loop.
2. **Set the visual language once.** Write a short art direction: palette, materials, mood, how people and objects look, and a style block that every image prompt reuses verbatim with only the scene changed. Continue any existing art the audience already knows.
3. **Build in parallel streams** (`work-orchestration`), each writing to its own folder so they don't collide:
   - **Art:** generate every image to the art direction. Never put text in a generated image, because image models garble letters. Leave calm negative space where the words will go, generate at 16:9, and reject any image with garbled text, extra limbs, clutter or a cheap look.
   - **Diagrams:** draw them in HTML or SVG and render to PNG, so the text is real, sharp and spelled right.
   - **Screenshots:** capture the real screens, unredacted, cropped to the point the slide makes. Float them on art with soft shadows.
   - **Content research:** find and verify every figure, quote and name on a slide, with an as-of date (`evidence-discipline`). Words and numbers come from evidence, not from the builder.
   - **Deck builder:** assemble the deck from the spec with a deck-building tool, and rebuild from source instead of hand-editing the output.
4. **Render and look at every slide at full size** against the bar. A contact sheet finds outliers but hides bad wraps, heavy shadows and garbled art.
5. **Run the review panel** (below) and apply what survives the filter.
6. **Ship in small batches.** Push each usable version to where the presenter can open it, and tell them which slides changed. When several presenters each share their own screen, give each one a separate file in the same visual language, and end the first file on a clean handoff slide.

## The review panel

Before the presenter sees a round, simulate the room. Brief one reviewer per persona with the rendered slides, the audience, the deck's purpose and the bar:

- someone non-technical meeting the subject for the first time;
- a practitioner who will use what's shown;
- a deep-technical expert who will catch anything wrong;
- a leader deciding whether this matters.

Each reviewer reports, slide by slide, what they noticed first, what delighted them, what confused or bored them, and what looked cheap or wrong.

**Filter before applying.** Drop any feedback that conflicts with the presenter's recorded decisions. Panels tend to ask for more words, labels, captions and explanation; the presenter cut those on purpose, so don't add them back. Keep what makes a slide clearer, more beautiful or more correct within the bar, apply it, and render again.

## Failure modes

- **Explaining on the slide:** paragraphs, bullet lists, scripts and labels that repeat what the presenter will say.
- **Treating the fit check as taste:** "nothing overflows" passed while the deck still failed.
- **Text-only slides,** or art shrunk to a thumbnail in a corner.
- **Cramped type:** small text filling the slide instead of huge text in open space.
- **Heavy chrome:** thick drop shadows, borders and frames around everything.
- **Broken wraps:** two-tone titles split into lines of one or two words.
- **Redacting what the audience may see,** or cropping the artifact until only its title remains.
- **Text in generated images,** or art that leaves no room for the words.
- **Teaching in a teaser:** step-by-step instructions where the audience needed to know what to expect.
- **Big-bang delivery:** one large drop after hours of silence, instead of small batches the presenter can steer.
- **Re-adding cut words** because a reviewer asked for them.
