#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <float.h>
#include <math.h>

#define BODY 16380
#define FRAME 16384
#define PROTOCOL "desk.owned-git/1"
#define CLOCK "win-qpc-ns/1"
#define COMMON 63u

typedef struct {
  HANDLE handle;
  OVERLAPPED read, write;
  unsigned char input[FRAME], output[2][FRAME];
  DWORD used, target, length[2], offset, queued;
  int reading, writing, stop, eof;
} CHANNEL;
typedef struct {
  char protocol[32], role[8], type[24], generation[65], preparationDigest[65], payloadDigest[65];
  char nodeExecutable[BODY + 1], rootScript[BODY + 1], neutralCwd[BODY + 1], privateRoot[BODY + 1];
  char pipeSuffix[65], capability[65], clock[24], deadlineNs[21], clientNonce[65], path[BODY + 1], resultB64[685];
  unsigned fields;
} MESSAGE;
typedef struct {
  CHANNEL parent, root;
  OVERLAPPED connect;
  HANDLE job, directory, payload;
  HANDLE resources[24];
  DWORD resourceCount;
  PROCESS_INFORMATION pi;
  BYTE sid[SECURITY_MAX_SID_SIZE];
  DWORD sidLength;
  BY_HANDLE_FILE_INFORMATION payloadIdentity;
  int connecting, connected, prepared, clockAccepted, assigned, resumed, authenticated;
  int configuring, configured, startIssued, resultSeen, controlComplete;
  int retiring, terminated, sealed, zero, rootRetired, terminal;
  char failure[16], generation[65], preparation[65], accepted[65], proposed[65], nonce[65], capability[65];
  char result[685], payloadPath[BODY + 1], deadlineText[21];
  uint64_t deadline, lastTicks, frequency;
  wchar_t node[32768], script[32768], cwd[32768], privateRoot[32768];
} OWNER;
typedef struct {
  BYTE acl[sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE];
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes;
} SECURITY;

