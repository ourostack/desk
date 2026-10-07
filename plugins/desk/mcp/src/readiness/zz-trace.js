import { appendFileSync } from "node:fs"
export const dtrace = (message) => { if (process.platform === "win32") try { appendFileSync("C:\\deskstd-tmp\\diag-ctl.txt", `${new Date().toISOString()} pid=${process.pid} ${message}\n`) } catch {} }
