// The `sessions` command line: what a session on this machine last said, which session is this one, and a message to another
// session that is judged delivered only when it shows in that session's own history. It covers this machine only; reach another
// machine's sessions by running the same command there. Output is one JSON value on stdout; a usage error is one line on stderr
// (exit 2) and a failure is a Desk failure line on stderr (exit 1).
//
// Sessions live in `<COPILOT_HOME>/session-state/<id>/` (`events.jsonl` holds the history, `inuse.<pid>.lock` marks a live host
// process, `workspace.yaml` holds the name). A send goes through the Copilot app's local WebSocket (`<COPILOT_HOME>/run/ws.port`
// and `ws.token`), which loads a session that is not in memory before it answers.
import { randomBytes } from "node:crypto"
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { AxError } from "../lib/ouro-ui/registry/ouro/ax/problem.ts"
import { defineCli, defineCommand } from "../lib/ouro-ui/registry/ouro/ax/command.ts"
import { runCli } from "../lib/ouro-ui/registry/ouro/ax/cli.ts"
import { deskFailure } from "./desk-failure.js"

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const SEND_WAIT_MS = 120000
const TAIL_BYTES = 2 << 20
const MESSAGE_CHARS = 2000

const failure = (code, thing, probably, look, fix) => new Error(deskFailure({ code, thing, probably, look, keepWorking: "read the session's history with tail, or message it with the app's send_session_message tool", fix }))

const copilotHome = ({ env, home }) => env.COPILOT_HOME || path.join(home, ".copilot")

/** The folder every session's state lives in. */
const sessionStateDir = (where) => path.join(copilotHome(where), "session-state")

