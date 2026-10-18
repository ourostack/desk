/* Test infrastructure only. No product/fault include, PID reopen or certificate.
 * Configuration and observations are a separate private test channel, not the
 * owned-Git protocol. All pending storage belongs to the heap-owned supervisor.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <float.h>

#define ALLOCATION "e46fbabf1bc604b2531d3c3e573ea2110cbfb2282e3717ca72d68766ce6acee4"
#define FRAME_MAX 4096
typedef struct {
  HANDLE handles[64]; unsigned count;
  HANDLE control, job;
  PROCESS_INFORMATION controller;
  OVERLAPPED input, output, file_io;
  int input_pending, output_pending, file_pending;
  unsigned char incoming[FRAME_MAX + 5], outgoing[FRAME_MAX + 4];
  DWORD input_used, input_target;
  uint64_t H, end, stop_controller, frequency, last;
  DWORD controller_pid;
  int created, assigned, resumed, retired, unassigned_retired, sealed, zero, failed;
  int mode, control_reaped, critical_closed, control_is_crt, clock_failed;
  char nonce[65], revision[41], tree[41], manifest[65], source_manifest[65];
  wchar_t root[32768], realm[32768], node[32768], script[32768], repository[32768], self[32768];
  wchar_t environment[32768];
  char file_bytes[FRAME_MAX + 1];
} SUPERVISOR;

static int private_handle(HANDLE h) {
  DWORD flags;
  return h && h != INVALID_HANDLE_VALUE && SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) &&
    GetHandleInformation(h, &flags) && !(flags & HANDLE_FLAG_INHERIT);
}
static int track(SUPERVISOR *s, HANDLE h, int inherited) {
  DWORD flags;
  if (!h || h == INVALID_HANDLE_VALUE) return 0;
  if (s->count == 64) { CloseHandle(h); s->failed = 1; return 0; }
  s->handles[s->count++] = h;
  if (inherited) return GetHandleInformation(h, &flags) && (flags & HANDLE_FLAG_INHERIT);
  return private_handle(h);
}
static int drop(SUPERVISOR *s, HANDLE h) {
  unsigned i;
  for (i = 0; i < s->count; ++i) if (s->handles[i] == h) {
    if (!CloseHandle(h)) { s->failed = 1; return 0; }
    s->handles[i] = NULL;
    return 1;
  }
  s->failed = 1; return 0;
}
static int close_registry(SUPERVISOR *s) {
  unsigned i; int good = 1;
  for (i = s->count; i > 0; --i) if (s->handles[i - 1] && !drop(s, s->handles[i - 1])) good = 0;
  return good;
}
static int decimal(const char *p, uint64_t *value) {
  uint64_t n = 0; unsigned length = 0;
  if (!*p || (*p == '0' && p[1])) return 0;
  for (; *p; ++p) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9 || ++length > 20 || n > (UINT64_MAX - d) / 10) return 0;
    n = n * 10 + d;
  }
  *value = n; return 1;
}
static int sample(SUPERVISOR *s, uint64_t *value) {
  LARGE_INTEGER q, f; volatile double scale, ns;
  if (s->clock_failed || !QueryPerformanceCounter(&q) || !QueryPerformanceFrequency(&f) ||
      q.QuadPart <= 0 || f.QuadPart <= 0 || (s->last && (uint64_t)q.QuadPart < s->last) ||
      (s->frequency && (uint64_t)f.QuadPart != s->frequency)) {
    s->clock_failed = s->failed = 1; return 0;
  }
  s->frequency = (uint64_t)f.QuadPart; s->last = (uint64_t)q.QuadPart;
  scale = (double)f.QuadPart / 1000000000.0;
  ns = (double)((uint64_t)q.QuadPart + 1) / scale;
  if (ns < 0.0 || ns >= 18446744073709551616.0) { s->clock_failed = s->failed = 1; return 0; }
  *value = (uint64_t)ns; return 1;
}
static int live(SUPERVISOR *s) { uint64_t n; return sample(s, &n) && n < s->end; }
static int env_decimal(const wchar_t *name, uint64_t *value) {
  wchar_t wide[32]; char text[32]; DWORD n = GetEnvironmentVariableW(name, wide, 32);
  return n && n < 32 &&
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1, text, sizeof(text), NULL, NULL) &&
    decimal(text, value);
}
static int hex(const char *p, size_t length) {
  size_t i; if (strlen(p) != length) return 0;
  for (i = 0; i < length; ++i) if (!((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f'))) return 0;
  return 1;
}
static int string(const char **cursor, char *out, size_t capacity) {
  const unsigned char *p = (const unsigned char *)*cursor; size_t used = 0;
  if (*p++ != '"') return 0;
  while (*p && *p != '"') {
    unsigned char c = *p++;
    if (c == '\\') { c = *p++; if (c != '\\' && c != '"') return 0; }
    if (c < 32 || used + 1 >= capacity) return 0;
    out[used++] = (char)c;
  }
  if (*p++ != '"') return 0;
  out[used] = 0; *cursor = (const char *)p; return 1;
}
static int regular_long_path(const wchar_t *file, int directory) {
  wchar_t full[32768], long_name[32768]; DWORD n, attributes;
  size_t i, length = wcslen(file);
  if (length < 3 || file[1] != L':' || file[2] != L'\\' || wcschr(file, L'~') || wcschr(file, L'"') ||
      wcschr(file + 2, L':')) return 0;
  n = GetFullPathNameW(file, 32768, full, NULL);
  if (!n || n >= 32768 || _wcsicmp(file, full)) return 0;
  n = GetLongPathNameW(file, long_name, 32768);
  if (!n || n >= 32768 || _wcsicmp(file, long_name)) return 0;
  for (i = 3; i <= length; ++i) if (file[i] == L'\\' || i == length) {
    wchar_t saved = full[i]; full[i] = 0;
    attributes = GetFileAttributesW(full); full[i] = saved;
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        (i < length && !(attributes & FILE_ATTRIBUTE_DIRECTORY))) return 0;
  }
  attributes = GetFileAttributesW(file);
  return !!(attributes & FILE_ATTRIBUTE_DIRECTORY) == !!directory;
}
static int configuration(SUPERVISOR *s) {
  static const char *names[] = { "schema", "Hns", "deadlineNs", "nonce", "sourceRevision", "sourceTree",
    "allocationSha256", "fixtureManifestSha256", "sourceManifestSha256", "node", "repositoryRoot" };
  char values[11][FRAME_MAX + 1], key[64]; const char *p = (const char *)s->incoming + 4;
  uint64_t H, end, current; unsigned seen = 0, i;
  if (*p++ != '{') return 0;
  for (i = 0; i < 11; ++i) {
    unsigned k;
    if (i && *p++ != ',') return 0;
    if (!string(&p, key, sizeof(key)) || *p++ != ':') return 0;
    for (k = 0; k < 11 && strcmp(key, names[k]); ++k) {}
    if (k == 11 || (seen & (1u << k)) || !string(&p, values[k], sizeof(values[k]))) return 0;
    seen |= 1u << k;
  }
  if (*p++ != '}' || *p || seen != 2047 ||
      strcmp(values[0], "desk.owned-git-supervisor-config/1") ||
      !decimal(values[1], &H) || H != s->H || !decimal(values[2], &end) || end > s->end ||
      !hex(values[3], 64) || !hex(values[4], 40) || !hex(values[5], 40) ||
      strcmp(values[6], ALLOCATION) || !hex(values[7], 64) || !hex(values[8], 64) ||
      !sample(s, &current) || end <= current) return 0;
  if ((!s->mode && end != s->H - 15000000000ULL) ||
      (s->mode && (end > s->H - 12000000000ULL))) return 0;
  s->end = end;
  s->stop_controller = s->mode ? end : s->H - 20000000000ULL;
  strcpy_s(s->nonce, sizeof(s->nonce), values[3]); strcpy_s(s->revision, sizeof(s->revision), values[4]);
  strcpy_s(s->tree, sizeof(s->tree), values[5]); strcpy_s(s->manifest, sizeof(s->manifest), values[7]);
  strcpy_s(s->source_manifest, sizeof(s->source_manifest), values[8]);
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, values[9], -1, s->node, 32768) ||
      !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, values[10], -1, s->repository, 32768) ||
      !regular_long_path(s->node, 0) || !regular_long_path(s->repository, 1)) return 0;
  i = (unsigned)wcslen(s->node);
  if (i < 9 || _wcsicmp(s->node + i - 8, L"node.exe") ||
      swprintf_s(s->script, 32768, L"%ls\\tests\\desk\\mcp\\__tests__\\runtime\\fixtures\\windows_owned_git_driver.cjs",
        s->repository) < 0 || !regular_long_path(s->script, 0)) return 0;
  return 1;
}
static int reap(SUPERVISOR *s, HANDLE file, OVERLAPPED *ov, int *pending) {
  DWORD n, error;
  if (!*pending) return 1;
  if (!CancelIoEx(file, ov) && GetLastError() != ERROR_NOT_FOUND) return 0;
  while (live(s)) {
    if (GetOverlappedResult(file, ov, &n, FALSE)) { *pending = 0; return 1; }
    error = GetLastError();
    if (error == ERROR_OPERATION_ABORTED || error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
      *pending = 0; return 1;
    }
    if (error != ERROR_IO_INCOMPLETE) return 0;
    Sleep(1);
  }
  return 0;
}
static int send_bytes(SUPERVISOR *s, HANDLE file, DWORD length, OVERLAPPED *ov, int *pending) {
  DWORD offset = 0, n, error; BOOL ok;
  if (*pending || length > sizeof(s->outgoing)) return 0;
  while (offset < length && live(s)) {
    if (!ResetEvent(ov->hEvent)) return 0;
    ov->Internal = ov->InternalHigh = 0;
    ov->Offset = ov == &s->file_io ? offset : 0;
    ov->OffsetHigh = 0;
    ok = WriteFile(file, s->outgoing + offset, length - offset, &n, ov); error = GetLastError();
    if (!ok && error == ERROR_IO_PENDING) {
      *pending = 1;
      while (live(s)) {
        ok = GetOverlappedResult(file, ov, &n, FALSE); error = GetLastError();
        if (ok || error != ERROR_IO_INCOMPLETE) { *pending = 0; break; }
        Sleep(1);
      }
      if (*pending) return 0;
    }
    if (!ok || !n || n > length - offset) return 0;
    offset += n;
  }
  return offset == length && live(s);
}
static int event_frame(SUPERVISOR *s, const char *type, const char *extra) {
  int n = sprintf_s((char *)s->outgoing + 4, FRAME_MAX,
    "{\"schema\":\"desk.owned-git-supervisor-event/1\",\"type\":\"%s\",\"nonce\":\"%s\"%s}",
    type, s->nonce, extra);
  DWORD length;
  if (n <= 0 || n > FRAME_MAX) return 0;
  length = (DWORD)n; memcpy(s->outgoing, &length, 4);
  return send_bytes(s, s->control, length + 4, &s->output, &s->output_pending);
}
static int input_poll(SUPERVISOR *s) {
  DWORD n = 0, error; BOOL ok;
  if (s->input_pending) {
    ok = GetOverlappedResult(s->control, &s->input, &n, FALSE); error = GetLastError();
    if (!ok && error == ERROR_IO_INCOMPLETE) return 1;
    s->input_pending = 0;
    if (!ok || !n || n > s->input_target - s->input_used) return 0;
    s->input_used += n;
  }
  if (s->input_used == s->input_target) return 2;
  if (!ResetEvent(s->input.hEvent)) return 0;
  ok = ReadFile(s->control, s->incoming + s->input_used, s->input_target - s->input_used, &n, &s->input);
  error = GetLastError();
  if (!ok && error == ERROR_IO_PENDING) { s->input_pending = 1; return 1; }
  if (!ok || !n || n > s->input_target - s->input_used) return 0;
  s->input_used += n; return s->input_used == s->input_target ? 2 : 1;
}
static int receive_config(SUPERVISOR *s) {
  int status = 0; DWORD body;
  s->input_target = 4;
  while (live(s) && (status = input_poll(s)) == 1) Sleep(1);
  if (!live(s) || status != 2) return 0;
  memcpy(&body, s->incoming, 4);
  if (!body || body > FRAME_MAX) return 0;
  s->input_target = body + 4;
  while (live(s) && (status = input_poll(s)) == 1) Sleep(1);
  if (!live(s) || status != 2) return 0;
  s->incoming[s->input_target] = 0;
  if (memchr(s->incoming + 4, 0, body)) return 0;
  return configuration(s);
}
static int protected_realm(SUPERVISOR *s) {
  HANDLE token = NULL, directory = INVALID_HANDLE_VALUE;
  DWORD needed = 0, size, acl_bytes; TOKEN_USER *user = NULL; TOKEN_ELEVATION elevation;
  ACL *acl = NULL; SECURITY_DESCRIPTOR sd; SECURITY_ATTRIBUTES sa;
  PSECURITY_DESCRIPTOR actual = NULL; PACL actual_acl = NULL; PSID owner = NULL;
  SECURITY_DESCRIPTOR_CONTROL control; DWORD revision; int good = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) || !track(s, token, 0)) goto done;
  size = sizeof(elevation);
  if (!GetTokenInformation(token, TokenElevation, &elevation, size, &size) || elevation.TokenIsElevated) goto done;
  if (GetTokenInformation(token, TokenUser, NULL, 0, &needed) || GetLastError() != ERROR_INSUFFICIENT_BUFFER) goto done;
  user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, needed);
  if (!user || !GetTokenInformation(token, TokenUser, user, needed, &needed) || !IsValidSid(user->User.Sid)) goto done;
  acl_bytes = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) + GetLengthSid(user->User.Sid);
  acl = (ACL *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, acl_bytes);
  if (!acl || !InitializeAcl(acl, acl_bytes, ACL_REVISION) ||
      !AddAccessAllowedAceEx(acl, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, FILE_ALL_ACCESS, user->User.Sid) ||
      !InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&sd, user->User.Sid, FALSE) || !SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) goto done;
  size = GetCurrentDirectoryW(32768, s->root);
  if (!size || size >= 32768 || !regular_long_path(s->root, 1) ||
      swprintf_s(s->realm, 32768, L"%ls\\private", s->root) < 0) goto done;
  sa.nLength = sizeof(sa); sa.lpSecurityDescriptor = &sd; sa.bInheritHandle = FALSE;
  if (!CreateDirectoryW(s->realm, &sa)) goto done;
  directory = CreateFileW(s->realm, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (!track(s, directory, 0) || !regular_long_path(s->realm, 1) ||
      GetSecurityInfo(directory, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &actual_acl, NULL, &actual) != ERROR_SUCCESS ||
      !owner || !EqualSid(owner, user->User.Sid) || !actual_acl || actual_acl->AceCount != 1 ||
      !GetSecurityDescriptorControl(actual, &control, &revision) || !(control & SE_DACL_PROTECTED)) goto done;
  {
    ACCESS_ALLOWED_ACE *ace = NULL;
    if (!GetAce(actual_acl, 0, (LPVOID *)&ace) || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        ace->Header.AceFlags != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) ||
        ace->Mask != FILE_ALL_ACCESS || !EqualSid((PSID)&ace->SidStart, user->User.Sid)) goto done;
  }
  good = 1;
done:
  if (actual && LocalFree(actual)) good = 0;
  if (directory != INVALID_HANDLE_VALUE && !drop(s, directory)) good = 0;
  if (acl && !HeapFree(GetProcessHeap(), 0, acl)) good = 0;
  if (user && !HeapFree(GetProcessHeap(), 0, user)) good = 0;
  if (token && !drop(s, token)) good = 0;
  return good;
}
static int environment(SUPERVISOR *s) {
  static const wchar_t *keys[] = { L"COMSPEC", L"LANG", L"LC_ALL", L"PATH", L"PATHEXT",
    L"SystemDrive", L"SystemRoot", L"TEMP", L"TMP", L"WINDIR" };
  wchar_t (*lines)[32768], value[32768]; unsigned count = 0, i, j; size_t used = 0; int n, good = 0;
  lines = (wchar_t (*)[32768])HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 20 * 32768 * sizeof(wchar_t));
  if (!lines) return 0;
  for (i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
    DWORD length = GetEnvironmentVariableW(keys[i], value, 32768);
    if (length >= 32768) goto done;
    if (length) {
      if (swprintf_s(lines[count++], 32768, L"%ls=%ls", keys[i], value) < 0) goto done;
    }
  }
#define ADD_ENV(...) do { if (count == 20 || swprintf_s(lines[count++], 32768, __VA_ARGS__) < 0) goto done; } while (0)
  ADD_ENV(L"DESK_TEST_OWNED_GIT_H=%llu", (unsigned long long)s->H);
  ADD_ENV(L"DESK_TEST_OWNED_GIT_D=%llu", (unsigned long long)s->end);
  ADD_ENV(L"DESK_TEST_OWNED_GIT_PRIVATE=%ls", s->realm);
  ADD_ENV(L"DESK_TEST_OWNED_GIT_NATIVE=1");
  ADD_ENV(L"DESK_TEST_OWNED_GIT_NONCE=%S", s->nonce);
  ADD_ENV(L"DESK_TEST_OWNED_GIT_SOURCE_REVISION=%S", s->revision);
  ADD_ENV(L"DESK_TEST_OWNED_GIT_SOURCE_TREE=%S", s->tree);
  ADD_ENV(L"DESK_TEST_OWNED_GIT_FIXTURE_SHA=%S", s->manifest);
#undef ADD_ENV
  for (i = 0; i < count; ++i) for (j = i + 1; j < count; ++j) if (_wcsicmp(lines[i], lines[j]) > 0) {
    wcscpy_s(value, 32768, lines[i]); wcscpy_s(lines[i], 32768, lines[j]); wcscpy_s(lines[j], 32768, value);
  }
  for (i = 0; i < count; ++i) {
    n = (int)wcslen(lines[i]) + 1;
    if (used + (size_t)n + 1 > 32768) goto done;
    memcpy(s->environment + used, lines[i], (size_t)n * sizeof(wchar_t)); used += (size_t)n;
  }
  s->environment[used] = 0; good = 1;
done:
  SecureZeroMemory(lines, 20 * 32768 * sizeof(wchar_t));
  if (!HeapFree(GetProcessHeap(), 0, lines)) good = 0;
  SecureZeroMemory(value, sizeof(value));
  return good;
}
static int launch_controller(SUPERVISOR *s) {
  STARTUPINFOEXW startup; SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, FALSE };
  HANDLE stdio[3] = { NULL, NULL, NULL }, nul = NULL; SIZE_T bytes = 0;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; wchar_t line[32768];
  int attributes = 0, good = 0; unsigned i; char identity[128]; uint64_t current;
  ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&limits, sizeof(limits));
  if (!sample(s, &current) || current >= s->stop_controller) return 0;
  s->job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 256;
  if (!track(s, s->job, 0) || !SetInformationJobObject(s->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto done;
  nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
  if (!track(s, nul, 0)) goto done;
  for (i = 0; i < 3; ++i) {
    HANDLE from = i == 0 ? nul : GetStdHandle(i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
    if (!DuplicateHandle(GetCurrentProcess(), from, GetCurrentProcess(), &stdio[i], 0, TRUE, DUPLICATE_SAME_ACCESS) ||
        !track(s, stdio[i], 1)) goto done;
  }
  if (InitializeProcThreadAttributeList(NULL, 1, 0, &bytes) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || !bytes) goto done;
  startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) goto done;
  attributes = 1;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, stdio, sizeof(stdio), NULL, NULL) ||
      !environment(s)) goto done;
  startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdio[0]; startup.StartupInfo.hStdOutput = stdio[1]; startup.StartupInfo.hStdError = stdio[2];
  if (s->mode) {
    if (swprintf_s(line, 32768, L"\"%ls\" --retention-controller", s->self) < 0) goto done;
  } else if (swprintf_s(line, 32768, L"\"%ls\" \"%ls\" --native-controller", s->node, s->script) < 0) goto done;
  if (s->count > 62 || !live(s) || !CreateProcessW(s->mode ? s->self : s->node, line, NULL, NULL, TRUE,
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, s->environment, s->root,
      &startup.StartupInfo, &s->controller)) goto done;
  s->created = 1;
  /* Both creation-returned handles remain owned even if either flag check fails. */
  s->handles[s->count++] = s->controller.hProcess;
  s->handles[s->count++] = s->controller.hThread;
  if (!private_handle(s->controller.hProcess) || !private_handle(s->controller.hThread)) goto done;
  s->controller_pid = GetProcessId(s->controller.hProcess);
  if (!s->controller_pid || s->controller_pid != s->controller.dwProcessId || !live(s) ||
      !AssignProcessToJobObject(s->job, s->controller.hProcess)) goto done;
  s->assigned = 1;
  if (sprintf_s(identity, sizeof(identity), ",\"controllerPid\":%lu,\"assigned\":true",
      (unsigned long)s->controller_pid) < 0 || !event_frame(s, "CONTROLLER_CREATED", identity) ||
      !live(s) || !sample(s, &current) || current >= s->stop_controller ||
      ResumeThread(s->controller.hThread) != 1) goto done;
  s->resumed = 1; good = 1;
