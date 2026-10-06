// What a task card says when its work lives only on another machine, shared by boot (which prints a note under the task) and the clone guard (which denies a clone or fetch of that repo).
// A next step or blocker that says the thing lives only on another machine: the agent must ask, never clone or fetch to look for it (boot acceptance round Q:
// an agent cloned a fork into the desk folder to find a branch the card says is only on the other laptop).
const MACHINE = String.raw`(?:laptop|machine|mac|computer|desktop|pc)(?![\w'-])(?!\s+(?:vision|learning|readable)\b)`
export const ELSEWHERE = new RegExp(String.raw`\b(?:my|the|our) (?:other|another|old|work|home|personal) ${MACHINE}|\bon (?:my|the other) (?:laptop|desktop|mac)(?![\w'-])|\bonly on (?:the|my) ${MACHINE}|\bnot on this (?:machine|laptop|computer|mac)(?![\w'-])`, "i")
export const ELSEWHERE_NOTE = "not here: do not clone or fetch to look for it; ask the operator to push it from that machine or say where it is; if the operator's message already says it is pushed, record that with task_update and retry"

/** Whether the task's next step or blocker says its work is on another machine. */
export const saysElsewhere = (task) => ELSEWHERE.test(`${task.next_step ?? ""} ${task.blocker ?? ""}`)