const yamlField = (text, key) => {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "mu").exec(String(text))
  return match === null ? null : match[1].replace(/^['"]|['"]$/gu, "").trim()
}

/** The last `bytes` of a session's history and when it was last written, or null when it has none. */
function readHistoryTail(stateDir, id, bytes = TAIL_BYTES) {
  try {
    const fd = openSync(path.join(stateDir, id, "events.jsonl"), "r")
    try {
      const { size, mtime } = fstatSync(fd)
      const length = Math.min(size, bytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return { text: buffer.toString("utf8"), mtime: mtime.toISOString() }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** The last `count` user and assistant messages in a history's text, oldest first. */
export function tailMessages(text, count) {
  const messages = []
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("{")) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const content = String(event.data?.content ?? "")
    if (event.type === "user.message") messages.push({ at: event.timestamp, role: "user", text: content.slice(0, MESSAGE_CHARS) })
    else if (event.type === "assistant.message" && content.trim() !== "") messages.push({ at: event.timestamp, role: "assistant", text: content.slice(0, MESSAGE_CHARS) })
  }
  return messages.slice(-count)
}

/** The name the app gave a session, or null. */
export function nameOf(stateDir, id) {
  try {
    return yamlField(readFileSync(path.join(stateDir, id, "workspace.yaml"), "utf8"), "name") || null
  } catch {
    return null
  }
}

/** The one session `ref` names: a full id, a unique id prefix or an exact name. Returns `{ id }` or `{ reason }` saying what matched instead. */
export function resolveSession(stateDir, ref) {
  if (UUID.test(ref)) return { id: ref.toLowerCase() }
  let ids
  try {
    ids = readdirSync(stateDir).filter((entry) => UUID.test(entry))
  } catch {
    return { reason: `there is no session-state folder at ${stateDir}` }
  }
  const prefixed = /^[0-9a-f-]{6,}$/iu.test(ref) ? ids.filter((id) => id.startsWith(ref.toLowerCase())) : []
  const hits = prefixed.length > 0 ? prefixed : ids.filter((id) => nameOf(stateDir, id)?.toLowerCase() === ref.toLowerCase())
  if (hits.length === 1) return { id: hits[0] }
  if (hits.length === 0) return { reason: `no session on this machine has the id prefix or exact name ${JSON.stringify(ref)}` }
  return { reason: `${JSON.stringify(ref)} matches ${hits.length} sessions: ${hits.map((id) => `${nameOf(stateDir, id) ?? "unnamed"} (${id.slice(0, 8)})`).join(", ")}` }
}

/** The sessions whose live host process is `pid` or one of its ancestors. `parentOf(pid)` is the parent process id, or 0; `exists` and `list` read the file system. */
export function selfSessions(stateDir, { pid, parentOf, exists, list }) {
  let ids = []
  try {
    ids = list(stateDir).filter((entry) => UUID.test(entry))
  } catch {
    return []
  }
  const found = new Set()
  for (let current = pid, hops = 0; current > 1 && hops < 12 && found.size === 0; current = parentOf(current), hops += 1) {
    for (const id of ids) if (exists(path.join(stateDir, id, `inuse.${current}.lock`))) found.add(id)
  }
  return [...found].sort()
}

/** This session: the only candidate, or the one whose recent history holds `hint` (the agent's own command line is in it). */
export function whoAmI(stateDir, hint, self) {
  const ids = selfSessions(stateDir, self)
  if (ids.length === 1) return { ids, id: ids[0] }
  if (ids.length === 0 || hint === null) return { ids, id: null }
  const hits = ids.filter((id) => (readHistoryTail(stateDir, id, 512 * 1024)?.text ?? "").includes(hint))
  return { ids, id: hits.length === 1 ? hits[0] : null }
}

/** The parent process id of `pid`, or 0 when `ps` cannot say. */
export const parentOfProcess = (pid, run = spawnSync) => Number(String(run("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", windowsHide: true }).stdout ?? "").trim())

/** The message with a header naming the sender and how to reply. The nonce is how the send finds it again in the target's history. */
export function envelope({ nonce, from, name, host, text, script }) {
  const sender = from === null ? "an unidentified session" : `${from} (${String(name ?? "unnamed session").replace(/[()\n]/gu, " ").slice(0, 80)})`
  const reply = from === null
    ? "The sender gave no session id, so there is no reply address."
    : `Reply only if it needs an answer, never to acknowledge an acknowledgement. To reply, call the app's send_session_message with session_id ${from}, or run: node "${script}" send ${from} "<your reply>"`
  return `[Message ${nonce} from ${sender} on ${host}, sent with sessions.js send.]\n\n${text}\n\n[${reply}]`
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

/** The app's local WebSocket address and token as `{ port, token }`, or `{ reason }` in a plain sentence when the app is not running. */
export function appSocket(where) {
  const run = path.join(copilotHome(where), "run")
  let port
  let owner
  let token
  try {
    ;[port, owner] = readFileSync(path.join(run, "ws.port"), "utf8").trim().split(/\r?\n/u)
    ;[token] = readFileSync(path.join(run, "ws.token"), "utf8").trim().split(/\r?\n/u)
  } catch {
    return { reason: "the app has not written its local socket files, so it is not running" }
  }
  if (owner && !alive(Number(owner))) return { reason: "the app that wrote its local socket is not running" }
  return { port, token }
}

/** Sends `messages` to the app and collects the replies `keep` accepts until `done` says stop or `waitMs` passes. */
export function exchange(socket, messages, { done, keep, waitMs }, WebSocketImpl = globalThis.WebSocket) {
  return new Promise((resolve) => {
    const got = []
    const ws = new WebSocketImpl(`ws://127.0.0.1:${socket.port}/?token=${encodeURIComponent(socket.token)}&observer=1`)
    const finish = () => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // Already closed.
      }
      resolve(got)
    }
    const timer = setTimeout(finish, waitMs)
    ws.addEventListener("open", () => {
      for (const message of messages) ws.send(JSON.stringify(message))
    })
    ws.addEventListener("message", (event) => {
      let reply
      try {
        reply = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!keep(reply)) return
      got.push(reply)
      if (done(reply)) finish()
    })
    ws.addEventListener("error", () => {
      got.push({ type: "socket_error" })
      finish()
    })
  })
}

/** Asks the app to deliver `prompt` to session `id` and reports what it answered. It always waits for the answer: closing the socket first cancels a send to a session the app is still loading. */
export async function sendThroughApp({ id, prompt, socket, send = exchange, newRequestId = () => randomBytes(8).toString("hex") }) {
  const request_id = newRequestId()
  const got = await send(socket, [{ type: "send_message", session_id: id, prompt, delivery_mode: "immediate", request_id }], {
    keep: (reply) => reply.request_id === request_id || (reply.session_id === id && /message_(?:sent|queued|delivery)/u.test(reply.type)) || reply.type === "socket_error",
    done: (reply) => /^(?:session_message_sent|session_message_queued|session_message_delivery_unknown|error|socket_error)$/u.test(reply.type),
    waitMs: SEND_WAIT_MS,
  })
  const last = got.at(-1)
  return { accepted: Boolean(last && /^session_message_(?:sent|queued)$/u.test(last.type)), reply: last?.type ?? "no reply", error: last?.type === "error" ? String(last.message).slice(0, 300) : null }
}

const defaults = (env) => ({
  stateDir: sessionStateDir({ env, home: os.homedir() }),
  self: { pid: process.pid, parentOf: parentOfProcess, exists: existsSync, list: readdirSync },
  socket: () => appSocket({ env, home: os.homedir() }),
  send: sendThroughApp,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  platform: process.platform,
  host: os.hostname().split(".")[0].toLowerCase(),
  nonce: () => randomBytes(4).toString("hex"),
})

/** Waits for `seen()` to turn true, looking every 1.5 s, for at most `waitMs`. */
async function seenWithin(seen, waitMs, { sleep, now }) {
  const end = now() + waitMs
  let found = seen()
  while (!found && now() < end) {
    await sleep(1500)
    found = seen()
  }
  return found
}

async function runSend({ ref, message, from: fromFlag, asUser, waitMs, script, deps }) {
  const target = resolveSession(deps.stateDir, ref)
  if (target.reason !== undefined) {
    throw failure("sessions_target", `cannot send to ${JSON.stringify(ref)}`, target.reason, "run sessions.js tail <id or name> to check the session, or ask the person which one is meant", "pass the full session id")
  }
  const nonce = deps.nonce()
  let prompt = message
  let sender = null
  if (!asUser) {
    // The first words of the command are in the sender's own history, which picks it out of several sessions in one runtime.
    const hint = (/^[A-Za-z0-9 ,.:;_!?-]{8,60}/u.exec(message) ?? [])[0] ?? null
    const from = fromFlag === "none" ? null : fromFlag ?? whoAmI(deps.stateDir, hint, deps.self).id
    sender = from
    prompt = envelope({ nonce, from, name: from === null ? null : nameOf(deps.stateDir, from), host: deps.host, text: message, script })
  }
  const before = new Set(tailMessages(readHistoryTail(deps.stateDir, target.id)?.text ?? "", 20).map((entry) => entry.at))
  const socket = deps.socket()
  if (socket.reason !== undefined) {
    throw failure("sessions_app_socket", "cannot reach the GitHub Copilot app", socket.reason, "check that the app is open, then run sessions.js tail on the target to see whether the message arrived another way", "start the app and run the same command again")
  }
  const result = await deps.send({ id: target.id, prompt, socket })
  const matches = (entry) => entry.role === "user" && (asUser ? entry.text.trim() === message.trim().slice(0, MESSAGE_CHARS) && !before.has(entry.at) : entry.text.includes(`[Message ${nonce} `))
  const delivered = result.accepted && (await seenWithin(() => tailMessages(readHistoryTail(deps.stateDir, target.id)?.text ?? "", 20).some(matches), waitMs, deps))
  if (!result.accepted) {
    throw failure("sessions_send_refused", `the app did not accept the message for ${target.id}`, result.error ?? `the app answered ${result.reply}; the session may be archived or not a Copilot app session`, `run sessions.js tail ${target.id} to see the session`, "pass the id of a session that is open in the app")
  }
  const note = delivered ? undefined : `The app accepted the message but it was not in the history after ${waitMs / 1000} s. Read it with sessions.js tail ${target.id} before sending again, so it is not sent twice.`
  return { to: target.id, from: sender, nonce: asUser ? null : nonce, accepted: true, delivered, reply: result.reply, ...(note === undefined ? {} : { note }) }
}

const SESSION = { name: "session", required: true, description: "A full id, an id prefix or an exact name of a session on this machine." }
const text = (result) => JSON.stringify(result, null, 1)

function sessionsCli({ script, deps, overrides }) {
  const command = (name, def, run) => defineCommand({ name, output: "one JSON value", text, effect: "private", ...def, run })
  return defineCli({
    name: "sessions",
    about: ["Reads and messages the agent sessions on this machine; reach another machine's sessions by running the same command there."],
    commands: [
      command("whoami", { readOnly: true, summary: "Print the session this command runs in. With several sessions in one runtime, --hint <text from your own command> picks yours.", flags: { hint: { type: "string", description: "Text from your own command line, which is in your session's history." } } }, (input) => {
        if (deps.platform === "win32" && overrides.self === undefined) {
          throw failure("sessions_whoami_platform", "whoami cannot walk process parents here", "this command reads the process tree with ps, which Windows does not have", "read your own session id from the session folder name or the app", "pass --from <your session id> to send instead")
        }
        return whoAmI(deps.stateDir, input.hint ?? null, deps.self)
      }),
      command("tail", { readOnly: true, summary: "Print the last <count> (default 6) user and assistant messages of a session.", args: [SESSION, { name: "count", description: "How many messages, a positive whole number." }] }, (input) => {
        const count = input.count === undefined ? 6 : Number(input.count)
        if (!Number.isInteger(count) || count < 1) throw new AxError({ code: "sessions_tail_count", exit: 2, thing: "tail", problem: `the count must be a positive whole number, not ${JSON.stringify(input.count)}`, fix: "run sessions tail <session> [<count>]" })
        const target = resolveSession(deps.stateDir, input.session)
        const history = target.reason !== undefined ? null : readHistoryTail(deps.stateDir, target.id)
        if (target.reason !== undefined || history === null) {
          throw failure("sessions_tail_target", `cannot read ${JSON.stringify(input.session)}`, target.reason ?? `session ${target.id} has no events.jsonl here, so it is on another machine or has been removed`, "check the id or name, or run the command on the machine that hosts the session", "pass the full session id")
        }
        return { id: target.id, name: nameOf(deps.stateDir, target.id), last_written: history.mtime, messages: tailMessages(history.text, count) }
      }),
      command("send", {
        summary: "Deliver a message with a header naming the sender and how to reply, then wait (--wait, default 20) for it to show in the target's history. A send that was accepted but not yet seen is not failed: read the target with tail before sending again.",
        args: [SESSION, { name: "message", required: true, rest: true, description: "The message text." }],
        flags: {
          from: { type: "string", placeholder: "<session id>|none", description: "The sender's session id, or none; by default this session." },
          "as-user": { type: "boolean", description: "Send the text alone, as the person's own message; use it only for words the person authorized in their voice." },
          wait: { type: "number", min: 0, description: "Seconds to wait for the message to show in the target's history (default 20)." },
        },
      }, (input) => runSend({ ref: input.session, message: input.message, from: input.from, asUser: input["as-user"] === true, waitMs: (input.wait ?? 20) * 1000, script, deps })),
    ],
  })
}

/** Runs the command line; returns the exit code. */
export async function runSessionsCli({ argv, script = "sessions.js", env = process.env, io = process, deps: overrides = {} }) {
  // A failure from the code underneath is already a whole line of its own; the kit's tool-name prefix would say it twice.
  return runCli(sessionsCli({ script, deps: { ...defaults(env), ...overrides }, overrides }), argv, { stdout: io.stdout, stderr: io.stderr })
}