static void failure(OWNER *s, const char *code) {
  if (!s->failure[0]) strcpy_s(s->failure, sizeof(s->failure), code);
  s->retiring = 1;
}
static int private_handle(HANDLE h) {
  DWORD flags;
  return h && h != INVALID_HANDLE_VALUE &&
    SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) &&
    GetHandleInformation(h, &flags) && !(flags & HANDLE_FLAG_INHERIT);
}
static int retain(OWNER *s, HANDLE h) {
  if (!h || h == INVALID_HANDLE_VALUE || s->resourceCount == 24) return 0;
  s->resources[s->resourceCount++] = h;
  return 1;
}
static int release(OWNER *s, HANDLE h) {
  DWORD i;
  for (i = 0; i < s->resourceCount; ++i) if (s->resources[i] == h) {
    if (!CloseHandle(h)) { failure(s, "io"); return 0; }
    s->resources[i] = NULL; return 1;
  }
  failure(s, "internal"); return 0;
}
static int event(OWNER *s, OVERLAPPED *ov) {
  ZeroMemory(ov, sizeof(*ov));
  ov->hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  return retain(s, ov->hEvent) && private_handle(ov->hEvent);
}
static int decimal(const char *p, uint64_t *out) {
  uint64_t n = 0;
  if (!*p || (*p == '0' && p[1])) return 0;
  for (; *p; ++p) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9 || n > (UINT64_MAX - d) / 10) return 0;
    n = n * 10 + d;
  }
  *out = n; return 1;
}
static int clock_convert(uint64_t q, uint64_t f, uint64_t *out) {
  volatile double frequency, scale, ticks, ns;
  unsigned int control;
  if (!f || _controlfp_s(&control, _RC_NEAR, _MCW_RC) != 0 ||
      (control & _MCW_RC) != _RC_NEAR) return 0;
  frequency = (double)f;
  scale = frequency / 1000000000.0;
  ticks = (double)q;
  ns = ticks / scale;
  if (!isfinite(ns) || ns < 0.0 || ns >= 18446744073709551616.0) return 0;
  *out = (uint64_t)ns; return 1;
}
static int sample(OWNER *s, uint64_t *ticks, uint64_t *now, uint64_t *edge) {
  LARGE_INTEGER f, q;
  if (!QueryPerformanceFrequency(&f) || !QueryPerformanceCounter(&q) ||
      f.QuadPart <= 0 || q.QuadPart <= 0) return 0;
  if (s->frequency && s->frequency != (uint64_t)f.QuadPart) return 0;
  if (s->lastTicks && (uint64_t)q.QuadPart < s->lastTicks) return 0;
  s->frequency = (uint64_t)f.QuadPart; s->lastTicks = (uint64_t)q.QuadPart;
  *ticks = s->lastTicks;
  return clock_convert(*ticks, s->frequency, now) && clock_convert(*ticks + 1, s->frequency, edge);
}
static int live_deadline(OWNER *s) {
  uint64_t ticks, now, edge;
  if (!sample(s, &ticks, &now, &edge)) { failure(s, "clock"); return 0; }
  if (edge >= s->deadline) { failure(s, "deadline"); return 0; }
  return 1;
}
static int wide(const char *value, wchar_t *out) {
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, out, 32768) > 0;
}
static void whitespace(const char **p) { while (**p == ' ' || **p == '\r' || **p == '\n' || **p == '\t') ++*p; }
static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static int unicode4(const char **p, unsigned *value) {
  unsigned n = 0, i;
  for (i = 0; i < 4; ++i) {
    int d = hex_digit(**p); if (d < 0) return 0;
    n = n * 16 + (unsigned)d; ++*p;
  }
  *value = n; return 1;
}
static int string(const char **cursor, char *out, size_t capacity) {
  const char *p = *cursor; size_t used = 0;
  if (*p++ != '"') return 0;
  while (*p && *p != '"') {
    unsigned char c = (unsigned char)*p++;
    if (c < 32) return 0;
    if (c == '\\') {
      c = (unsigned char)*p++;
      if (c == 'u') {
        unsigned u, lo; wchar_t utf16[2]; char bytes[4]; int count, length;
        if (!unicode4(&p, &u) || !u) return 0;
        utf16[0] = (wchar_t)u; length = 1;
        if (u >= 0xd800 && u <= 0xdbff) {
          if (*p++ != '\\' || *p++ != 'u' || !unicode4(&p, &lo) || lo < 0xdc00 || lo > 0xdfff) return 0;
          utf16[1] = (wchar_t)lo; length = 2;
        } else if (u >= 0xdc00 && u <= 0xdfff) return 0;
        count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, utf16, length, bytes, 4, NULL, NULL);
        if (count <= 0 || used + (size_t)count >= capacity) return 0;
        memcpy(out + used, bytes, (size_t)count); used += (size_t)count; continue;
      }
      if (c == 'n') c = '\n'; else if (c == 'r') c = '\r'; else if (c == 't') c = '\t';
      else if (c == 'b') c = '\b'; else if (c == 'f') c = '\f';
      else if (c != '\\' && c != '"' && c != '/') return 0;
    }
    if (!c || used + 1 >= capacity) return 0;
    out[used++] = (char)c;
  }
  if (*p++ != '"') return 0;
  out[used] = 0; *cursor = p; return 1;
}
static int hex64(const char *s) {
  size_t i; if (strlen(s) != 64) return 0;
  for (i = 0; i < 64; ++i) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
  return 1;
}
static int absolute_path(const char *s) {
  size_t n = strlen(s);
  return (n >= 3 && ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z')) &&
    s[1] == ':' && (s[2] == '\\' || s[2] == '/')) ||
    (n >= 5 && s[0] == '\\' && s[1] == '\\' && s[2] != '\\' && strchr(s + 2, '\\') != NULL);
}
static int parse(const char *raw, MESSAGE *m) {
  const char *p = raw; char key[40]; char *out; size_t cap; unsigned bit;
  ZeroMemory(m, sizeof(*m)); whitespace(&p); if (*p++ != '{') return 0;
  for (;;) {
    whitespace(&p); if (!string(&p, key, sizeof(key))) return 0;
    whitespace(&p); if (*p++ != ':') return 0;
    whitespace(&p); out = NULL; cap = 0; bit = 0;
#define FIELD(k, member, index) if (!strcmp(key, k)) { out = m->member; cap = sizeof(m->member); bit = 1u << index; }
    FIELD("protocol", protocol, 0) FIELD("role", role, 1) FIELD("type", type, 2)
    FIELD("generation", generation, 3) FIELD("preparationDigest", preparationDigest, 4)
    FIELD("payloadDigest", payloadDigest, 5) FIELD("nodeExecutable", nodeExecutable, 6)
    FIELD("rootScript", rootScript, 7) FIELD("neutralCwd", neutralCwd, 8) FIELD("privateRoot", privateRoot, 9)
    FIELD("pipeSuffix", pipeSuffix, 10) FIELD("capability", capability, 11) FIELD("clock", clock, 12)
    FIELD("deadlineNs", deadlineNs, 13) FIELD("clientNonce", clientNonce, 14)
    FIELD("path", path, 15) FIELD("resultB64", resultB64, 16)
#undef FIELD
    if (!out || (m->fields & bit)) return 0;
    if (bit == (1u << 5) && !strncmp(p, "null", 4)) { *out = 0; p += 4; }
    else if (!string(&p, out, cap) || (bit == (1u << 5) && !hex64(out))) return 0;
    m->fields |= bit; whitespace(&p);
    if (*p == '}') { ++p; break; }
    if (*p++ != ',') return 0;
  }
  whitespace(&p);
  return !*p && (m->fields & COMMON) == COMMON && !strcmp(m->protocol, PROTOCOL) &&
    hex64(m->generation) && hex64(m->preparationDigest);
}
static int quote(const char *in, char *out, size_t capacity) {
  size_t used = 0; const unsigned char *p = (const unsigned char *)in;
  if (capacity < 3) return 0;
  out[used++] = '"';
  for (; *p; ++p) {
    if (*p < 32) {
      if (used + 6 >= capacity) return 0;
      if (snprintf(out + used, capacity - used, "\\u%04x", (unsigned)*p) != 6) return 0;
      used += 6;
    } else {
      if (used + 2 >= capacity) return 0;
      if (*p == '\\' || *p == '"') out[used++] = '\\';
      out[used++] = (char)*p;
    }
  }
  if (used + 2 > capacity) return 0;
  out[used++] = '"'; out[used] = 0; return 1;
}
static int enqueue(OWNER *s, CHANNEL *io, const char *body) {
  size_t n = strlen(body); DWORD length;
  if (!n || n > BODY || io->queued >= 2 || io->stop || io->eof) { failure(s, "io"); return 0; }
  length = (DWORD)n; memcpy(io->output[io->queued], &length, 4);
  memcpy(io->output[io->queued] + 4, body, n);
  io->length[io->queued++] = length + 4; return 1;
}
static int send_frame(OWNER *s, CHANNEL *io, const char *type, const char *digest, const char *extra) {
  char body[BODY + 1], payload[68]; int n;
  if (*digest) { if (!quote(digest, payload, sizeof(payload))) return 0; }
  else strcpy_s(payload, sizeof(payload), "null");
  n = snprintf(body, sizeof(body), "{\"protocol\":\"" PROTOCOL "\",\"role\":\"owner\",\"type\":\"%s\","
    "\"generation\":\"%s\",\"preparationDigest\":\"%s\",\"payloadDigest\":%s%s%s}",
    type, s->generation, s->preparation, payload, *extra ? "," : "", extra);
  if (n <= 0 || n > BODY || (!strcmp(type, "TERMINAL") && n > 4096)) { failure(s, "internal"); return 0; }
  n = enqueue(s, io, body); SecureZeroMemory(body, sizeof(body)); return n;
}
static int sid_security(OWNER *s, SECURITY *security, DWORD mask, BYTE inheritance) {
  DWORD size = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + s->sidLength);
  PACL acl = (PACL)security->acl;
  ZeroMemory(security, sizeof(*security));
  if (!s->sidLength || !IsValidSid(s->sid) || !InitializeAcl(acl, size, ACL_REVISION) ||
      !AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, mask, s->sid) ||
      !InitializeSecurityDescriptor(&security->descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&security->descriptor, s->sid, FALSE) ||
      !SetSecurityDescriptorDacl(&security->descriptor, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&security->descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED) ||
      !IsValidAcl(acl) || !IsValidSecurityDescriptor(&security->descriptor)) return 0;
  security->attributes.nLength = sizeof(security->attributes);
  security->attributes.bInheritHandle = FALSE;
  security->attributes.lpSecurityDescriptor = &security->descriptor;
  return 1;
}
static int security_matches(OWNER *s, HANDLE h, SE_OBJECT_TYPE type, DWORD mask, BYTE flags) {
  PSECURITY_DESCRIPTOR descriptor = NULL; PSID owner = NULL; PACL acl = NULL;
  ACL_SIZE_INFORMATION info; SECURITY_DESCRIPTOR_CONTROL bits; DWORD revision;
  ACCESS_ALLOWED_ACE *ace; int good = 0;
  if (GetSecurityInfo(h, type, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS) goto done;
  if (!descriptor || !acl || !IsValidSecurityDescriptor(descriptor) || !IsValidAcl(acl) ||
      !IsValidSid(owner) || !EqualSid(owner, s->sid) ||
      !GetSecurityDescriptorControl(descriptor, &bits, &revision) || !(bits & SE_DACL_PROTECTED) ||
      !GetAclInformation(acl, &info, sizeof(info), AclSizeInformation) || info.AceCount != 1 ||
      !GetAce(acl, 0, (LPVOID *)&ace)) goto done;
  good = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == flags &&
    ace->Mask == mask && IsValidSid(&ace->SidStart) && EqualSid(&ace->SidStart, s->sid);
done:
  if (descriptor && LocalFree(descriptor) != NULL) good = 0;
  return good;
}
static int token_user(OWNER *s) {
  HANDLE token = NULL; TOKEN_USER *user = NULL; DWORD needed = 0; int good = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) || !private_handle(token)) goto done;
  if (GetTokenInformation(token, TokenUser, NULL, 0, &needed) || GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
      needed < sizeof(TOKEN_USER) || needed > 65536) goto done;
  user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, needed);
  if (!user || !GetTokenInformation(token, TokenUser, user, needed, &needed) || !IsValidSid(user->User.Sid)) goto done;
  s->sidLength = GetLengthSid(user->User.Sid);
  if (!s->sidLength || s->sidLength > sizeof(s->sid) || !CopySid(sizeof(s->sid), s->sid, user->User.Sid)) goto done;
  good = 1;
