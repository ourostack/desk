import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SERVICE_OUTPUT_BYTES, serviceOutputFrame, serviceOutputFailure, sendServiceControl } from "./service-output.js";

// Protocol completion belongs to the MCP process, not its retained subreaper.
// The owning runtime separately keeps the guardian until retirement is proven.
export function serviceHandle(guardian, onFailure = () => {}) {
  const handle = new EventEmitter();
  Object.assign(handle, {
    stdin: guardian.stdin,
    stdout: new PassThrough({ highWaterMark: SERVICE_OUTPUT_BYTES }),
    stderr: new PassThrough({ highWaterMark: SERVICE_OUTPUT_BYTES }),
    pid: guardian.pid, exitCode: null, signalCode: null,
  });
  let ended = false;
  let protocol;
  let retired = false;
  const state = { stdout: { id: 0, pending: null }, stderr: { id: 0, pending: null } };
  const fail = (preserve = true) => {
    if (ended) return;
    ended = true;
    const error = serviceOutputFailure();
    if (preserve) {
      onFailure(error);
      sendServiceControl(guardian, { serviceAbort: true }, () => {});
    }
    handle.stdout.destroy();
    handle.stderr.destroy();
    handle.emit("error", error);
  };
  const close = () => {
    if (ended || !protocol || ![handle.stdout, handle.stderr].every(stream => stream.writableFinished && stream.readableEnded)) return;
    ended = true;
    handle.exitCode = protocol.code;
    handle.signalCode = protocol.signal;
    handle.emit("close", protocol.code, protocol.signal);
  };
  for (const stream of [handle.stdout, handle.stderr]) {
    stream.once("finish", () => {
      if (!stream.readableLength) stream.resume();
      close();
    });
    stream.once("end", close);
    stream.once("error", () => fail());
    stream.once("close", () => {
      if (!stream.writableFinished || !stream.readableEnded) fail();
    });
  }
  guardian.on("message", message => {
    if (ended) return;
    if (message && Object.hasOwn(message, "retired")) retired = message.retired === true && message.quiescent === true;
    if (message?.serviceFailure === true) { fail(); return; }
    if (message?.serviceClosed === true) {
      protocol = { code: message.code, signal: message.signal };
      handle.stdout.end();
      handle.stderr.end();
      close();
    } else if (message && Object.hasOwn(message, "serviceMessage")) {
      handle.emit("message", message.serviceMessage);
    } else {
      let frame;
      try { frame = serviceOutputFrame(message); } catch { fail(); return; }
      if (!frame) return;
      const row = state[frame.stream];
      if (protocol || row.pending !== null || frame.id !== row.id + 1) { fail(); return; }
      row.id = frame.id;
      row.pending = frame.id;
      const credit = () => {
        if (ended || row.pending !== frame.id) return;
        row.pending = null;
        sendServiceControl(guardian, { serviceOutputAck: frame.stream, serviceOutputId: frame.id }, () => fail());
      };
      if (handle[frame.stream].write(frame.data)) credit();
      else handle[frame.stream].once("drain", credit);
    }
  });
  guardian.once("error", () => fail());
  guardian.once("disconnect", () => {
    if (!protocol || !retired) fail(!retired);
  });
  guardian.once("close", () => {
    if (!retired || !protocol) fail(!retired);
  });
  Object.defineProperty(handle, "connected", { get: () => !ended && guardian.connected });
  handle.kill = (signal = "SIGTERM") => {
    if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Unsupported hosted desk signal.");
    if (ended) return false;
    const sent = !protocol && sendServiceControl(guardian, { serviceSignal: signal }, () => fail());
    if (signal === "SIGKILL" && [handle.stdout, handle.stderr].some(stream => stream.readableLength || stream.writableLength)) fail();
    return Boolean(sent);
  };
  handle.send = (message, callback) => {
    if (ended || protocol || !guardian.connected) return false;
    try {
      return guardian.send({ serviceMessage: message }, error => {
        if (error) fail();
        callback?.(error ? serviceOutputFailure() : undefined);
      });
    } catch {
      fail();
      callback?.(serviceOutputFailure());
      return false;
    }
  };
  return handle;
}