done:
  if (attributes) DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (startup.lpAttributeList && !HeapFree(GetProcessHeap(), 0, startup.lpAttributeList)) good = 0;
  SecureZeroMemory(s->environment, sizeof(s->environment));
  for (i = 0; i < 3; ++i) if (stdio[i] && !drop(s, stdio[i])) good = 0;
  if (nul && nul != INVALID_HANDLE_VALUE && !drop(s, nul)) good = 0;
  return good;
}
static int retire(SUPERVISOR *s) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting; DWORD waited;
  if (s->created && !s->assigned) {
    waited = WaitForSingleObject(s->controller.hProcess, 0);
    if (waited != WAIT_OBJECT_0 && (waited != WAIT_TIMEOUT || !TerminateProcess(s->controller.hProcess, 90))) return 0;
  }
  if (!s->job || !TerminateJobObject(s->job, 91)) return 0;
  s->sealed = 1;
  while (live(s)) {
    if (!QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) return 0;
    s->zero = accounting.ActiveProcesses == 0;
    /* Absence can be reconciled for cleanup, but never certified as retirement. */
    waited = s->created ? WaitForSingleObject(s->controller.hProcess, 0) : WAIT_FAILED;
    if (s->created && waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) return 0;
    s->retired = s->created && waited == WAIT_OBJECT_0;
    s->unassigned_retired = s->created && (s->assigned || s->retired);
    if (s->zero && (!s->created || (s->retired && s->unassigned_retired))) return 1;
    Sleep(1);
  }
  return 0;
}
static int file_identity(SUPERVISOR *s, const wchar_t *name, BY_HANDLE_FILE_INFORMATION *info) {
  HANDLE file = CreateFileW(name, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, NULL); int good = 0;
  if (!track(s, file, 0)) return 0;
  if (GetFileInformationByHandle(file, info) && !(info->dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) good = 1;
  if (!drop(s, file)) good = 0;
  return good;
}
static int write_private(SUPERVISOR *s, const wchar_t *name, const char *bytes, DWORD length) {
  HANDLE file = INVALID_HANDLE_VALUE; DWORD n; int good = 0;
  if (!length || length > FRAME_MAX || s->file_pending || s->output_pending || !live(s)) return 0;
  ZeroMemory(&s->file_io, sizeof(s->file_io));
  s->file_io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!track(s, s->file_io.hEvent, 0)) return 0;
  file = CreateFileW(name, GENERIC_WRITE, 0, NULL, CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED, NULL);
  if (!track(s, file, 0)) goto done;
  if (!ResetEvent(s->file_io.hEvent)) goto done;
  memcpy(s->outgoing, bytes, length);
  if (!send_bytes(s, file, length, &s->file_io, &s->file_pending)) goto done;
  if (!FlushFileBuffers(file) || !live(s)) goto done;
  n = GetFileSize(file, NULL);
  good = n == length;
done:
  if (s->file_pending && !reap(s, file, &s->file_io, &s->file_pending)) ExitProcess(1);
  if (file != INVALID_HANDLE_VALUE && !drop(s, file)) good = 0;
  if (!drop(s, s->file_io.hEvent)) good = 0;
  s->file_io.hEvent = NULL;
  return good && live(s);
}
static int identity_drift(SUPERVISOR *s) {
  wchar_t target[32768], original[32768]; BY_HANDLE_FILE_INFORMATION before, after; char extra[256];
  if (swprintf_s(target, 32768, L"%ls\\retention-sentinel.json", s->realm) < 0 ||
      swprintf_s(original, 32768, L"%ls\\retention-sentinel-original.json", s->realm) < 0 ||
      !file_identity(s, target, &before) || before.nFileSizeHigh || before.nFileSizeLow != 17 ||
      !MoveFileW(target, original) ||
      !write_private(s, target, "{\"drift\":true}", 14) || !file_identity(s, target, &after)) return 0;
  if (after.nFileSizeHigh || after.nFileSizeLow != 14) return 0;
  if (before.dwVolumeSerialNumber == after.dwVolumeSerialNumber &&
      before.nFileIndexHigh == after.nFileIndexHigh && before.nFileIndexLow == after.nFileIndexLow) return 0;
  if (sprintf_s(extra, sizeof(extra),
      ",\"volume\":%lu,\"indexHigh\":%lu,\"indexLow\":%lu,\"bytes\":%lu,\"replacementDistinct\":true",
      (unsigned long)before.dwVolumeSerialNumber, (unsigned long)before.nFileIndexHigh,
      (unsigned long)before.nFileIndexLow, (unsigned long)before.nFileSizeLow) < 0) return 0;
  return event_frame(s, "TARGET_IDENTITY", extra);
}
static int bootstrap(SUPERVISOR *s) {
  wchar_t name[32768]; int n;
  if (!s->created || !s->controller_pid || !s->retired || !s->unassigned_retired || !s->zero ||
      !s->sealed || !s->control_reaped || !s->critical_closed || s->failed || !live(s)) return 0;
  if (s->mode == 2 || s->mode == 5) return 1;
  n = s->mode == 3 ? sprintf_s(s->file_bytes, sizeof(s->file_bytes), "{") :
    sprintf_s(s->file_bytes, sizeof(s->file_bytes),
      "{\"schema\":\"desk.owned-git-real-retention/1\",\"nonce\":\"%s\",\"sourceRevision\":\"%s\","
      "\"sourceTree\":\"%s\",\"allocationSha256\":\"" ALLOCATION "\",\"fixtureManifestSha256\":\"%s\","
      "\"Hns\":\"%llu\",\"controllerPid\":%lu,\"controllerRetired\":true,\"unassignedRetired\":true,"
      "\"jobSealed\":true,\"activeProcesses\":%d,\"queryOrigin\":\"real-win32\",\"controlReaped\":true,"
      "\"criticalHandlesClosed\":true,\"complete\":true}",
      s->nonce, s->revision, s->tree, s->manifest, (unsigned long long)s->H,
      (unsigned long)s->controller_pid, s->mode == 4 ? 1 : 0);
  if (n <= 0 || n > FRAME_MAX || swprintf_s(name, 32768, L"%ls\\bootstrap.json", s->realm) < 0) return 0;
  return write_private(s, name, s->file_bytes, (DWORD)n);
}
static int retention_controller(SUPERVISOR *s) {
  DWORD n; int result = 1; wchar_t file[32768]; BOOL member = FALSE;
  if (!env_decimal(L"DESK_TEST_OWNED_GIT_D", &s->end) || !env_decimal(L"DESK_TEST_OWNED_GIT_H", &s->H) ||
      s->end > s->H || !live(s) ||
      !IsProcessInJob(GetCurrentProcess(), NULL, &member) || !member) return 1;
  n = GetEnvironmentVariableW(L"DESK_TEST_OWNED_GIT_PRIVATE", s->realm, 32768);
  if (!n || n >= 32768 || !regular_long_path(s->realm, 1)) return 1;
  if (swprintf_s(file, 32768, L"%ls\\retention-sentinel.json", s->realm) >= 0 &&
      write_private(s, file, "{\"sentinel\":true}", 17)) result = 0;
  if (!close_registry(s)) result = 1;
  return result;
}
static int descendant_witness(SUPERVISOR *s) {
  wchar_t endpoint[128], nonce[65]; DWORD length; HANDLE pipe; int result = 1;
  const wchar_t *prefix = L"\\\\.\\pipe\\desk-owned-git-witness-"; size_t prefix_length = wcslen(prefix), i;
  if (!env_decimal(L"DESK_TEST_OWNED_GIT_D", &s->end) || !live(s)) return 1;
  length = GetEnvironmentVariableW(L"DESK_TEST_OWNED_GIT_WITNESS", endpoint, 128);
  if (length != prefix_length + 64 || wcsncmp(endpoint, prefix, prefix_length)) return 1;
  for (i = prefix_length; i < length; ++i) if (!((endpoint[i] >= L'0' && endpoint[i] <= L'9') ||
      (endpoint[i] >= L'a' && endpoint[i] <= L'f'))) return 1;
  if (GetEnvironmentVariableW(L"DESK_TEST_OWNED_GIT_WITNESS_NONCE", nonce, 65) != 64 ||
      !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, nonce, -1, s->nonce, sizeof(s->nonce), NULL, NULL) ||
      !hex(s->nonce, 64)) return 1;
  {
    BOOL member = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), NULL, &member) || !member) return 1;
  }
  pipe = INVALID_HANDLE_VALUE;
  while (live(s)) {
    pipe = CreateFileW(endpoint, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY) return 1;
    if (!WaitNamedPipeW(endpoint, 1) && GetLastError() != ERROR_SEM_TIMEOUT) return 1;
  }
  if (!track(s, pipe, 0)) return 1;
  s->control = pipe;
  s->input.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!track(s, s->input.hEvent, 0)) goto done;
  s->output.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!track(s, s->output.hEvent, 0)) goto done;
  if (sprintf_s((char *)s->outgoing, sizeof(s->outgoing), "WITNESS_READY %s\n", s->nonce) != 79 ||
      !send_bytes(s, pipe, 79, &s->output, &s->output_pending)) goto done;
  while (live(s)) {
    int status = 0;
    s->input_used = 0; s->input_target = 6;
    while (live(s) && (status = input_poll(s)) == 1) Sleep(1);
    if (!live(s) || status != 2 || memcmp(s->incoming, "ALIVE\n", 6)) goto done;
    memcpy(s->outgoing, "ALIVE\n", 6);
    if (!send_bytes(s, pipe, 6, &s->output, &s->output_pending)) goto done;
    result = 0;
  }