done:
  if (user && !HeapFree(GetProcessHeap(), 0, user)) good = 0;
  if (token && !CloseHandle(token)) good = 0;
  return good;
}
static HANDLE new_file(OWNER *s, const wchar_t *path, DWORD flags) {
  SECURITY security; HANDLE h;
  if (!sid_security(s, &security, FILE_ALL_ACCESS, 0)) return INVALID_HANDLE_VALUE;
  h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ,
    &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | flags, NULL);
  if (h == INVALID_HANDLE_VALUE) return h;
  if (!retain(s, h) || !private_handle(h) || !security_matches(s, h, SE_FILE_OBJECT, FILE_ALL_ACCESS, 0)) {
    failure(s, "io"); return INVALID_HANDLE_VALUE;
  }
  return h;
}
static int private_files(OWNER *s) {
  SECURITY security; BY_HANDLE_FILE_INFORMATION info; wchar_t leaf[32768]; HANDLE h;
  if (!token_user(s) || !sid_security(s, &security, FILE_ALL_ACCESS, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) return 0;
  if (!CreateDirectoryW(s->privateRoot, &security.attributes) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
  s->directory = CreateFileW(s->privateRoot, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (!retain(s, s->directory) || !private_handle(s->directory) ||
      !GetFileInformationByHandle(s->directory, &info) || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !security_matches(s, s->directory, SE_FILE_OBJECT, FILE_ALL_ACCESS, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) return 0;
  if (swprintf_s(leaf, 32768, L"%ls\\payload.json", s->privateRoot) < 0) return 0;
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, leaf, -1, s->payloadPath, sizeof(s->payloadPath), NULL, NULL)) return 0;
  h = new_file(s, leaf, 0);
  return h != INVALID_HANDLE_VALUE && GetFileInformationByHandle(h, &s->payloadIdentity) && release(s, h);
}
static int lock_payload(OWNER *s, const char *filename) {
  wchar_t name[32768]; BY_HANDLE_FILE_INFORMATION info; LARGE_INTEGER size;
  if (strcmp(filename, s->payloadPath) || !wide(filename, name)) return 0;
  s->payload = CreateFileW(name, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  return retain(s, s->payload) && private_handle(s->payload) && GetFileInformationByHandle(s->payload, &info) &&
    !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
    info.dwVolumeSerialNumber == s->payloadIdentity.dwVolumeSerialNumber &&
    info.nFileIndexHigh == s->payloadIdentity.nFileIndexHigh && info.nFileIndexLow == s->payloadIdentity.nFileIndexLow &&
    security_matches(s, s->payload, SE_FILE_OBJECT, FILE_ALL_ACCESS, 0) &&
    GetFileSizeEx(s->payload, &size) && size.QuadPart > 0 && size.QuadPart <= 1048576;
}
static int server(OWNER *s, const char *suffix) {
  SECURITY security; wchar_t name[128]; BOOL ok; DWORD error;
  const DWORD mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE;
  if (!sid_security(s, &security, mask, 0) ||
      swprintf_s(name, 128, L"\\\\.\\pipe\\desk-owned-git-%hs", suffix) < 0) return 0;
  s->root.handle = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, FRAME, FRAME, 0, &security.attributes);
  SecureZeroMemory(name, sizeof(name));
  if (!retain(s, s->root.handle) || !private_handle(s->root.handle) ||
      !security_matches(s, s->root.handle, SE_FILE_OBJECT, mask, 0)) return 0;
  ok = ConnectNamedPipe(s->root.handle, &s->connect); error = GetLastError();
  if (ok || error == ERROR_PIPE_CONNECTED) s->connected = 1;
  else if (error == ERROR_IO_PENDING) s->connecting = 1;
  else return 0;
  return 1;
}
static LPWCH environment(OWNER *s, const char *suffix) {
  const wchar_t *keys[] = { L"SystemRoot", L"WINDIR", L"SystemDrive", L"COMSPEC", L"PATH", L"TEMP", L"TMP", L"PATHEXT", L"LANG", L"LC_ALL" };
  LPWCH env = (LPWCH)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536 * sizeof(wchar_t));
  LPWCH sorted = NULL; wchar_t *entries[16], *p, *key; size_t used = 0, count = 0, i, j, at = 0;
  int n;
  if (!env) return NULL;
  for (i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
    wchar_t value[32768]; DWORD length = GetEnvironmentVariableW(keys[i], value, 32768);
    if (!length) continue;
    if (length >= 32768) goto bad;
    n = swprintf_s(env + used, 65536 - used, L"%ls=%ls", keys[i], value);
    if (n < 0) goto bad;
    used += (size_t)n + 1;
  }
#define ENV(k, v) do { n = swprintf_s(env + used, 65536 - used, L##k L"=%hs", v); if (n < 0) goto bad; used += (size_t)n + 1; } while (0)
  { char endpoint[128]; if (snprintf(endpoint, sizeof(endpoint), "\\\\.\\pipe\\desk-owned-git-%s", suffix) < 0) goto bad;
    ENV("DESK_OWNED_GIT_ENDPOINT", endpoint); }
  ENV("DESK_OWNED_GIT_CAPABILITY", s->capability);
  ENV("DESK_OWNED_GIT_GENERATION", s->generation);
  ENV("DESK_OWNED_GIT_PREPARATION_DIGEST", s->preparation);
  ENV("DESK_OWNED_GIT_CLOCK", CLOCK);
  ENV("DESK_OWNED_GIT_DEADLINE_NS", s->deadlineText);
#undef ENV
  if (used >= 65535) goto bad;
  sorted = (LPWCH)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536 * sizeof(wchar_t));
  if (!sorted) goto bad;
  for (p = env; *p; p += wcslen(p) + 1) { if (count >= 16) goto bad; entries[count++] = p; }
  for (i = 1; i < count; ++i) {
    key = entries[i]; j = i;
    while (j && _wcsicmp(entries[j - 1], key) > 0) { entries[j] = entries[j - 1]; --j; }
    entries[j] = key;
  }
  for (i = 0; i < count; ++i) {
    size_t nchar = wcslen(entries[i]) + 1;
    memcpy(sorted + at, entries[i], nchar * sizeof(wchar_t)); at += nchar;
  }
  SecureZeroMemory(env, 65536 * sizeof(wchar_t));
  if (!HeapFree(GetProcessHeap(), 0, env)) { HeapFree(GetProcessHeap(), 0, sorted); return NULL; }
  return sorted;
bad:
  if (sorted) { SecureZeroMemory(sorted, 65536 * sizeof(wchar_t)); HeapFree(GetProcessHeap(), 0, sorted); }
  SecureZeroMemory(env, 65536 * sizeof(wchar_t)); HeapFree(GetProcessHeap(), 0, env); return NULL;
}
static int launch(OWNER *s, const char *suffix) {
  STARTUPINFOEXW si; SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, FALSE };
  SIZE_T bytes = 0; HANDLE stdio[3] = { NULL, NULL, NULL }, nul = NULL;
  LPWCH env = NULL; wchar_t line[32768]; unsigned char crt[4 + 3 + 3 * sizeof(intptr_t)];
  DWORD i, flags; int count = 3, good = 0, attributes = 0; BOOL member = FALSE;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&si, sizeof(si)); ZeroMemory(&limits, sizeof(limits));
  s->job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!retain(s, s->job) || !private_handle(s->job) ||
      !SetInformationJobObject(s->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !private_files(s) || !server(s, suffix)) goto done;
  nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
  if (!retain(s, nul) || !private_handle(nul)) goto done;
  for (i = 0; i < 3; ++i) {
    HANDLE from = i == 0 ? nul : GetStdHandle(i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
    if (!DuplicateHandle(GetCurrentProcess(), from, GetCurrentProcess(), &stdio[i], 0, TRUE, DUPLICATE_SAME_ACCESS) ||
        !retain(s, stdio[i]) || !GetHandleInformation(stdio[i], &flags) || !(flags & HANDLE_FLAG_INHERIT)) goto done;
  }
  if (InitializeProcThreadAttributeList(NULL, 1, 0, &bytes) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || !bytes) goto done;
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!si.lpAttributeList || !InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes)) goto done;
  attributes = 1;
  if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, stdio, sizeof(stdio), NULL, NULL)) goto done;
  env = environment(s, suffix);
  if (!env || wcschr(s->node, L'"') || wcschr(s->script, L'"') ||
      swprintf_s(line, 32768, L"\"%ls\" \"%ls\" --owned-root", s->node, s->script) < 0) goto done;
  si.StartupInfo.cb = sizeof(si); si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = stdio[0]; si.StartupInfo.hStdOutput = stdio[1]; si.StartupInfo.hStdError = stdio[2];
  ZeroMemory(crt, sizeof(crt)); memcpy(crt, &count, 4);
  for (i = 0; i < 3; ++i) {
    intptr_t h = (intptr_t)stdio[i]; crt[4 + i] = (unsigned char)(i == 0 ? 1 | 64 : 1 | 8);
    memcpy(crt + 7 + i * sizeof(h), &h, sizeof(h));
  }
  si.StartupInfo.cbReserved2 = (WORD)sizeof(crt); si.StartupInfo.lpReserved2 = crt;
  if (!live_deadline(s) || !CreateProcessW(s->node, line, &sa, &sa, TRUE,
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, env, s->cwd, &si.StartupInfo, &s->pi)) goto done;
  if (!retain(s, s->pi.hProcess) || !retain(s, s->pi.hThread) ||
      !private_handle(s->pi.hProcess) || !private_handle(s->pi.hThread) || !live_deadline(s)) goto done;
  if (!AssignProcessToJobObject(s->job, s->pi.hProcess)) goto done;
  s->assigned = 1;
  if (!IsProcessInJob(s->pi.hProcess, s->job, &member) || !member ||
      WaitForSingleObject(s->pi.hProcess, 0) != WAIT_TIMEOUT || !live_deadline(s) ||
      ResumeThread(s->pi.hThread) != 1) goto done;
  s->resumed = 1; good = 1;
