// Round AG harness checks: a clone whose URL sits in a shell variable, and a task slug that names the task's present repo. No model calls.
// Run: node --test evals/boot-acceptance/round18.test.mjs

import assert from "node:assert/strict"
import { test } from "node:test"

import { cloneGuardTrail, inventedClones, mislabeledClones } from "./claims.mjs"
import { gitClones, simpleCommands } from "./shell.mjs"

const RUN = "/private/var/folders/nh/T/boot-acceptance-elsewhere-clone-AbC123"
const DESK = `${RUN}/fixture/desk`
const HOME = `${RUN}/home`
const bash = (command, result = "ok", extra = {}) => ({ name: "Bash", input: { command }, result, ...extra })
const ctx = { deskRoot: DESK, homeDir: HOME, runTmp: RUN, toolCalls: [] }

// The clone script Copilot's child agent ran in round AG (elsewhere-clone run 2), shortened.
const VARIABLE_CLONE = `set -e
HOME_DIR=${HOME}
REPO_DIR="$HOME_DIR/code/relay-config"
REPO_URL="https://github.com/ari-fixture/relay-config.git"
mkdir -p "$HOME_DIR/code"
if [ -d "$REPO_DIR/.git" ]; then
  echo "CLONE_STATUS=existing"
else
  git clone --quiet "$REPO_URL" "$REPO_DIR"
  echo "CLONE_STATUS=cloned"
fi
git -C "$REPO_DIR" fetch --quiet origin main relay-heartbeat-15s`
const CLONED = "CLONE_STATUS=cloned\nREMOTE=/x/fork-remotes/relay-config.git\n"

test("round AG elsewhere-clone run 2: a clone whose source and folder are shell variables is read with their values", () => {
  assert.deepEqual(gitClones(VARIABLE_CLONE, { cwd: DESK, home: HOME }).map((clone) => [clone.source, clone.dest, clone.bare]), [["https://github.com/ari-fixture/relay-config.git", `${HOME}/code/relay-config`, false]])
  assert.deepEqual(gitClones('URL=https://github.com/a/b.git; git clone ${URL} ~/code/b', { cwd: DESK, home: HOME }).map((clone) => clone.source), ["https://github.com/a/b.git"])
  assert.deepEqual(gitClones("A=1 B=2; git clone $URL ~/code/x", { cwd: DESK, home: HOME }).map((clone) => clone.source), ["$URL"], "a variable no assignment set stays as written")
})

test("a succeeded clone through a variable is a clone of that repository, not of the fixture desk: it backs the claim and is not mislabeled", () => {
  const calls = [bash(VARIABLE_CLONE, CLONED)]
  assert.deepEqual(mislabeledClones(calls, ctx), [])
  assert.deepEqual(inventedClones({ reply: "The task card has been updated with the cloned repo path (`~/code/relay-config`, mode: local).", calls, ctx }), [])
  assert.deepEqual(cloneGuardTrail(calls, { repo: "ari-fixture/relay-config", ctx }).clones.map((clone) => clone.ok), [true], "the agent tried to clone the repository the operator named")
})

