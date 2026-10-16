import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

// Disposable Task 1 transport only; no production modules (including SQLite).
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > 16380) throw new Error("encoded frame exceeds 16384 bytes")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}
const decoder = (role) => {
  let pending = Buffer.alloc(0)
  return { push(chunk) {
    pending = Buffer.concat([pending, chunk])
    const values = []
    while (pending.length >= 4) {
      const n = pending.readUInt32LE()
      if (n > 16380) throw new Error("encoded frame exceeds 16384 bytes")
      if (pending.length < n + 4) break
      const value = JSON.parse(pending.subarray(4, n + 4).toString("utf8"))
      if (role && value.role !== role) throw new Error("wrong channel role")
      values.push(value)
      pending = pending.subarray(n + 4)
    }
    return values
  } }
}

test("fragmented control frames reconstruct without consuming the next frame", () => {
  const bytes = Buffer.concat([frame({ role: "owner" }), frame({ role: "shim" })])
  const parse = decoder()
  assert.deepEqual(parse.push(bytes.subarray(0, 2)), [])
  assert.deepEqual(parse.push(bytes.subarray(2, 7)), [])
  assert.deepEqual(parse.push(bytes.subarray(7)), [{ role: "owner" }, { role: "shim" }])
})

test("encoded bound includes the four-byte header, including refusal of body 16381", () => {
  assert.equal(frame("x".repeat(16378)).length, 16384)
  for (const length of [16381, 16385]) {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(length)
    assert.throws(() => decoder().push(header), /16384/)
  }
})

test("result-channel provenance never accepts a control role", () => {
  assert.throws(() => decoder("shim").push(frame({ role: "owner" })), /role/)
})