done:
  if (attributes) DeleteProcThreadAttributeList(si.lpAttributeList);
  if (si.lpAttributeList && !HeapFree(GetProcessHeap(), 0, si.lpAttributeList)) good = 0;
  if (env) { SecureZeroMemory(env, 65536 * sizeof(wchar_t)); if (!HeapFree(GetProcessHeap(), 0, env)) good = 0; }
  for (i = 0; i < 3; ++i) if (stdio[i] && (!private_handle(stdio[i]) || !release(s, stdio[i]))) good = 0;
  if (nul && nul != INVALID_HANDLE_VALUE && !release(s, nul)) good = 0;
  return good;
}

static int consume(const char **p, const char *literal) {
  size_t n = strlen(literal);
  if (strncmp(*p, literal, n)) return 0;
  *p += n; return 1;
}
static int bounded_word(const char *p, int signal) {
  size_t i, n = strlen(p);
  if (!n || n > (signal ? 23u : 80u) || (signal && (n < 4 || strncmp(p, "SIG", 3)))) return 0;
  for (i = signal ? 3u : 0u; i < n; ++i)
    if (!((p[i] >= 'A' && p[i] <= 'Z') || (p[i] >= '0' && p[i] <= '9') || (!signal && p[i] == '_'))) return 0;
  return 1;
}
static int json_integer(const char **p, char *out, size_t cap, int signed_code, uint64_t *value) {
  const char *start = *p; size_t n; int negative = 0; uint64_t x;
  if (signed_code && **p == '-') { negative = 1; ++*p; }
  if (**p < '0' || **p > '9') return 0;
  if (**p == '0') ++*p; else while (**p >= '0' && **p <= '9') ++*p;
  n = (size_t)(*p - start);
  if (n >= cap) return 0;
  memcpy(out, start, n); out[n] = 0;
  if (!decimal(out + negative, &x)) return 0;
  if ((negative && (!x || x > 2147483648ULL)) || (signed_code && !negative && x > 4294967295ULL) ||
      (!signed_code && x > 9007199254740991ULL)) return 0;
  *value = x; return 1;
}
static int result_valid(const char *base64) {
  unsigned char decoded[513]; size_t i, n = strlen(base64), used = 0;
  const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  /* Longest Command state plus NUL; the Input states are shorter. */
  char canonical[513], state[sizeof("spawn_failed")], code[81], signal[24], expected[24], submitted[24], error[81];
  char command[160], error_json[84]; const char *p; uint64_t expected_n, submitted_n, ignored;
  int out, complete;
  if (!n || n > 684 || n % 4) return 0;
  for (i = 0; i < n; i += 4) {
    unsigned v[4], j, padding = 0;
    for (j = 0; j < 4; ++j) {
      const char *found;
      if (base64[i + j] == '=') { if (j < 2 || i + 4 != n) return 0; v[j] = 0; ++padding; }
      else {
        if (padding || !(found = strchr(alphabet, base64[i + j]))) return 0;
        v[j] = (unsigned)(found - alphabet);
      }
    }
    if (padding > 2 || (padding == 2 && (v[1] & 15)) || (padding == 1 && (v[2] & 3)) ||
        used + 3 - padding > 512) return 0;
    decoded[used++] = (unsigned char)((v[0] << 2) | (v[1] >> 4));
    if (padding < 2) decoded[used++] = (unsigned char)((v[1] << 4) | (v[2] >> 2));
    if (!padding) decoded[used++] = (unsigned char)((v[2] << 6) | v[3]);
  }
  decoded[used] = 0;
  if (strlen((const char *)decoded) != used) return 0;
  p = (const char *)decoded;
  if (!consume(&p, "{\"command\":{\"state\":") || !string(&p, state, sizeof(state)) || !consume(&p, ",\"code\":")) return 0;
  if (!strcmp(state, "spawn_failed")) {
    if (!string(&p, code, sizeof(code)) || !bounded_word(code, 0)) return 0;
    out = snprintf(command, sizeof(command), "{\"state\":\"spawn_failed\",\"code\":\"%s\"}", code);
  } else if (!strcmp(state, "exited")) {
    int null_code = consume(&p, "null");
    if (!null_code && !json_integer(&p, code, sizeof(code), 1, &ignored)) return 0;
    if (!consume(&p, ",\"signal\":")) return 0;
    if (null_code) {
      if (!string(&p, signal, sizeof(signal)) || !bounded_word(signal, 1)) return 0;
      out = snprintf(command, sizeof(command), "{\"state\":\"exited\",\"code\":null,\"signal\":\"%s\"}", signal);
    } else {
      if (!consume(&p, "null")) return 0;
      out = snprintf(command, sizeof(command), "{\"state\":\"exited\",\"code\":%s,\"signal\":null}", code);
    }
  } else return 0;
  if (out <= 0 || out >= (int)sizeof(command) || !consume(&p, "},\"input\":{\"state\":") ||
      !string(&p, state, sizeof(state)) || !consume(&p, ",\"expectedBytes\":") ||
      !json_integer(&p, expected, sizeof(expected), 0, &expected_n) ||
      !consume(&p, ",\"submittedBytes\":") || !json_integer(&p, submitted, sizeof(submitted), 0, &submitted_n) ||
      submitted_n > expected_n || !consume(&p, ",\"errorCode\":")) return 0;
  complete = !strcmp(state, "complete");
  if (!complete && strcmp(state, "failed") && strcmp(state, "unknown")) return 0;
  if (consume(&p, "null")) strcpy_s(error_json, sizeof(error_json), "null");
  else {
    if (!string(&p, error, sizeof(error)) || !bounded_word(error, 0) || !quote(error, error_json, sizeof(error_json)) || complete) return 0;
  }
  if ((complete && expected_n != submitted_n) || !consume(&p, "}}") || *p) return 0;
  out = snprintf(canonical, sizeof(canonical), "{\"command\":%s,\"input\":{\"state\":\"%s\",\"expectedBytes\":%s,\"submittedBytes\":%s,\"errorCode\":%s}}",
    command, state, expected, submitted, error_json);
  return out > 0 && out <= 512 && (size_t)out == used && !memcmp(canonical, decoded, used);
}

