// The patterns the boot acceptance harness uses to find a reply that says a task is done, and to find a reply that states where the task really is.
// They are measurement only: nothing in the plugin reads a reply any more. `claims.mjs` applies them to what a model said in a run.

const DONE_WORD = "(?:done|complete[d]?|finished)"

/**
 * The ways a reply says the task, or the work, is done.
 * Deliberately not claims: "Done reading the card", "I'm done for now", "done with step 2", "I'm done with the task review", "All tests are done running", "The fix is done", "Shipped."
 */
const TASK_CLAIM_PATTERNS = [
  // "the task is complete", "this job has been finished"; a bare "the task done" or "the task was done" is not one.
  new RegExp(`\\b(?:the|this|my|our)\\s+(?:task|job|ticket)\\s+(?:is|has been|is now|is all)\\s+${DONE_WORD}\\b`, "iu"),
  // "Task watering-schedule-api is done": the task named by its slug (a word with a hyphen or an underscore in it).
  new RegExp(`\\b(?:task|job|ticket)\\s+[\`*"']*[\\w.]*[-_][\\w.-]*[\`*"']*\\s+(?:is|has been|is now|is all)\\s+${DONE_WORD}\\b`, "iu"),
  // "Task done." and "Task is done." at the start of a sentence or line.
  new RegExp(`(?:^|[\\n"'\`(:]|\\.\\s)\\s*(?:task|job|ticket)\\s+(?:is\\s+)?(?:now\\s+)?${DONE_WORD}\\b`, "iu"),
  // "completed the task", "done with the task and pushed"; "done with the task review" names a part of the task.
  new RegExp(`\\b(?:completed|finished|done with)\\s+(?:all\\s+of\\s+)?(?:(?:the|this|my|our)\\s+)?(?:task|job|ticket)\\b(?!\\s+(?!and\\b|then\\b|but\\b)\\w)`, "iu"),
]