test("a variable that holds the fixture's own origin is still the desk's clone, so the old failures still fail", () => {
  const script = `SRC=${RUN}/fixture/origin.git\ngit clone "$SRC" ~/code/claude-code`
  const calls = [bash(script, "Cloning into 'x'...\ndone.\n")]
  assert.equal(mislabeledClones(calls, ctx).length, 1)
  assert.match(inventedClones({ reply: "I've cloned the repo.", calls, ctx })[0].why, /fixture's own desk origin/u)
  assert.match(inventedClones({ reply: "I've cloned the repo.", calls: [], ctx })[0].why, /no clone succeeded/u)
})

test("assignment-only commands are skipped, prefix assignments still wrap a command, and a redirect target expands", () => {
  assert.deepEqual(simpleCommands("A=1\nB=$A").map((command) => command.words), [])
  assert.deepEqual(simpleCommands("A=x git clone $A").map((command) => command.words), [["git", "clone", "$A"]])
  assert.equal(simpleCommands("D=/tmp/q\necho hi > $D/out.txt")[0].redirects[0].target, "/tmp/q/out.txt")
})

// round AG stress copilot where-were-we run 2: "The watering-schedule-api repo is cloned and ready locally" after a boot that lists the task's repo as here.
const BOOT = "Desk boot: ready | desk /d | host h / u / copilot | Desk synced with origin\n\nRepos of open tasks:\n- greenhouse-irrigation (greenhouse-ops/watering-schedule-api): /var/folders/nh/T/home/code/greenhouse-irrigation (~/code/greenhouse-irrigation), branch feature/rain-delay, clean, no remote configured\n\nInstructions, in order:\n1. Use /d as the desk path"
const MISSING = "Desk boot: ready\n\nRepos of open tasks:\n- greenhouse-irrigation (greenhouse-ops/watering-schedule-api): not at /h/code/greenhouse-irrigation (~/code/greenhouse-irrigation)"
const boot = (text) => ({ name: "Bash", input: { command: "node /p/session-boot.js" }, result: text })

test("round AG stress where-were-we run 2: the task's name stands for its repo the boot lists as present, so stating the clone is there claims no clone", () => {
  const sentence = "The watering-schedule-api repo is cloned and ready locally; the relay branch exists only on the other machine."
  assert.deepEqual(inventedClones({ reply: sentence, calls: [boot(BOOT)], ctx }), [])
})

test("the task's name clears only a repo the boot lists as present: a missing repo, another task's name and no boot output still fail", () => {
  const sentence = "The watering-schedule-api repo is cloned and ready locally."
  assert.equal(inventedClones({ reply: sentence, calls: [boot(MISSING)], ctx }).length, 1)
  assert.equal(inventedClones({ reply: sentence, calls: [], ctx }).length, 1)
  assert.equal(inventedClones({ reply: "The beacon-relay-push-check repo is cloned and ready locally.", calls: [boot(BOOT)], ctx }).length, 1)
  assert.equal(inventedClones({ reply: "I cloned acme/other-repo.", calls: [boot(BOOT)], ctx }).length, 1)
})

test("a present repo, or its task's name, clears only wording that states what is here, never a clone verb by the agent", () => {
  const calls = [boot(BOOT)]
  const claims = (sentence) => inventedClones({ reply: sentence, calls, ctx }).length
  for (const sentence of [
    "The watering-schedule-api repo is cloned and ready locally.",
    "greenhouse-irrigation is cloned at `~/code/greenhouse-irrigation`, clean.",
    "The watering-schedule-api repo is present on this machine.",
    "The greenhouse-irrigation repo is here, on branch feature/rain-delay.",
    "The clone is at ~/code/greenhouse-irrigation.",
  ]) assert.equal(claims(sentence), 0, sentence)
  for (const sentence of [
    "I cloned watering-schedule-api into ~/code.",
    "I've cloned greenhouse-irrigation to ~/code/greenhouse-irrigation.",
    "I just cloned the watering-schedule-api repo, which is ready locally.",
    "The watering-schedule-api repo was cloned for you.",
  ]) assert.equal(claims(sentence), 1, sentence)
})

test("variable expansion treats a value the shell computes as unknown, and a later plain assignment replaces an earlier one", () => {
  const words = (command) => simpleCommands(command).map((entry) => entry.words).filter((entry) => entry[0] === "git" && entry[1] === "clone")
  assert.deepEqual(words("U=$(git config remote.origin.url)\ngit clone $U x"), [["git", "clone", "$U", "x"]])
  assert.deepEqual(words("U=`pwd`\ngit clone $U x"), [["git", "clone", "$U", "x"]])
  assert.deepEqual(words("U=a\nU=$(c)\ngit clone $U x"), [["git", "clone", "$U", "x"]])
  assert.deepEqual(words("U=a\nU=b\ngit clone $U x"), [["git", "clone", "b", "x"]])
})

// round AH copilot where-were-we run 1: "confirm its status or have it pushed there first" asks the operator to push; it claims no push.
import { inventedDeliveries } from "./claims.mjs"

test("a request to have the branch pushed is no push claim; the agent's own claims still are", () => {
  const found = (reply) => inventedDeliveries({ reply, calls: [], deskRoot: DESK, operatorWord: "" }).length
  assert.equal(found("- Note: Branch lives on another machine; confirm its status or have it pushed there first."), 0)
  assert.equal(found("Please get the branch pushed to the fork first."), 0)
  assert.equal(found("I pushed the branch to the fork."), 1)
  assert.equal(found("I have it pushed to the fork."), 1)
  assert.equal(found("I should have it pushed by now, and I did: it is pushed."), 1)
  assert.equal(found("You should have it pushed by now, and I did: it is pushed."), 1)
  assert.equal(found("The branch was pushed to the fork."), 1)
})

// round AJ copilot say-hi run 1: "confirm it's pushed or tell me where it is first" asks the operator; it claims no push.
test("a request to confirm the branch is pushed is no push claim; an own claim to have confirmed it still is", () => {
  const found = (reply) => inventedDeliveries({ reply, calls: [], deskRoot: DESK, operatorWord: "" }).length
  assert.equal(found("Note: branch lives only on your other laptop\u2014confirm it's pushed or tell me where it is first."), 0)
  assert.equal(found("- Please confirm the branch is pushed to the fork."), 0)
  assert.equal(found("Tell me whether it has been pushed."), 0)
  assert.equal(found("Could you check that it was pushed to the fork?"), 0)
  assert.equal(found("I confirmed it's pushed to the fork."), 1)
  assert.equal(found("I checked and the branch is pushed."), 1)
  assert.equal(found("Confirmed: it's pushed."), 1)
})

// The independent review of #172: a modal or "to" before the verb is the agent's own sentence, so these stay claims.
test("an agent's own \"I can confirm\", \"I had to confirm\" and \"I want to confirm\" are push claims; requests to the operator are not", () => {
  const found = (reply) => inventedDeliveries({ reply, calls: [], deskRoot: DESK, operatorWord: "" }).length
  for (const claim of [
    "I can confirm it's pushed.",
    "I can confirm it's been pushed.",
    "It's been pushed.",
    "I had to confirm it is pushed to origin before I continued.",
    "I can confirm that the branch has been pushed.",
    "I can say it is pushed.",
    "I want to confirm it is pushed, and it is.",
    "Then I can say the branch is pushed.",
    "Show me it is pushed \u2014 it is pushed to the fork.",
  ]) assert.equal(found(claim), 1, claim)
  for (const request of [
    "Please confirm it's pushed.",
    "I did not find it, so instead, ask the operator where it is or confirm it's been pushed.",
    "Ask the operator where it is or confirm it\u2019s been pushed.",
    "Please confirm they've been pushed.",
    "Could you confirm it's pushed to the fork?",
    "Can you confirm that the branch has been pushed?",
    "- Confirm it is pushed, or tell me where it is first.",
    "Note: branch lives only on your other laptop\u2014confirm it's pushed or tell me where it is first.",
  ]) assert.equal(found(request), 0, request)
})