static void message(OWNER *s, CHANNEL *io, const char *raw) {
  MESSAGE *m = (MESSAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*m));
  char extra[BODY + 1], quoted[BODY + 1]; DWORD pid; BOOL member = FALSE;
  if (!m) { failure(s, "internal"); return; }
  if (!parse(raw, m) || s->retiring) { failure(s, "protocol"); goto done; }
  if (io == &s->parent) {
    if (strcmp(m->role, "parent")) goto protocol;
    if (!s->prepared) {
      uint64_t deadline, ticks, now, edge;
      if (strcmp(m->type, "PREPARE") || m->fields != (COMMON | (255u << 6)) || m->payloadDigest[0] ||
          !hex64(m->pipeSuffix) || !hex64(m->capability) || strcmp(m->clock, CLOCK) ||
          !decimal(m->deadlineNs, &deadline) || deadline != s->deadline ||
          !absolute_path(m->nodeExecutable) || !absolute_path(m->rootScript) || !absolute_path(m->neutralCwd) || !absolute_path(m->privateRoot) ||
          !wide(m->nodeExecutable, s->node) || !wide(m->rootScript, s->script) || !wide(m->neutralCwd, s->cwd) || !wide(m->privateRoot, s->privateRoot)) goto protocol;
      strcpy_s(s->generation, sizeof(s->generation), m->generation);
      strcpy_s(s->preparation, sizeof(s->preparation), m->preparationDigest);
      strcpy_s(s->capability, sizeof(s->capability), m->capability);
      s->prepared = 1;
      if (!sample(s, &ticks, &now, &edge)) { failure(s, "clock"); goto done; }
      if (!live_deadline(s)) goto done;
      snprintf(extra, sizeof(extra), "\"clock\":\"" CLOCK "\",\"deadlineNs\":\"%s\",\"qpcTicks\":\"%llu\",\"qpcFrequency\":\"%llu\",\"nowNs\":\"%llu\"",
        s->deadlineText, (unsigned long long)ticks, (unsigned long long)s->frequency, (unsigned long long)now);
      send_frame(s, &s->parent, "CLOCK_READY", "", extra);
      // Suffix remains secret state until the clock-accepted launch.
      strcpy_s(s->nonce, sizeof(s->nonce), m->pipeSuffix);
      goto done;
    }
    if (strcmp(m->generation, s->generation) || strcmp(m->preparationDigest, s->preparation)) goto protocol;
    if (!strcmp(m->type, "CANCEL") && m->fields == COMMON &&
        !strcmp(m->payloadDigest, s->configuring ? s->proposed : s->accepted)) { s->retiring = 1; goto done; }
    if (!strcmp(m->type, "CLOCK_ACCEPT") && m->fields == (COMMON | (3u << 12)) && !s->clockAccepted &&
        !m->payloadDigest[0] && !strcmp(m->clock, CLOCK) && !strcmp(m->deadlineNs, s->deadlineText)) {
      char suffix[65]; strcpy_s(suffix, sizeof(suffix), s->nonce); SecureZeroMemory(s->nonce, sizeof(s->nonce));
      if (!live_deadline(s)) goto done;
      s->clockAccepted = 1;
      if (!launch(s, suffix)) failure(s, "prepare");
      SecureZeroMemory(suffix, sizeof(suffix)); goto done;
    }
    if (!strcmp(m->type, "CONFIG") && m->fields == (COMMON | (1u << 15)) && s->authenticated &&
        !s->configuring && !s->configured && hex64(m->payloadDigest)) {
      if (!live_deadline(s) || !lock_payload(s, m->path)) { failure(s, "configure"); goto done; }
      strcpy_s(s->proposed, sizeof(s->proposed), m->payloadDigest); s->configuring = 1;
      if (!quote(m->path, quoted, sizeof(quoted)) || snprintf(extra, sizeof(extra), "\"path\":%s", quoted) >= (int)sizeof(extra)) goto protocol;
      send_frame(s, &s->root, "CONFIG", s->proposed, extra); goto done;
    }
    if (strcmp(m->payloadDigest, s->accepted)) goto protocol;
    if (!strcmp(m->type, "START") && m->fields == COMMON && s->configured && !s->startIssued) {
      if (!live_deadline(s)) goto done;
      s->startIssued = 1; send_frame(s, &s->root, "START", s->accepted, ""); goto done;
    }
    if (!strcmp(m->type, "SEAL") && m->fields == COMMON && s->controlComplete) { s->retiring = 1; goto done; }
  } else {
    if (strcmp(m->role, "root") || strcmp(m->generation, s->generation) || strcmp(m->preparationDigest, s->preparation) ||
        strcmp(m->payloadDigest, s->configuring ? s->proposed : s->accepted)) goto protocol;
    if (!strcmp(m->type, "HELLO") && m->fields == (COMMON | (1u << 14)) && s->resumed && !s->nonce[0] && hex64(m->clientNonce)) {
      DWORD retained;
      if (!GetNamedPipeClientProcessId(s->root.handle, &pid) || !(retained = GetProcessId(s->pi.hProcess)) ||
          pid != retained || WaitForSingleObject(s->pi.hProcess, 0) != WAIT_TIMEOUT ||
          !IsProcessInJob(s->pi.hProcess, s->job, &member) || !member || !live_deadline(s)) goto protocol;
      strcpy_s(s->nonce, sizeof(s->nonce), m->clientNonce);
      snprintf(extra, sizeof(extra), "\"clientNonce\":\"%s\",\"capability\":\"%s\"", s->nonce, s->capability);
      send_frame(s, &s->root, "AUTH", "", extra); goto done;
    }
    if (!strcmp(m->type, "ACK") && m->fields == (COMMON | (1u << 14)) && s->nonce[0] &&
        !s->authenticated && !strcmp(m->clientNonce, s->nonce)) {
      s->authenticated = 1; SecureZeroMemory(s->capability, sizeof(s->capability));
      if (!quote(s->payloadPath, quoted, sizeof(quoted)) || snprintf(extra, sizeof(extra), "\"payloadPath\":%s", quoted) >= (int)sizeof(extra)) goto protocol;
      send_frame(s, &s->parent, "READY", "", extra); goto done;
    }
    if (!strcmp(m->type, "CONFIGURED") && m->fields == COMMON && s->configuring && !s->configured) {
      strcpy_s(s->accepted, sizeof(s->accepted), s->proposed); s->configuring = 0; s->configured = 1;
      if (!release(s, s->payload)) goto done;
      s->payload = NULL; SecureZeroMemory(s->proposed, sizeof(s->proposed));
      send_frame(s, &s->parent, "CONFIGURED", s->accepted, ""); goto done;
    }
    if (!strcmp(m->type, "RESULT") && m->fields == (COMMON | (1u << 16)) && s->startIssued && !s->resultSeen &&
        result_valid(m->resultB64)) {
      strcpy_s(s->result, sizeof(s->result), m->resultB64); s->resultSeen = 1;
      snprintf(extra, sizeof(extra), "\"resultB64\":\"%s\"", s->result);
      send_frame(s, &s->parent, "RESULT", s->accepted, extra); goto done;
    }
  }