test("real shim stays ready without starting a command before explicit start", { timeout: 5000 }, async () => {
  const root = process.platform === "win32"
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../owned-git-probe-output/fixture")
    : "/Users/microsoft/.copilot/session-state/8f8c7288-cd47-4544-8dcf-0ad9bbadfeb5/files/owned-git-probe/fixture"
  fs.mkdirSync(root, { recursive: true })
  const source = path.join(root, "probe-shim.cjs")
  const marker = path.join(root, "ready-" + process.pid + "-" + Date.now())
  fs.writeFileSync(source, shimSource)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("NODE_")) delete env[key]
  const child = spawn(process.execPath, [source, "shim", "fixture", marker], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe", "pipe"],
  })
  const closed = new Promise((resolve) => child.on("close", resolve))
  child.stdio[3].on("error", () => {})
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  try {
    await new Promise((resolve, reject) => {
      const parse = decoder("shim")
      const timer = setTimeout(() => reject(new Error("shim ready deadline: " + output)), 2000)
      child.on("error", (error) => { clearTimeout(timer); reject(error) })
      child.stdio[3].on("data", (chunk) => {
        try {
          if (parse.push(chunk).some((value) => value.stage === "ready")) { clearTimeout(timer); resolve() }
        } catch (error) { clearTimeout(timer); reject(error) }
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(fs.existsSync(marker), true)
    assert.equal(fs.existsSync(marker + ".command"), false)
    assert.equal(fs.existsSync(marker + ".survivors"), false)
    assert.equal(output, "")
  } finally {
    child.stdin.end()
    child.kill()
    await closed
  }
})

const ownerSource = String.raw`
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdarg.h>
#include <wchar.h>
#include <string.h>

/* Task 1 disposable probe: private job authority never travels over stdout. */
static HANDLE control = INVALID_HANDLE_VALUE;
static int wire(HANDLE h, const char *text) {
  DWORD done = 0, size = (DWORD)strlen(text);
  if (size > 16380) return 0;
  if (!WriteFile(h, &size, 4, &done, NULL) || done != 4) return 0;
  return WriteFile(h, text, size, &done, NULL) && done == size;
}
static int emit(const char *format, ...) {
  char text[16381]; int n; va_list args;
  va_start(args, format); n = vsnprintf(text, sizeof(text), format, args); va_end(args);
  if (n < 0 || n > 16380) return 0;
  return wire(control, text);
}
static int exact(HANDLE h, void *buffer, DWORD count, ULONGLONG deadline) {
  DWORD available = 0, done = 0, n;
  while (done < count && GetTickCount64() < deadline) {
    if (!PeekNamedPipe(h, NULL, 0, NULL, &available, NULL)) return -1;
    if (!available) { Sleep(2); continue; }
    n = count - done; if (n > available) n = available;
    if (!ReadFile(h, (char *)buffer + done, n, &n, NULL) || !n) return -1;
    done += n;
  }
  return done == count ? 1 : 0;
}
static int receive(HANDLE h, char *text) {
  DWORD size = 0; int rc; ULONGLONG end = GetTickCount64() + 2000;
  rc = exact(h, &size, 4, end); if (rc != 1) return rc;
  if (size > 16380) { SetLastError(ERROR_BUFFER_OVERFLOW); return -1; }
  rc = exact(h, text, size, end); if (rc == 1) text[size] = 0;
  return rc;
}
static int command(const char *cmd) {
  char text[16381], expected[80];
  snprintf(expected, sizeof(expected), "\"cmd\":\"%s\"", cmd);
  return receive(control, text) == 1 && strstr(text, expected) != NULL;
}
static DWORD active(HANDLE job, BOOL *ok) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  *ok = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL);
  return *ok ? accounting.ActiveProcesses : MAXDWORD;
}
typedef struct { DWORD assigned; DWORD count; ULONG_PTR pids[64]; } CENSUS;
static int census(HANDLE job, CENSUS *list) {
  ZeroMemory(list, sizeof(*list));
  return QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, sizeof(*list), NULL) && list->count <= 64;
}
static int members(HANDLE job) {
  CENSUS list; char text[4096]; size_t used; DWORD i; int n;
  if (!census(job, &list)) return 0;
  n = snprintf(text, sizeof(text), "{\"role\":\"owner\",\"stage\":\"job-members\",\"pids\":[");
  if (n < 0) return 0; used = (size_t)n;
  for (i = 0; i < list.count; i++) {
    n = snprintf(text + used, sizeof(text) - used, "%s%llu", i ? "," : "", (unsigned long long)list.pids[i]);
    if (n < 0 || (size_t)n >= sizeof(text) - used) return 0; used += (size_t)n;
  }
  if (used + 3 >= sizeof(text)) return 0;
  memcpy(text + used, "]}", 3); return wire(control, text);
}
static int standard_token(void) {
  HANDLE token = NULL; TOKEN_ELEVATION elevation; DWORD size; BOOL admin = TRUE;
  SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY; PSID sid = NULL; int good = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  if (GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) &&
      AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0,0,0,0,0,0, &sid) &&
      CheckTokenMembership(NULL, sid, &admin)) good = !admin && !elevation.TokenIsElevated;
  if (sid) FreeSid(sid); CloseHandle(token); return good;
}
static int zero(HANDLE job) {
  ULONGLONG end = GetTickCount64() + 2000; BOOL ok;
  do { DWORD n = active(job, &ok); if (!ok) return 0; if (!n) return 1; Sleep(5); } while (GetTickCount64() < end);
  return 0;
}
static HANDLE newjob(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    if (job) CloseHandle(job); return NULL;
  }
  return job;
}
static HANDLE inherited(HANDLE source) {
  HANDLE copy = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return NULL;
  return copy;
}
static int launch(wchar_t *line, HANDLE *handles, DWORD count, PROCESS_INFORMATION *pi, LPWCH environment) {
  STARTUPINFOEXW si; SIZE_T bytes = 0;
  unsigned char crt[4 + 4 + 4 * sizeof(intptr_t)];
  int n = (int)count; DWORD i; int rc;
  ZeroMemory(&si, sizeof(si)); si.StartupInfo.cb = sizeof(si);
  InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!si.lpAttributeList) return 0;
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes)) { HeapFree(GetProcessHeap(), 0, si.lpAttributeList); return 0; }
  rc = UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, count * sizeof(HANDLE), NULL, NULL);
  ZeroMemory(crt, sizeof(crt)); memcpy(crt, &n, 4);
  for (i = 0; i < count; i++) {
    intptr_t value = (intptr_t)handles[i];
    crt[4 + i] = 1 | 8;
    memcpy(crt + 4 + count + i * sizeof(intptr_t), &value, sizeof(value));
  }
  si.StartupInfo.cbReserved2 = (WORD)(4 + count + count * sizeof(intptr_t));
  si.StartupInfo.lpReserved2 = crt;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = handles[0]; si.StartupInfo.hStdOutput = handles[1]; si.StartupInfo.hStdError = handles[2];
  if (rc) rc = CreateProcessW(NULL, line, NULL, NULL, TRUE,
    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
    environment, NULL, &si.StartupInfo, pi);
  DeleteProcThreadAttributeList(si.lpAttributeList); HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
  return rc;
}
static LPWCH cleanenv(void) {
  LPWCH original = GetEnvironmentStringsW(), p, clean, out;
  size_t capacity = 2, length;
  if (!original) return NULL;
  for (p = original; *p; p += wcslen(p) + 1) capacity += wcslen(p) + 1;
  clean = (LPWCH)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, capacity * sizeof(wchar_t));
  if (!clean) { FreeEnvironmentStringsW(original); return NULL; }
  out = clean;
  for (p = original; *p; p += length) {
    length = wcslen(p) + 1;
    if (_wcsnicmp(p, L"NODE_", 5) != 0) { memcpy(out, p, length * sizeof(wchar_t)); out += length; }
  }
  *out = 0; FreeEnvironmentStringsW(original); return clean;
}
static void receipt(const wchar_t *name, const char *stage, int sealed, int drained, DWORD error) {
  FILE *f = NULL;
  if (_wfopen_s(&f, name, L"wb") == 0 && f) {
    fprintf(f, "{\"stage\":\"%s\",\"sealed\":%s,\"exactJobZero\":%s,\"error\":%lu}\n",
      stage, sealed ? "true" : "false", drained ? "true" : "false", error);
    fclose(f);
  }
}
typedef struct { HANDLE from; HANDLE to; } PUMP;
static DWORD WINAPI pump(LPVOID parameter) {
  PUMP *p = (PUMP *)parameter; char buffer[4096]; DWORD n, written;
  while (ReadFile(p->from, buffer, sizeof(buffer), &n, NULL) && n) {
    if (!WriteFile(p->to, buffer, n, &written, NULL) || written != n) break;
  }
  CloseHandle(p->to); p->to = NULL; return 0;
}
static int audit(DWORD pid, HANDLE job, HANDLE *sensitive, DWORD count) {
  /* OpenProcess is ONLY a peer handle-inheritance measurement, never a drain/ownership receipt. */
  HANDLE process = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  BOOL member = FALSE; DWORD i; int good = 1;
  if (!process || !IsProcessInJob(process, job, &member) || !member) { if (process) CloseHandle(process); return 0; }
  for (i = 0; i < count; i++) {
    HANDLE candidate = NULL; BOOL same = FALSE; DWORD error;
    SetLastError(0);
    if (DuplicateHandle(process, sensitive[i], GetCurrentProcess(), &candidate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      same = CompareObjectHandles(sensitive[i], candidate); CloseHandle(candidate);
    }
    error = GetLastError();
    emit("{\"role\":\"owner\",\"stage\":\"peer-handle\",\"index\":%lu,\"sameObject\":%s,\"error\":%lu}", i, same ? "true" : "false", error);
    if (same) good = 0;
  }
  CloseHandle(process); return good;
}
static int supervise(int argc, wchar_t **argv) {
  HANDLE job = NULL, handles[3] = {NULL,NULL,NULL};
  PROCESS_INFORMATION pi; wchar_t line[32768]; DWORD i, code = 1, before = MAXDWORD; BOOL ok = FALSE;
  int rc = 1, assigned = 0, drained = 0;
  CENSUS list; ZeroMemory(&list, sizeof(list));
  ZeroMemory(&pi, sizeof(pi));
  if (argc != 6) return 91;
  job = newjob(); if (!job) goto done;
  for (i = 0; i < 3; i++) { handles[i] = inherited(GetStdHandle(i == 0 ? STD_INPUT_HANDLE : i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE)); if (!handles[i]) goto done; }
  if (swprintf_s(line, 32768, L"\"%s\" \"%s\" \"%s\"", argv[2], argv[3], argv[4]) < 0) goto done;
  if (!launch(line, handles, 3, &pi, NULL)) goto done;
  if (!AssignProcessToJobObject(job, pi.hProcess)) goto done;
  assigned = 1; if (ResumeThread(pi.hThread) == MAXDWORD) goto done;
  if (WaitForSingleObject(pi.hProcess, 120000) != WAIT_OBJECT_0) goto done;
  if (!GetExitCodeProcess(pi.hProcess, &code)) goto done;
  before = active(job, &ok); if (!ok) goto done;
  rc = (int)code;
done:
  if (job && !census(job, &list)) rc = 95;
  if (pi.hProcess && !assigned) { TerminateProcess(pi.hProcess, 92); WaitForSingleObject(pi.hProcess, 2000); }
  if (job) {
    BOOL sealed = TerminateJobObject(job, 93);
    drained = sealed && zero(job);
    FILE *f = NULL;
    if (_wfopen_s(&f, argv[5], L"wb") == 0 && f) {
      fprintf(f, "{\"stage\":\"broader-test-owner\",\"sealed\":%s,\"exactJobZero\":%s,\"retiredPids\":[", sealed ? "true" : "false", drained ? "true" : "false");
      for (i = 0; i < list.count; i++) fprintf(f, "%s%llu", i ? "," : "", (unsigned long long)list.pids[i]);
      fprintf(f, "],\"activeBefore\":%lu,\"workerCode\":%lu}\n", before, code); fclose(f);
    }
    fprintf(stderr, "broader-test-owner final active-before=%lu exact-job-zero=%d\n", before, drained);
    CloseHandle(job);
  }
  if (pi.hThread) CloseHandle(pi.hThread); if (pi.hProcess) CloseHandle(pi.hProcess);
  for (i = 0; i < 3; i++) if (handles[i]) CloseHandle(handles[i]);
  return drained ? rc : 94;
}
int wmain(int argc, wchar_t **argv) {
  HANDLE job = NULL, inputR = NULL, inputW = NULL, resultR = NULL, resultW = NULL, thread = NULL;
  HANDLE handles[4] = {NULL,NULL,NULL,NULL}, sensitive[7];
  PROCESS_INFORMATION pi; SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
  LPWCH environment = NULL; wchar_t line[32768]; char text[16381]; DWORD flags = 0, error = 0;
  BOOL ok = FALSE; int rc = 1, assigned = 0, sealed = 0, drained = 0, stranded = 0;
  const char *stage = "initial"; PUMP transfer;
  ZeroMemory(&pi, sizeof(pi)); ZeroMemory(&transfer, sizeof(transfer));
  if (argc > 1 && wcscmp(argv[1], L"--supervise") == 0) return supervise(argc, argv);
  if (argc != 7) return 90;
  control = (HANDLE)_get_osfhandle(3);
#define REQUIRE(condition, label) do { stage = label; if (!(condition)) { error = GetLastError(); fprintf(stderr, "STOP %s win32=%lu crt-fd3=%llu\n", stage, error, (unsigned long long)(uintptr_t)control); goto done; } } while (0)
  REQUIRE(control != INVALID_HANDLE_VALUE && GetHandleInformation(control, &flags), "parent-owner-fd3");
  REQUIRE(standard_token(), "standard-user-token");
  REQUIRE(GetFileType(control) == FILE_TYPE_PIPE, "control-pipe-type");
  REQUIRE(SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0), "control-no-inherit");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"hello\",\"handle\":%llu,\"flags\":%lu,\"type\":%lu,\"administrator\":false,\"elevated\":false}", (unsigned long long)(uintptr_t)control, flags, GetFileType(control)), "control-write");
  REQUIRE(command("prepare"), "control-read");
  job = newjob(); REQUIRE(job, "create-retained-job");
  REQUIRE(CreatePipe(&inputR, &inputW, &sa, 0), "stdin-pipe");
  REQUIRE(SetHandleInformation(inputW, HANDLE_FLAG_INHERIT, 0), "stdin-write-private");
  REQUIRE(CreatePipe(&resultR, &resultW, &sa, 0), "result-pipe");
  REQUIRE(!CompareObjectHandles(control, resultR) && !CompareObjectHandles(control, resultW), "distinct-control-result-objects");
  REQUIRE(SetHandleInformation(resultR, HANDLE_FLAG_INHERIT, 0), "result-read-private");
  handles[0] = inputR; handles[1] = inherited(GetStdHandle(STD_OUTPUT_HANDLE));
  handles[2] = inherited(GetStdHandle(STD_ERROR_HANDLE)); handles[3] = resultW;
  REQUIRE(handles[1] && handles[2], "stdio-duplicates");
  environment = cleanenv(); REQUIRE(environment, "clean-bootstrap-environment");
  REQUIRE(swprintf_s(line, 32768, L"\"%s\" \"%s\" shim \"%s\" \"%s\"", argv[2], argv[3], argv[4], argv[5]) >= 0, "shim-command");
  REQUIRE(launch(line, handles, 4, &pi, environment), "create-suspended-shim");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"resources\",\"job\":%llu,\"rootProcess\":%llu,\"rootThread\":%llu,\"resultRead\":%llu,\"resultWrite\":%llu,\"shimStdinWrite\":%llu}",
    (unsigned long long)(uintptr_t)job, (unsigned long long)(uintptr_t)pi.hProcess, (unsigned long long)(uintptr_t)pi.hThread,
    (unsigned long long)(uintptr_t)resultR, (unsigned long long)(uintptr_t)resultW, (unsigned long long)(uintptr_t)inputW), "resource-receipt");
  CloseHandle(inputR); inputR = NULL;
  REQUIRE(SetHandleInformation(resultW, HANDLE_FLAG_INHERIT, 0), "result-write-private-copy");
  CloseHandle(handles[1]); handles[1] = NULL; CloseHandle(handles[2]); handles[2] = NULL;
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"created\",\"pid\":%lu,\"thread\":%lu}", pi.dwProcessId, pi.dwThreadId), "created-receipt");
  if (wcscmp(argv[4], L"cancel-created") == 0) { REQUIRE(command("cancel"), "cancel-created"); goto retire; }
  if (wcscmp(argv[4], L"model-assignment") == 0) {
    SetLastError(0); ok = AssignProcessToJobObject(NULL, pi.hProcess); error = GetLastError();
    REQUIRE(!ok && error != 0, "model-assignment-refusal");
    stranded = 1; emit("{\"role\":\"owner\",\"stage\":\"modeled-assignment-refusal\",\"error\":%lu,\"strandedSuspendedPid\":%lu}", error, pi.dwProcessId);
    rc = 0; goto done;
  }
  REQUIRE(command("assign"), "assign-authorization");
  REQUIRE(AssignProcessToJobObject(job, pi.hProcess), "real-assignment");
  assigned = 1;
  REQUIRE(IsProcessInJob(pi.hProcess, job, &ok) && ok, "root-job-membership");
  Sleep(100);
  REQUIRE(PeekNamedPipe(resultR, NULL, 0, NULL, &flags, NULL) && flags == 0 && GetFileAttributesW(argv[5]) == INVALID_FILE_ATTRIBUTES, "no-first-marker-before-resume");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"assigned-suspended\",\"active\":%lu}", active(job, &ok)) && ok, "assignment-receipt");
  if (wcscmp(argv[4], L"cancel-assigned") == 0) { REQUIRE(command("cancel"), "cancel-assigned"); goto retire; }
  if (wcscmp(argv[4], L"model-resume") == 0) {
    SetLastError(0); flags = ResumeThread(NULL); error = GetLastError();
    REQUIRE(flags == MAXDWORD && error != 0, "model-resume-refusal");
    emit("{\"role\":\"owner\",\"stage\":\"modeled-resume-refusal\",\"error\":%lu}", error); goto retire;
  }
  REQUIRE(command("resume"), "resume-authorization");
  REQUIRE(ResumeThread(pi.hThread) == 1, "real-resume");
  REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"ready\""), "shim-crt-fd3-ready");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"ready\",\"shim\":%s}", text), "ready-receipt");
  if (wcscmp(argv[4], L"ready-abort") == 0) { REQUIRE(command("cancel"), "ready-abort"); goto retire; }
  REQUIRE(command("start"), "explicit-start");
  REQUIRE(WriteFile(inputW, "START\n", 6, &flags, NULL) && flags == 6, "start-delivery");
  transfer.from = GetStdHandle(STD_INPUT_HANDLE); transfer.to = inputW;
  thread = CreateThread(NULL, 0, pump, &transfer, 0, NULL); REQUIRE(thread, "stdin-pump");
  inputW = NULL;
  REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"git-started\""), "git-start-receipt");
  {
    char *pid = strstr(text, "\"pid\":"); DWORD gitPid;
    REQUIRE(pid, "git-pid-provenance"); gitPid = (DWORD)strtoul(pid + 6, NULL, 10);
    sensitive[0] = control; sensitive[1] = resultR; sensitive[2] = resultW;
    sensitive[3] = job; sensitive[4] = pi.hProcess; sensitive[5] = pi.hThread; sensitive[6] = transfer.to;
    REQUIRE(audit(gitPid, job, sensitive, 7), "git-sensitive-handle-exclusion");
  }
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"git-audit\"}"), "git-audit-receipt");
  REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"result\""), "genuine-command-result");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"result\",\"shim\":%s,\"active\":%lu}", text, active(job, &ok)) && ok, "result-forward");
  REQUIRE(members(job), "retained-job-descendant-census");
  if (wcscmp(argv[4], L"model-query") == 0) {
    (void)active(NULL, &ok); error = GetLastError(); REQUIRE(!ok, "modeled-query-refusal");
    emit("{\"role\":\"owner\",\"stage\":\"modeled-query-refusal\",\"error\":%lu}", error);
  }
  REQUIRE(command("cancel"), "post-result-seal-authorization");
retire:
  if (!assigned && pi.hProcess) {
    REQUIRE(TerminateProcess(pi.hProcess, 70), "unassigned-root-test-owner-terminate");
    REQUIRE(WaitForSingleObject(pi.hProcess, 2000) == WAIT_OBJECT_0, "unassigned-root-retired");
  }
  REQUIRE(TerminateJobObject(job, 71), "seal-job"); sealed = 1;
  REQUIRE(zero(job), "retained-sealed-job-zero"); drained = 1;
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"sealed-zero\",\"active\":0,\"assigned\":%s}", assigned ? "true" : "false"), "zero-receipt");
  rc = 0;
done:
  if (rc && pi.hProcess && !assigned && !stranded) { TerminateProcess(pi.hProcess, 72); WaitForSingleObject(pi.hProcess, 2000); }
  if (job && !stranded && !sealed) { sealed = TerminateJobObject(job, 73); drained = sealed && zero(job); }
  if (thread) {
    CancelSynchronousIo(thread);
    if (WaitForSingleObject(thread, 2000) != WAIT_OBJECT_0) { stage = "stdin-pump-retirement"; error = GetLastError(); rc = 1; }
    CloseHandle(thread);
  }
  receipt(argv[6], stage, sealed, drained, error);
  if (pi.hThread) CloseHandle(pi.hThread); if (pi.hProcess) CloseHandle(pi.hProcess);
  if (inputR) CloseHandle(inputR); if (inputW) CloseHandle(inputW);
  if (resultR) CloseHandle(resultR); if (resultW) CloseHandle(resultW);
  if (handles[1]) CloseHandle(handles[1]); if (handles[2]) CloseHandle(handles[2]);
  if (job) CloseHandle(job); if (environment) HeapFree(GetProcessHeap(), 0, environment);
  return rc;
}
`

const shimSource = String.raw`
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const [role, mode, marker] = process.argv.slice(2);
const send = (value) => {
  const body = Buffer.from(JSON.stringify({ role: "shim", ...value }));
  if (body.length > 16380) throw Error("frame bound");
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  fs.writeSync(3, Buffer.concat([head, body]));
};
if (role === "survivor") {
  if (mode === "nested") {
    const leaf = spawn(process.execPath, [__filename, "survivor", "leaf", marker], { detached: true, stdio: "ignore" });
    fs.appendFileSync(marker + ".survivors", leaf.pid + "\n"); leaf.unref();
  }
  setInterval(() => {}, 1000);
} else if (role === "hook") {
  const git = spawn("git", ["hash-object", "--stdin"], { stdio: ["pipe", "inherit", "inherit"] });
  process.stdin.pipe(git.stdin);
  git.on("exit", (code) => { process.exitCode = code === null ? 1 : code; });
} else {
  fs.writeFileSync(marker, "first-instruction");
  send({ stage: "ready", node: process.version, execPath: process.execPath,
    bootstrapNodeOptions: process.env.NODE_OPTIONS ?? null, bootstrapNodePath: process.env.NODE_PATH ?? null });
  let pending = Buffer.alloc(0), started = false;
  process.stdin.on("data", function input(chunk) {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(10);
    if (end < 0) return;
    if (started || pending.subarray(0, end).toString() !== "START") throw Error("start gate");
    started = true; process.stdin.pause(); process.stdin.removeListener("data", input);
    fs.writeFileSync(marker + ".command", "explicit-start");
    const survivor = spawn(process.execPath, [__filename, "survivor", "nested", marker], { detached: true, stdio: "ignore" });
    fs.appendFileSync(marker + ".survivors", survivor.pid + "\n"); survivor.unref();
    const launchGit = () => {
    if ((fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n")).length !== 2) {
      if (Date.now() - waiting >= 2000) throw Error("nested descendant ready deadline");
      setTimeout(launchGit, 5); return;
    }
    const env = { ...process.env, NODE_OPTIONS: process.env.OWNED_PROBE_PRELOAD,
      NODE_PATH: process.env.OWNED_PROBE_NODE_PATH, OWNED_PROBE_ROLE: "downstream" };
    const alias = '!"' + process.execPath.replaceAll("\\", "/") + '" "' + __filename.replaceAll("\\", "/") + '" hook';
    const git = spawn("git", ["-c", "alias.probe=" + alias, "probe"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let data = "", error = "", inputComplete = false;
    git.stdout.on("data", (chunk) => { data += chunk; process.stdout.write(chunk); });
    git.stderr.on("data", (chunk) => { error += chunk; process.stderr.write(chunk); });
    git.on("error", (error) => { throw error; });
    send({ stage: "git-started", pid: git.pid });
    git.stdin.write(pending.subarray(end + 1)); pending = null;
    process.stdin.on("data", (chunk) => git.stdin.write(chunk));
    process.stdin.on("end", () => git.stdin.end(() => { inputComplete = true; }));
    process.stdin.resume();
    git.on("close", (code, signal) => {
      send({ stage: "result", code, signal, inputComplete, data, error });
      process.stdout.write("AFTER_RESULT\n");
      setInterval(() => {}, 1000);
    });
    };
    const waiting = Date.now(); launchGit();
  });
}
`

const buildSource = String.raw`
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path $vswhere)) { throw 'STOP missing installed vswhere' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'STOP missing installed VC toolchain' }
$devcmd = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$compiler = Join-Path $installation 'VC\Tools\Llvm\x64\bin\clang-cl.exe'
if (!(Test-Path $compiler)) { throw 'STOP missing installed clang-cl' }
$out = Join-Path $Root 'probe-owner.exe'
$source = Join-Path $Root 'probe-owner.c'
$identity = Join-Path $Root 'toolchain.txt'
$cmd = 'call "' + $devcmd + '" -arch=x64 -host_arch=x64 >nul && "' + $compiler + '" --version && set WindowsSDK && "' + $compiler + '" /nologo /W4 /WX /MT /O2 "' + $source + '" /Fe:"' + $out + '" /Fo:"' + (Join-Path $Root 'probe-owner.obj') + '" /link kernel32.lib advapi32.lib && dumpbin /dependents "' + $out + '"'
& $env:ComSpec /d /s /c $cmd 2>&1 | Tee-Object -FilePath $identity
if ($LASTEXITCODE -ne 0) { throw "STOP compiler exit $LASTEXITCODE" }
`

const driverSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const report = { status: "RUNNING", pure: true, sqliteLoaded: false, cases: [], stranded: [],
  driver: { version: process.version, execPath: process.execPath, cwd: process.cwd() },
  wire: { header: 4, body: 16380, total: 16384, rejectedBodies: [16381,16385] } };
const save = () => fs.writeFileSync(config.report, JSON.stringify(report, null, 2));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function encode(value) {
  const body = Buffer.from(JSON.stringify(value)); assert.ok(body.length <= 16380);
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]);
}
function session(node, mode, marker, receipt) {
  const log = marker + ".jsonl";
  const child = spawn(config.owner, ["owner", node, config.shim, mode, marker, receipt], {
    cwd: config.neutral, stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: '--require="' + config.preload + '"',
      NODE_PATH: config.publicRoot, OWNED_PROBE_ROLE: "shim", OWNED_PROBE_MARKER: marker,
      OWNED_PROBE_PRELOAD: '--require="' + config.preload + '"', OWNED_PROBE_NODE_PATH: config.publicRoot }
  });
  const events = [], backlog = [];
  let pending = Buffer.alloc(0), failure, stdout = "", stderr = "", eof = false;
  const append = (value) => { fs.appendFileSync(log, JSON.stringify({ time: Date.now(), ...value }) + "\n"); };
  const closed = new Promise((resolve) => child.on("close", (code, signal) => {
    append({ closed: true, code, signal }); resolve({ code, signal });
  }));
  child.on("error", (error) => { failure = error; append({ error: error.stack }); });
  child.stdout.on("data", (chunk) => { stdout += chunk; append({ stdout: chunk.toString("utf8") }); });
  child.stdout.on("end", () => { eof = true; append({ stdoutEOF: true }); });
  child.stderr.on("data", (chunk) => { stderr += chunk; append({ stderr: chunk.toString("utf8") }); });
  child.stdio[3].on("error", (error) => { append({ controlError: error.message }); });
  child.stdin.on("error", (error) => { append({ inputError: error.message }); });
  child.stdio[3].on("data", (chunk) => {
    try {
      append({ controlBytes: chunk.toString("hex") });
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const n = pending.readUInt32LE(); assert.ok(n <= 16380, "encoded frame bound");
        if (pending.length < n + 4) break;
        const event = JSON.parse(pending.subarray(4, n + 4).toString("utf8"));
        assert.equal(event.role, "owner", "control provenance");
        append({ control: event }); events.push(event); backlog.push(event);
        pending = pending.subarray(n + 4);
      }
    } catch (error) { failure = error; append({ parserError: error.stack }); }
  });
  return {
    child, events, closed, send: (cmd) => { append({ sent: cmd }); child.stdio[3].write(encode({ cmd })); },
    stdout: () => stdout, stderr: () => stderr, eof: () => eof,
    async take(stage) {
      const end = Date.now() + 2000;
      while (Date.now() < end) {
        if (failure) throw failure;
        const i = backlog.findIndex((value) => value.stage === stage);
        if (i >= 0) return backlog.splice(i, 1)[0];
        if (child.exitCode !== null) throw Error("owner exited waiting " + stage + ": " + stderr);
        await delay(5);
      }
      throw Error("2000ms waiting " + stage + ": " + stderr);
    }
  };
}
async function one(identity, mode) {
  const marker = path.join(config.evidence, identity.version + "-" + mode);
  const receipt = marker + ".receipt.json";
  const record = { node: identity, mode, kind: mode.startsWith("model-") ? "modeled fault with real retirement" : "real kernel", marker, receipt };
  report.cases.push(record); save();
  const s = session(identity.path, mode, marker, receipt);
  record.pid = s.child.pid;
  try {
    const hello = await s.take("hello");
    assert.equal(hello.administrator, false); assert.equal(hello.elevated, false);
    s.send("prepare"); const created = await s.take("created"); record.rootPid = created.pid;
    assert.equal(fs.existsSync(marker), false, "suspended root executed before assignment");
    if (mode === "model-assignment") {
      const fault = await s.take("modeled-assignment-refusal");
      assert.notEqual(fault.error, 0); report.stranded.push(fault.strandedSuspendedPid);
      assert.equal(fs.existsSync(marker), false); assert.equal((await s.closed).code, 0);
      record.ownership = "intentionally stranded suspended root; broader synthetic owner must retire"; return;
    }
    if (mode === "cancel-created") s.send("cancel");
    else {
      s.send("assign"); const assigned = await s.take("assigned-suspended");
      assert.equal(assigned.active, 1); assert.equal(fs.existsSync(marker), false);
      if (mode === "cancel-assigned") s.send("cancel");
      else if (mode === "model-resume") {
        assert.notEqual((await s.take("modeled-resume-refusal")).error, 0);
      } else {
        s.send("resume"); const ready = await s.take("ready");
        assert.equal(ready.shim.role, "shim"); assert.equal(ready.shim.node, identity.version);
        assert.equal(path.resolve(ready.shim.execPath).toLowerCase(), path.resolve(identity.path).toLowerCase());
        assert.equal(ready.shim.bootstrapNodeOptions, null); assert.equal(ready.shim.bootstrapNodePath, null);
        await delay(100);
        assert.equal(fs.existsSync(marker + ".command"), false, "command started before explicit start");
        assert.equal(fs.existsSync(marker + ".preload-shim"), false, "caller preload ran inside authority shim");
        if (mode === "ready-abort") s.send("cancel");
        else if (mode === "parent-loss") {
          s.child.stdin.end(); s.child.stdio[3].destroy();
          assert.equal((await s.closed).code, 1);
          record.loss = JSON.parse(fs.readFileSync(receipt, "utf8"));
          assert.equal(record.loss.sealed, true); assert.equal(record.loss.exactJobZero, true);
          assert.equal(fs.existsSync(marker + ".command"), false);
          return;
        } else {
          s.send("start"); await s.take("git-audit");
          const audits = s.events.filter((e) => e.stage === "peer-handle");
          assert.equal(audits.length, 7); assert.ok(audits.every((e) => !e.sameObject));
          s.child.stdin.end("hello\n");
          const result = await s.take("result");
          assert.equal(result.shim.role, "shim");
          assert.equal(result.shim.code, 0); assert.equal(result.shim.signal, null);
          assert.equal(result.shim.inputComplete, true, "actual final input delivery required before termination");
          assert.equal(result.shim.data.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
          assert.equal(s.eof(), false, "result must precede data EOF");
          const census = await s.take("job-members");
          const survivors = fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").map(Number);
          assert.equal(survivors.length, 2); assert.ok(survivors.every((pid) => census.pids.includes(pid)));
          assert.ok(census.pids.includes(created.pid)); assert.ok(result.active >= 3);
          assert.equal(s.events.some((e) => e.stage === "sealed-zero"), false, "survivor cannot produce zero certificate");
          const preload = JSON.parse(fs.readFileSync(marker + ".preload-downstream", "utf8"));
          assert.equal(preload.role, "downstream"); assert.equal(preload.nodePath, config.publicRoot);
          assert.equal(fs.existsSync(marker + ".preload-shim"), false);
          record.survivors = survivors; record.result = result; record.resultBeforeEOF = true;
          if (mode === "helper-loss") {
            assert.equal(s.child.kill(), true); await s.closed;
            assert.equal(s.events.some((e) => e.stage === "sealed-zero"), false);
            record.ownership = "helper killed; no private job certificate; broader owner must account real remaining resources";
            return;
          }
          if (mode === "model-query") assert.notEqual((await s.take("modeled-query-refusal")).error, 0);
          s.send("cancel");
        }
      }
    }
    const cert = await s.take("sealed-zero");
    assert.equal(cert.active, 0);
    s.child.stdin.end();
    assert.equal((await s.closed).code, 0);
    const retired = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(retired.sealed, true); assert.equal(retired.exactJobZero, true);
    if (["cancel-created", "cancel-assigned", "model-resume", "ready-abort"].includes(mode)) {
      assert.equal(fs.existsSync(marker + ".command"), false);
    }
    record.retirement = retired;
  } catch (error) {
    record.failure = error.stack; throw error;
  } finally {
    record.events = s.events; record.stdout = s.stdout(); record.stderr = s.stderr();
    record.status = record.failure ? "FAIL" : "PASS";
    save();
    /* No scan/taskkill fallback: the native broader owner retains the exact test job. */
    if (record.failure) { s.child.stdin.end(); s.child.stdio[3].destroy(); }
  }
}
(async () => {
  assert.notEqual(process.cwd(), config.sourceRoot);
  assert.equal(process.cwd(), config.neutral);
  for (const entry of config.manifest) {
    assert.equal(createHash("sha256").update(fs.readFileSync(entry.path)).digest("hex"), entry.sha256, "public asset changed");
    assert.ok(path.resolve(entry.path).startsWith(path.resolve(config.publicRoot) + path.sep));
  }
  for (const identity of config.nodes) {
    const value = require("node:child_process").spawnSync(identity.path, ["--version"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    assert.equal(value.status, 0); assert.equal(value.stdout.trim(), identity.version);
    assert.equal(createHash("sha256").update(fs.readFileSync(identity.path)).digest("hex"), identity.sha256);
    for (const mode of ["normal", "cancel-created", "cancel-assigned", "ready-abort", "model-query", "model-resume", "model-assignment", "parent-loss", "helper-loss"]) {
      await one(identity, mode);
    }
  }
  assert.equal(Object.keys(require.cache).some((name) => /sqlite/i.test(name)), false);
  report.status = "PASS"; save();
})().catch((error) => { report.status = "STOP"; report.failure = error.stack; save(); console.error(error); process.exitCode = 1; });
`

const preloadSource = String.raw`
const fs = require("node:fs");
fs.writeFileSync(process.env.OWNED_PROBE_MARKER + ".preload-" + process.env.OWNED_PROBE_ROLE,
  JSON.stringify({ role: process.env.OWNED_PROBE_ROLE, nodePath: process.env.NODE_PATH, version: process.version }));
`

export const probeMaterial = {
  "probe-owner.c": ownerSource,
  "probe-shim.cjs": shimSource,
  "probe.test.cjs": driverSource,
  "build.ps1": buildSource,
  "preload.cjs": preloadSource,
}

test("Windows installed-layout owned-Git feasibility (STOP on any unqualified boundary)", {
  skip: process.platform !== "win32",
  timeout: 180000,
}, () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
  const root = path.join(repo, "owned-git-probe-output")
  const sourceRoot = path.join(root, "source")
  const publicRoot = path.join(root, "artifacts", "owned-git", "win32-x64")
  const neutral = path.join(root, "neutral")
  const evidence = path.join(root, "evidence")
  for (const folder of [sourceRoot, publicRoot, neutral, evidence]) fs.mkdirSync(folder, { recursive: true })
  const status = { status: "STAGING", root, sourceRoot, publicRoot, neutral, wire: { header: 4, body: 16380, total: 16384 } }
  const write = () => fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(status, null, 2))
  const exec = (command, args, options = {}) => {
    const value = spawnSync(command, args, { encoding: "utf8", cwd: neutral, timeout: 120000, ...options })
    const name = options.label ?? path.basename(command)
    fs.writeFileSync(path.join(evidence, name + ".stdout"), value.stdout ?? "")
    fs.writeFileSync(path.join(evidence, name + ".stderr"), value.stderr ?? "")
    status[name] = { command, args, code: value.status, signal: value.signal, error: value.error?.message }
    write()
    assert.equal(value.status, 0, name + " failed; full output in retained evidence: " + value.stderr)
    return value
  }
  try {
    for (const [name, text] of Object.entries(probeMaterial)) fs.writeFileSync(path.join(sourceRoot, name), text)
    write()
    exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(sourceRoot, "build.ps1"), "-Root", sourceRoot], { label: "build" })
    const toolchain = fs.readFileSync(path.join(sourceRoot, "toolchain.txt"), "utf8")
    assert.doesNotMatch(toolchain, /(?:VCRUNTIME|MSVCP|ucrtbase)\d*\.dll/i, "static CRT required")
    for (const name of ["probe-owner.exe", "probe-shim.cjs", "probe.test.cjs", "preload.cjs"]) {
      fs.copyFileSync(path.join(sourceRoot, name), path.join(publicRoot, name))
    }
    const digest = (name) => createHash("sha256").update(fs.readFileSync(name)).digest("hex")
    const manifest = ["probe-owner.exe", "probe-shim.cjs", "probe.test.cjs", "preload.cjs"].map((name) => ({
      path: path.join(publicRoot, name), sha256: digest(path.join(publicRoot, name)),
    }))
    fs.writeFileSync(path.join(publicRoot, "sha256-manifest.json"), JSON.stringify(manifest, null, 2))
    const nodes = JSON.parse(fs.readFileSync(path.join(repo, "owned-git-probe-interpreters.json"), "utf8"))
    assert.equal(nodes.length, 3)
    assert.equal(nodes[0].version, "v20.0.0")
    assert.match(nodes[1].version, /^v22\.\d+\.\d+$/)
    assert.equal(nodes[2].version, "v24.18.0")
    for (const node of nodes) {
      node.sha256 = node.sha256.toLowerCase()
      assert.equal(digest(node.path), node.sha256, "provisioned interpreter changed")
    }
    const config = {
      publicRoot, sourceRoot, neutral, evidence, nodes, manifest,
      owner: path.join(publicRoot, "probe-owner.exe"),
      shim: path.join(publicRoot, "probe-shim.cjs"),
      preload: path.join(publicRoot, "preload.cjs"),
      report: path.join(evidence, "worker-report.json"),
    }
    const configPath = path.join(publicRoot, "config.json")
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    status.nodes = nodes
    status.manifest = manifest
    status.sources = Object.keys(probeMaterial).map((name) => ({ name, sha256: digest(path.join(sourceRoot, name)) }))
    status.layout = { sourceRoot, publicRoot, neutral, publicNodeLocations: nodes.map((n) => n.path) }
    write()
    exec("git", ["init", "--quiet", neutral], { label: "synthetic-git-init" })
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("NODE_")) delete env[key]
    const supervisorReceipt = path.join(evidence, "broader-owner.json")
    exec(config.owner, ["--supervise", nodes[2].path, path.join(publicRoot, "probe.test.cjs"), configPath, supervisorReceipt], {
      env, label: "supervisor",
    })
    const worker = JSON.parse(fs.readFileSync(config.report, "utf8"))
    const broader = JSON.parse(fs.readFileSync(supervisorReceipt, "utf8"))
    status.broader = broader
    assert.equal(broader.sealed, true)
    assert.equal(broader.exactJobZero, true)
    assert.deepEqual([...broader.retiredPids].sort((a, b) => a - b), [...worker.stranded].sort((a, b) => a - b),
      "broader owner must account exactly the purposely stranded suspended roots; helper-loss resources must already have drained")
    assert.equal(worker.status, "PASS")
    assert.equal(worker.cases.length, 27)
    status.status = "PASS"
    write()
  } catch (error) {
    status.status = "STOP"; status.failure = error.stack; write(); throw error
  }
})