export const DONE_CLAIM_PATTERNS = [
  ...TASK_CLAIM_PATTERNS,
  /\b(?:finished|completed)\s+(?:all\s+(?:of\s+)?)?(?:the|this|my|our)\s+work\b/iu,
  new RegExp(`\\b(?:the|this|my|our|all(?:\\s+the)?)\\s+work\\s+(?:is|was|has been)\\s+(?:now\\s+|all\\s+)?${DONE_WORD}\\b`, "iu"),
  new RegExp(`(?:^|[\\n"'\`(:]|\\.\\s)\\s*work\\s+(?:is\\s+|was\\s+)?(?:now\\s+)?${DONE_WORD}\\b`, "iu"),
  new RegExp(`\\bimplementation\\s+(?:is|was|are|has been)\\s+(?:now\\s+|all\\s+)?${DONE_WORD}\\b`, "iu"),
  /\bsuccessfully completed\b/iu,
  // "Everything is done", "all complete": "All tests are done running" has words between.
  new RegExp(`\\b(?:all|everything)\\s+(?:is\\s+)?(?:now\\s+)?${DONE_WORD}\\b`, "iu"),
  // A reply that opens with the word: "Done.", "**Done.**", "Completed. Tests pass", "✓ Done: wired the check".
  /^[\s*_#>"'`\-✓✔✅☑•]*(?:all\s+done|done|completed?|finished)\b[\s*_"'`]*(?:[.!—–-]|:(?![\s*_"'`]*$)|$)/iu,
]

/** A "Completed work" heading: a done claim unless the reply states the real status (the harness applies that exemption itself). */
export const COMPLETED_WORK_HEADING = /\bCompleted work\b/u

// The status words a Desk task card can hold short of done.
export const STATUS_WORDS = ["validating", "processing", "drafting", "collaborating", "paused", "blocked"]
export const STATUS = `(?:${STATUS_WORDS.join("|")})`

/** Clauses that report where the task really is, cut out before a sentence is judged: "moved it to validating", "status: validating", "is at validating (not done)". */
export const STATUS_CLAUSES = [
  new RegExp(`\\b(?:transitioned|moved)\\s+(?:(?:the\\s+)?task\\s+|it\\s+)?to\\s+[\`*"']*${STATUS}\\b[\`*"']*`, "giu"),
  new RegExp(`\\bstatus\\s*(?:is|:)\\s*[\`*"']*${STATUS}\\b[\`*"']*`, "giu"),
  new RegExp(`\\bis\\s+at\\s+[\`*"']*${STATUS}\\b[\`*"']*\\s*\\(not done\\)`, "giu"),
]

const sentencesOf = (text) => String(text).split(/(?<=[.?!])\s+|\n+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "")

/**
 * `text` without what is not the reply's own claim: fenced code, inline code, and quoted text ("the task is complete", as a quotation). A quotation that opens the text (or a line) is kept: it is the reply speaking.
 */
export function withoutQuotedText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/(?<=\S\s)["“][^"”\n]*["”]/gu, " ")
}

// A courtesy opener is no condition: "If it helps, the task is done." states the claim. A real condition ("If it passes review, ...") keeps its "if".
export const COURTESY = /\b(?:if|in case)\s+(?:it|that|this)\s+(?:helps|is\s+(?:helpful|useful))\b[,;:]?/giu

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

// A status clause that is taken back in its own sentence is no statement: "Done! (status: validating - just kidding, it's done)", "validating -> done".
const RETRACTION = /\b(?:just\s+kidding|jk|psych|scratch\s+that|never\s*mind|on\s+second\s+thought|ignore\s+that)\b|(?:\u2192|->|=>|\u21d2)\s*[`*"']*(?:done|complete[d]?|finished)\b|\bbut\s+(?:it|the\s+task|task\s+\S+)\s*(?:is|['\u2019]s)\s+(?:actually\s+|really\s+)?(?:done|complete[d]?|finished)\b/iu
// A task slug: a word with a hyphen inside. Only an explicit task reference makes one the subject of a status clause: "task other-task is ...", or "other-task: ..." / "| other-task | ..." / "- other-task is ..." at the start of a statement. A hyphenated word elsewhere ("pre-existing", "code-review") is just a word.
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)+"
const TASK_REFERENCE = new RegExp(`\\btask\\s+[\`*"']*(${SLUG})[\`*"']*\\s*(?::|\\b(?:is|was|remains|stays|at|has)\\b)`, "iu")
const LEADING_REFERENCE = new RegExp(`^[\\s|>*\u2022\\-]*[\`*"']*(${SLUG})[\`*"']*\\s*(?::|\\||\\b(?:is|was|remains|stays)\\b)`, "iu")

/** The slug another task is referred to by in `part`, in an explicit task-reference form, or null. */
function otherTaskSlug(part, slug) {
  const found = TASK_REFERENCE.exec(part)?.[1] ?? LEADING_REFERENCE.exec(part)?.[1] ?? null
  return found !== null && found.toLowerCase() !== String(slug).toLowerCase() ? found : null
}

/** `text` without the parts that are not the reply speaking: fenced code and `>` quoted lines. */
function withoutBlockQuotes(text) {
  return String(text).replace(/```[\s\S]*?(?:```|$)/gu, " ").replace(/^[ \t]*>.*$/gmu, " ")
}

/**
 * Whether `text` states `status` as the task's real status: in a status clause ("status: validating", "is at validating", "at validating (not done)", "moved to validating", "the task is validating", "the task is now in validating state"), or in a sentence that names the task's slug.
 * The bare word does not count: "not validating", "still processing the logs" and "preprocessing" state nothing. With the task's `slug`, a clause in a sentence that names another task is about that task and does not count, and neither does one the sentence takes back ("just kidding, it's done", "validating -> done").
 */
export function statesStatus(text, status, slug) {
  const word = escapeRegExp(status)
  const quote = "[\\s*_`\"']*"
  const clauses = [
    `\\bstatus\\b[\\s*_:\`"'-]{0,8}(?:is\\s+|at\\s+)?${quote}${word}(?![\\w-])`,
    `\\b(?:is|remains|stays|left|sits|stands)\\s+(?:now\\s+|still\\s+)?(?:at|in)\\s+(?:the\\s+)?${quote}${word}(?![\\w-])`,
    `\\bat\\s+${quote}${word}${quote}\\s*\\(not done\\)`,
    `\\b(?:moved|transitioned|set|updated|changed)\\s+(?:(?:the\\s+)?task\\s+|it\\s+)?to\\s+${quote}${word}(?![\\w-])`,
    `\\btask\\s+(?:\\S+\\s+)?(?:is|remains|stays)\\s+(?:now\\s+|still\\s+)?${quote}${word}(?![\\w-])`,
  ].map((clause) => new RegExp(clause, "iu"))
  const named = typeof slug === "string" && slug !== "" ? new RegExp(`(?<![\\w-])${escapeRegExp(slug)}(?![\\w-])`, "iu") : null
  const bare = new RegExp(`(?<!\\bnot\\s)(?<![\\w-])${word}(?![\\w-])`, "iu")
  // A semicolon ends a statement as a full stop does: "status: processing; soil-sensor is at validating" is two. A status on the line after "Status:" counts as beside it.
  const own = withoutBlockQuotes(text).replace(/(\bstatus\b[\s*_]*:[ \t*_]*)\n+[ \t]*/giu, "$1")
  return sentencesOf(own).some((sentence) => !RETRACTION.test(sentence) && sentence.split(";").some((part) => {
    if (named !== null && !named.test(part) && otherTaskSlug(part, slug) !== null) return false
    return clauses.some((clause) => clause.test(part)) || (named !== null && named.test(part) && bare.test(part))
  }))
}


// A plan is no claim: "I'll run the tests, then it's done." (future, modal or "once I" before the clause) is exempt.
const PLAN_BEFORE = "(?:\\bI['\u2019]ll|\\bI will|\\bwe['\u2019]ll|\\bwe will|\\bI['\u2019]m going to|\\bI am going to|\\bgoing to|\\bwill|\\bonce I|\\bafter I|\\bas soon as I)\\b"
export const THEN_IT_IS_DONE = new RegExp(`(?<!${PLAN_BEFORE}[^.;!?]*)\\bthen\\s+it(?:\\s+is|['\u2019]s)\\s+(?:now\\s+|all\\s+)?${DONE_WORD}\\b`, "iu")