protocol:
  failure(s, "protocol");
done:
  SecureZeroMemory(extra, sizeof(extra)); SecureZeroMemory(quoted, sizeof(quoted));
  SecureZeroMemory(m, sizeof(*m)); if (!HeapFree(GetProcessHeap(), 0, m)) failure(s, "internal");
}
static void eof(OWNER *s, CHANNEL *io) {
  io->eof = 1;
  if (io->stop) return;
  if (io == &s->parent || io->used || !s->resultSeen || s->controlComplete) { failure(s, "protocol"); return; }
  s->controlComplete = 1;
  send_frame(s, &s->parent, "CONTROL_COMPLETE", s->accepted, "");
}
static void read_done(OWNER *s, CHANNEL *io, BOOL ok, DWORD error, DWORD n) {
  io->reading = 0;
  if (!ok) {
    if (io->stop && error == ERROR_OPERATION_ABORTED) return;
    if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA) { eof(s, io); return; }
    failure(s, "io"); return;
  }
  if (!n) { eof(s, io); return; }
  if (io->stop) return;
  io->used += n;
  if (io->used != io->target) return;
  if (io->target == 4) {
    DWORD length; memcpy(&length, io->input, 4);
    if (!length || length > BODY) { failure(s, "protocol"); return; }
    io->target = length + 4; return;
  }
  {
    char raw[BODY + 1]; DWORD length = io->target - 4;
    memcpy(raw, io->input + 4, length); raw[length] = 0;
    if (strlen(raw) != length || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, raw, (int)length, NULL, 0)) failure(s, "protocol");
    else message(s, io, raw);
    SecureZeroMemory(raw, sizeof(raw)); SecureZeroMemory(io->input, sizeof(io->input));
    io->used = 0; io->target = 4;
  }
}
static void write_done(OWNER *s, CHANNEL *io, BOOL ok, DWORD error, DWORD n) {
  io->writing = 0;
  if (!ok) { if (!(io->stop && error == ERROR_OPERATION_ABORTED)) failure(s, "io"); return; }
  if (!n || n > io->length[0] - io->offset) { failure(s, "io"); return; }
  io->offset += n;
  if (io->offset == io->length[0]) {
    SecureZeroMemory(io->output[0], FRAME); --io->queued; io->offset = 0;
    if (io->queued) { memcpy(io->output[0], io->output[1], FRAME); io->length[0] = io->length[1]; SecureZeroMemory(io->output[1], FRAME); }
  }
}
static void poll(OWNER *s, CHANNEL *io) {
  BOOL ok; DWORD n, error;
  if (io->reading) {
    n = 0; ok = GetOverlappedResult(io->handle, &io->read, &n, FALSE); error = GetLastError();
    if (ok || error != ERROR_IO_INCOMPLETE) read_done(s, io, ok, error, n);
  }
  if (io->writing) {
    n = 0; ok = GetOverlappedResult(io->handle, &io->write, &n, FALSE); error = GetLastError();
    if (ok || error != ERROR_IO_INCOMPLETE) write_done(s, io, ok, error, n);
  }
}
static void submit(OWNER *s, CHANNEL *io) {
  BOOL ok; DWORD n = 0, error; HANDLE event_handle;
  if (!io->handle || io->handle == INVALID_HANDLE_VALUE || io->stop || io->eof) return;
  if (!io->reading) {
    event_handle = io->read.hEvent; ZeroMemory(&io->read, sizeof(io->read)); io->read.hEvent = event_handle;
    if (!ResetEvent(event_handle)) { failure(s, "io"); return; }
    ok = ReadFile(io->handle, io->input + io->used, io->target - io->used, &n, &io->read); error = GetLastError();
    if (!ok && error == ERROR_IO_PENDING) io->reading = 1;
    else read_done(s, io, ok, error, n);
  }
  if (!io->writing && io->queued && !io->stop && !io->eof) {
    event_handle = io->write.hEvent; ZeroMemory(&io->write, sizeof(io->write)); io->write.hEvent = event_handle;
    if (!ResetEvent(event_handle)) { failure(s, "io"); return; }
    ok = WriteFile(io->handle, io->output[0] + io->offset, io->length[0] - io->offset, &n, &io->write); error = GetLastError();
    if (!ok && error == ERROR_IO_PENDING) io->writing = 1;
    else write_done(s, io, ok, error, n);
  }
}
static void cancel(OWNER *s, CHANNEL *io) {
  DWORD error;
  if (io->stop) return;
  io->stop = 1;
  if (io->reading && !CancelIoEx(io->handle, &io->read)) {
    error = GetLastError(); if (error != ERROR_NOT_FOUND) failure(s, "io");
  }
  if (io->writing && !CancelIoEx(io->handle, &io->write)) {
    error = GetLastError(); if (error != ERROR_NOT_FOUND) failure(s, "io");
  }
}
static void connect_poll(OWNER *s) {
  DWORD n, error; BOOL ok;
  if (!s->connecting) return;
  ok = GetOverlappedResult(s->root.handle, &s->connect, &n, FALSE); error = GetLastError();
  if (!ok && error == ERROR_IO_INCOMPLETE) return;
  s->connecting = 0;
  if (ok) s->connected = 1;
  else if (!(s->retiring && error == ERROR_OPERATION_ABORTED)) failure(s, "io");
}
static void retire(OWNER *s) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting; DWORD waited;
  if (!s->terminated) {
    s->terminated = 1; cancel(s, &s->root);
    if (s->connecting && !CancelIoEx(s->root.handle, &s->connect) && GetLastError() != ERROR_NOT_FOUND) failure(s, "io");
    if (s->pi.hProcess && !s->assigned && !TerminateProcess(s->pi.hProcess, 74)) failure(s, "retirement");
    if (s->job) {
      s->sealed = TerminateJobObject(s->job, 75) != 0;
      if (!s->sealed) failure(s, "retirement");
    }
  }
  if (s->job && s->sealed && !s->zero) {
    if (!QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) failure(s, "retirement");
    else if (!accounting.ActiveProcesses) s->zero = 1;
  }
  if (!s->pi.hProcess) s->rootRetired = 1;
  else if (!s->rootRetired) {
    waited = WaitForSingleObject(s->pi.hProcess, 0);
    if (waited == WAIT_OBJECT_0) s->rootRetired = 1;
    else if (waited != WAIT_TIMEOUT) failure(s, "retirement");
  }
}
static int receipt(OWNER *s, const char *body) {
  wchar_t name[32768]; HANDLE file; DWORD n = 0, error, length = (DWORD)strlen(body); int ok;
  OVERLAPPED write;
  if (!s->directory || swprintf_s(name, 32768, L"%ls\\retirement.json", s->privateRoot) < 0) return 0;
  file = new_file(s, name, FILE_FLAG_OVERLAPPED);
  if (file == INVALID_HANDLE_VALUE) return 0;
  if (!event(s, &write)) return 0;
  ok = WriteFile(file, body, length, &n, &write);
  error = GetLastError();
  if (!ok && error == ERROR_IO_PENDING) {
    for (;;) {
      ok = GetOverlappedResult(file, &write, &n, FALSE); error = GetLastError();
      if (ok || error != ERROR_IO_INCOMPLETE) break;
      if (!live_deadline(s)) {
        CancelIoEx(file, &write);
        // Stack/OVERLAPPED/body stay live through immediate process teardown.
        ExitProcess(1);
      }
      Sleep(0);
    }
  }
  ok = ok && n == length;
  if (!release(s, write.hEvent)) ok = 0;
  if (!release(s, file)) ok = 0;
  return ok;
}
static void terminal(OWNER *s) {
  char certificate[2048], extra[4096], result[688], digest[68]; int n, proof;
  if (s->terminal) return;
  if (!s->prepared) { s->terminal = 1; return; }
  proof = s->job && s->sealed && s->zero && s->rootRetired;
  if (s->resultSeen) quote(s->result, result, sizeof(result)); else strcpy_s(result, sizeof(result), "null");
  if (*s->accepted) quote(s->accepted, digest, sizeof(digest)); else strcpy_s(digest, sizeof(digest), "null");
  if (proof) {
    n = snprintf(certificate, sizeof(certificate),
      "{\"protocol\":\"" PROTOCOL "\",\"purpose\":\"triage-private-git\",\"generation\":\"%s\",\"preparationDigest\":\"%s\","
      "\"payloadDigest\":%s,\"sealed\":true,\"exactJobZero\":true,\"rootRetired\":true,\"startIssued\":%s,\"commandState\":\"%s\",\"resultB64\":%s}",
      s->generation, s->preparation, digest, s->startIssued ? "true" : "false",
      !s->startIssued ? "not_started" : s->resultSeen ? "reported" : "unknown", result);
    if (n <= 0 || n >= (int)sizeof(certificate)) { failure(s, "internal"); proof = 0; }
    else if (!receipt(s, certificate)) failure(s, "io");
  }
  n = snprintf(extra, sizeof(extra), "\"certificate\":%s,\"resultB64\":%s,\"failureCode\":\"%s\"",
    proof ? certificate : "null", result, s->failure[0] ? s->failure : "none");
  if (n <= 0 || n >= (int)sizeof(extra)) failure(s, "internal");
  else if (!s->parent.eof && live_deadline(s)) send_frame(s, &s->parent, "TERMINAL", s->accepted, extra);
  s->terminal = 1;
}
static int owner_main(void) {
  OWNER *s = (OWNER *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s));
  wchar_t clock[32], deadline[32]; DWORD i, waited, deadlineLength; int result = 1; uint64_t ticks, now, edge;
  if (!s) return 1;
  s->root.handle = INVALID_HANDLE_VALUE; s->parent.target = s->root.target = 4;
  deadlineLength = GetEnvironmentVariableW(L"DESK_OWNED_GIT_DEADLINE_NS", deadline, 32);
  if (GetEnvironmentVariableW(L"DESK_OWNED_GIT_CLOCK", clock, 32) != 12 || wcscmp(clock, L"win-qpc-ns/1") ||
      !deadlineLength || deadlineLength >= 32 ||
      !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, deadline, -1, s->deadlineText, sizeof(s->deadlineText), NULL, NULL) ||
      !decimal(s->deadlineText, &s->deadline) || !sample(s, &ticks, &now, &edge) ||
      edge >= s->deadline || s->deadline - now > 10000000000ULL) goto done;
  s->parent.handle = (HANDLE)_get_osfhandle(3);
  if (GetFileType(s->parent.handle) != FILE_TYPE_PIPE || !private_handle(s->parent.handle) ||
      !event(s, &s->parent.read) || !event(s, &s->parent.write) ||
      !event(s, &s->root.read) || !event(s, &s->root.write) || !event(s, &s->connect)) goto done;
  for (;;) {
    HANDLE waits[5]; DWORD count = 0, timeout;
    poll(s, &s->parent); if (s->root.handle != INVALID_HANDLE_VALUE) poll(s, &s->root);
    connect_poll(s);
    if (!live_deadline(s)) {
      retire(s); cancel(s, &s->parent);
      // No grace and no freeing an OVERLAPPED/buffer still referenced by the kernel.
      // Process teardown is unknown/HOLD, never a synthetic successful close.
      ExitProcess(1);
    }
    if (s->retiring) {
      retire(s);
      if (s->parent.eof) {
        cancel(s, &s->parent);
        if (!s->parent.writing) s->parent.queued = 0;
      }
      if ((!s->job || (s->sealed && s->zero)) && s->rootRetired &&
          !s->connecting && !s->root.reading && !s->root.writing) terminal(s);
      if (s->terminal && !s->parent.queued && !s->parent.writing) {
        cancel(s, &s->parent); poll(s, &s->parent);
        if (!s->parent.reading && !s->parent.writing) { result = s->failure[0] ? 1 : 0; break; }
      }
    }
    submit(s, &s->parent);
    if (s->connected && !s->retiring) submit(s, &s->root);
    if (s->parent.reading) waits[count++] = s->parent.read.hEvent;
    if (s->parent.writing) waits[count++] = s->parent.write.hEvent;
    if (s->root.reading) waits[count++] = s->root.read.hEvent;
    if (s->root.writing) waits[count++] = s->root.write.hEvent;
    if (s->connecting) waits[count++] = s->connect.hEvent;
    if (!sample(s, &ticks, &now, &edge)) { failure(s, "clock"); continue; }
    timeout = edge >= s->deadline ? 0 : (DWORD)((s->deadline - edge) / 1000000ULL);
    if (timeout > 10) timeout = 10;
    if (!count) Sleep(timeout);
    else {
      waited = WaitForMultipleObjects(count, waits, FALSE, timeout);
      if (waited == WAIT_FAILED) failure(s, "io");
    }
  }
done:
  if (s->parent.reading || s->parent.writing || s->root.reading || s->root.writing || s->connecting) ExitProcess(1);
  for (i = s->resourceCount; i > 0; --i) if (s->resources[i - 1] && !release(s, s->resources[i - 1])) result = 1;
  if (s->parent.handle && s->parent.handle != INVALID_HANDLE_VALUE && _close(3) != 0) result = 1;
  if (s->deadline && (!sample(s, &ticks, &now, &edge) || edge >= s->deadline)) result = 1;
  SecureZeroMemory(s, sizeof(*s)); if (!HeapFree(GetProcessHeap(), 0, s)) result = 1;
  return result;
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 2 || wcscmp(argv[1], L"--owned-git")) return 1;
  return owner_main();
}
