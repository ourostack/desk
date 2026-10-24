export const SERVICE_OUTPUT_BYTES = 16 * 1024;
const streams = ["stdout", "stderr"];

export function serviceOutputFailure() {
  return Object.assign(new Error("Hosted desk service output or control channel failed; preservation is required."), {
    code: "DESK_OPERATION_UNQUIESCENT", quiescent: false,
  });
}

export function sendServiceControl(channel, message, failed) {
  if (!channel.connected) { failed(); return false; }
  try {
    // send(false) is IPC pressure, not failure. Output has only one outstanding
    // frame per stream; neither IPC hop is paused, so control remains readable.
    channel.send(message, error => { if (error) failed(); });
    return true;
  } catch {
    failed();
    return false;
  }
}

export function serviceOutputFrame(message) {
  if (!message || typeof message !== "object") return;
  const present = streams.filter(stream => Object.hasOwn(message, stream === "stdout" ? "serviceStdout" : "serviceStderr"));
  if (!present.length) return;
  const stream = present[0];
  const text = message[stream === "stdout" ? "serviceStdout" : "serviceStderr"];
  if (present.length !== 1 || typeof text !== "string" || text.length === 0 ||
      text.length > 21848 || !Number.isSafeInteger(message.serviceOutputId) || message.serviceOutputId < 1 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw serviceOutputFailure();
  const data = Buffer.from(text, "base64");
  if (data.length > SERVICE_OUTPUT_BYTES) throw serviceOutputFailure();
  return { stream, data, id: message.serviceOutputId };
}

// End-to-end credit: an MCP pipe is read again only after the gateway drains
// its previous frame. At most 16 KiB per stream is outstanding across both IPCs.
export function pipeServiceOutput(child, upstream, onFailure) {
  let failed = false;
  let resolve;
  let reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const state = Object.fromEntries(streams.map(stream => [stream, { id: 0, pending: null, ended: false }]));
  const fail = () => {
    if (failed) return;
    failed = true;
    onFailure();
    reject(serviceOutputFailure());
  };
  const finish = () => {
    if (streams.every(stream => state[stream].ended && state[stream].pending === null)) resolve();
  };
  const pump = stream => {
    const row = state[stream];
    if (failed || row.ended || row.pending !== null) return;
    const pipe = child[stream];
    if (!pipe.readableLength) { pipe.read(0); return; }
    const data = pipe.read(Math.min(pipe.readableLength, SERVICE_OUTPUT_BYTES));
    if (!data) return;
    row.pending = ++row.id;
    sendServiceControl(upstream, {
      [stream === "stdout" ? "serviceStdout" : "serviceStderr"]: data.toString("base64"),
      serviceOutputId: row.id,
    }, fail);
  };
  for (const stream of streams) {
    child[stream].on("readable", () => pump(stream));
    child[stream].once("end", () => { state[stream].ended = true; finish(); });
    child[stream].once("error", fail);
    child[stream].once("close", () => { if (!state[stream].ended) fail(); });
  }
  upstream.on("message", message => {
    if (!streams.includes(message?.serviceOutputAck) || failed) return;
    const stream = message.serviceOutputAck;
    if (state[stream].pending === null || state[stream].pending !== message.serviceOutputId) { fail(); return; }
    state[stream].pending = null;
    pump(stream);
    finish();
  });
  upstream.once("disconnect", fail);
  return done;
}

// The intermediate helper admits only the same two in-flight frames. Credit
// crosses it in the opposite direction; lifecycle messages use their own path.
export function relayServiceOutput(child, upstream, onFailure) {
  let failed = false;
  const state = Object.fromEntries(streams.map(stream => [stream, { id: 0, pending: null }]));
  const fail = () => { if (!failed) { failed = true; onFailure(); } };
  child.on("message", message => {
    if (failed) return;
    let frame;
    try { frame = serviceOutputFrame(message); } catch { fail(); return; }
    if (!frame) return;
    const row = state[frame.stream];
    if (row.pending !== null || frame.id !== row.id + 1) { fail(); return; }
    row.id = frame.id;
    row.pending = frame.id;
    sendServiceControl(upstream, message, fail);
  });
  upstream.on("message", message => {
    if (!streams.includes(message?.serviceOutputAck) || failed) return;
    const row = state[message.serviceOutputAck];
    if (row.pending === null || row.pending !== message.serviceOutputId) { fail(); return; }
    row.pending = null;
    sendServiceControl(child, message, fail);
  });
}