done:
  if (!reap(s, pipe, &s->input, &s->input_pending) ||
      !reap(s, pipe, &s->output, &s->output_pending)) ExitProcess(1);
  if (!close_registry(s)) result = 1;
  s->control = NULL;
  return result;
}
static int public_cue(SUPERVISOR *s, const char *cue, DWORD length) {
  int good;
  s->output.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!track(s, s->output.hEvent, 0)) return 0;
  memcpy(s->outgoing, cue, length);
  good = send_bytes(s, GetStdHandle(STD_OUTPUT_HANDLE), length, &s->output, &s->output_pending);
  if (!reap(s, GetStdHandle(STD_OUTPUT_HANDLE), &s->output, &s->output_pending)) ExitProcess(1);
  if (!drop(s, s->output.hEvent)) good = 0;
  s->output.hEvent = NULL;
  return good;
}
int wmain(int argc, wchar_t **argv) {
  SUPERVISOR *s; int result = 1, launch_ok = 0; uint64_t entry, current;
  DWORD size, code; unsigned int fp;
  if (argc != 2 || _controlfp_s(&fp, _RC_NEAR, _MCW_RC)) return 1;
  s = (SUPERVISOR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s));
  if (!s) return 1;
  if (!wcscmp(argv[1], L"--descendant-witness")) { result = descendant_witness(s); goto finish; }
  if (!wcscmp(argv[1], L"--retention-controller")) { result = retention_controller(s); goto finish; }
  if (!wcscmp(argv[1], L"--supervise-main")) s->mode = 0;
  else if (!wcscmp(argv[1], L"--ret01")) s->mode = 1;
  else if (!wcscmp(argv[1], L"--ret02")) s->mode = 2;
  else if (!wcscmp(argv[1], L"--ret03")) s->mode = 3;
  else if (!wcscmp(argv[1], L"--ret04")) s->mode = 4;
  else if (!wcscmp(argv[1], L"--ret05")) s->mode = 5;
  else if (!wcscmp(argv[1], L"--ret07")) s->mode = 7;
  else goto finish; /* RET06 can never enter a real-supervisor mode. */
  if (!env_decimal(L"DESK_TEST_OWNED_GIT_H", &s->H) || !sample(s, &entry) ||
      s->H <= 20000000000ULL || s->H <= entry || s->H - entry > 120000000000ULL) goto finish;
  s->end = s->H - (s->mode ? 12000000000ULL : 15000000000ULL);
  if (s->mode && s->end - (s->end > entry ? entry : s->end) > 2000000000ULL) s->end = entry + 2000000000ULL;
  if (!live(s)) goto finish;
  s->stop_controller = s->mode ? s->end : s->H - 20000000000ULL;
  size = GetModuleFileNameW(NULL, s->self, 32768);
  if (!size || size >= 32768 || !regular_long_path(s->self, 0)) goto finish;
  s->control = (HANDLE)_get_osfhandle(3);
  s->control_is_crt = 1;
  if (GetFileType(s->control) != FILE_TYPE_PIPE || !private_handle(s->control)) goto cleanup;
  s->input.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!track(s, s->input.hEvent, 0)) goto cleanup;
  s->output.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!track(s, s->output.hEvent, 0)) goto cleanup;
  if (!receive_config(s) || !protected_realm(s)) goto cleanup;
  launch_ok = launch_controller(s);
  if (!launch_ok) { s->failed = 1; goto cleanup; }
  /* One unexpected byte or EOF is sufficient to request failed retirement.
   * No configuration, START or arbitrary work can follow the single config. */
  s->input_used = 0; s->input_target = 1;
  while (sample(s, &current) && current < s->stop_controller) {
    DWORD waited = WaitForSingleObject(s->controller.hProcess, 0);
    if (waited == WAIT_OBJECT_0) {
      if (GetExitCodeProcess(s->controller.hProcess, &code)) result = code == 0 ? 0 : 1;
      else s->failed = 1;
      break;
    }
    if (waited != WAIT_TIMEOUT || input_poll(s) != 1) { s->failed = 1; break; }
    Sleep(1);
  }
