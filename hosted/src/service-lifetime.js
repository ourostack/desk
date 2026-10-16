import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Protocol completion belongs to the MCP process, not its retained subreaper.
// The owning runtime separately keeps the guardian until retirement is proven.
export function serviceHandle(guardian) {
  const handle = new EventEmitter();
  Object.assign(handle, {
    stdin: guardian.stdin, stdout: new PassThrough(), stderr: new PassThrough(),
    pid: guardian.pid, exitCode: null, signalCode: null,
  });
  let ended = false;
  let protocol;
  let stdoutEnded = false;
  const close = () => {
    if (ended || !protocol || !stdoutEnded) return;
    ended = true;
    handle.exitCode = protocol.code;
    handle.signalCode = protocol.signal;
    handle.emit("close", protocol.code, protocol.signal);
  };
  handle.stdout.once("finish", () => { stdoutEnded = true; close(); });
  guardian.on("message", message => {
    if (message?.serviceClosed === true) {
      protocol = { code: message.code, signal: message.signal };
      handle.stdout.end();
      handle.stderr.end();
      close();
    } else if (typeof message?.serviceStdout === "string") {
      handle.stdout.write(Buffer.from(message.serviceStdout, "base64"));
    } else if (typeof message?.serviceStderr === "string") {
      handle.stderr.write(Buffer.from(message.serviceStderr, "base64"));
    } else if (message && Object.hasOwn(message, "serviceMessage")) {
      handle.emit("message", message.serviceMessage);
    }
  });
  guardian.once("error", error => handle.emit("error", error));
  guardian.once("close", (code, signal) => {
    protocol ??= { code, signal };
    handle.stdout.end();
    handle.stderr.end();
    close();
  });
  Object.defineProperty(handle, "connected", { get: () => !ended && guardian.connected });
  handle.kill = (signal = "SIGTERM") => {
    if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Unsupported hosted desk signal.");
    if (ended || protocol || !guardian.connected) return false;
    guardian.send({ serviceSignal: signal }, () => {});
    return true;
  };
  handle.send = (message, callback) => {
    if (ended || protocol || !guardian.connected) return false;
    return guardian.send({ serviceMessage: message }, callback);
  };
  return handle;
}