cleanup:
  if (s->job && !retire(s)) s->failed = 1;
  if (s->created && !s->retired) ExitProcess(1);
  if (!reap(s, s->control, &s->input, &s->input_pending) ||
      !reap(s, s->control, &s->output, &s->output_pending)) ExitProcess(1);
  s->control_reaped = 1;
  if (launch_ok && !s->failed && s->mode == 7 && !identity_drift(s)) s->failed = 1;
  if (s->control && s->control != INVALID_HANDLE_VALUE) {
    if (_close(3)) s->failed = 1;
    s->control = NULL;
  }
  if (!close_registry(s)) s->failed = 1;
  s->critical_closed = !s->failed;
  if (!launch_ok || !s->created || !s->controller_pid || s->failed || !bootstrap(s)) { result = 1; goto finish; }
  if (s->mode == 5) {
    if (!public_cue(s, "EXPORT_BARRIER\n", 15)) { result = 1; goto finish; }
    while (live(s)) Sleep(1);
    result = 1;
  }
  if (s->mode >= 1 && s->mode <= 4) {
    if (!public_cue(s, "BOOTSTRAP_CLOSED\n", 17)) { result = 1; goto finish; }
    while (live(s)) Sleep(1); /* RET01–04 must be signaled through the original host ChildProcess. */
    result = 1;
  }
finish:
  if (s->input_pending || s->output_pending || s->file_pending) ExitProcess(1);
  if (s->job && !s->zero) { if (!retire(s)) result = 1; }
  if (!close_registry(s)) result = 1;
  if (s->control_is_crt && s->control && s->control != INVALID_HANDLE_VALUE && _close(3)) result = 1;
  if (s->failed) result = 1;
  SecureZeroMemory(s, sizeof(*s));
  if (!HeapFree(GetProcessHeap(), 0, s)) result = 1;
  return result;
}
