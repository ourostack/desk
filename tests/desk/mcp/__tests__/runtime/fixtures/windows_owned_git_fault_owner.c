/* Class C translation unit only; not a production entrypoint or asset.
 * Include identical production bytes; only this unit binds finite API faults.
 * Source-only: denominators and genuine kernel effects require later measurement.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdint.h>

static unsigned fixture_fault;
static BOOL WINAPI fixture_query(HANDLE job, JOBOBJECTINFOCLASS kind, LPVOID data, DWORD size, LPDWORD length) {
  if (fixture_fault == 1) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  return QueryInformationJobObject(job, kind, data, size, length);
}
static BOOL WINAPI fixture_assign(HANDLE job, HANDLE process) {
  if (fixture_fault == 2) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  return AssignProcessToJobObject(job, process);
}
static DWORD WINAPI fixture_resume(HANDLE thread) {
  if (fixture_fault == 3) { SetLastError(ERROR_ACCESS_DENIED); return MAXDWORD; }
  return ResumeThread(thread);
}
static BOOL WINAPI fixture_create(LPCWSTR application, LPWSTR line, LPSECURITY_ATTRIBUTES process_attributes,
  LPSECURITY_ATTRIBUTES thread_attributes, BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd,
  LPSTARTUPINFOW startup, LPPROCESS_INFORMATION pi) {
  BOOL result = CreateProcessW(application, line, process_attributes, thread_attributes, inherit, flags, env, cwd, startup, pi);
  if (result && fixture_fault == 4) Sleep(200);
  if (result && fixture_fault == 5) ExitProcess(93);
  return result;
}
#define QueryInformationJobObject fixture_query
#define AssignProcessToJobObject fixture_assign
#define ResumeThread fixture_resume
#define CreateProcessW fixture_create
#define wmain production_wmain
#include "../../../../../../plugins/desk/mcp/native/windows-owned-git.c"
#undef wmain
#undef ResumeThread
#undef CreateProcessW
#undef AssignProcessToJobObject
#undef QueryInformationJobObject

int wmain(int argc, wchar_t **argv) {
  wchar_t *fixed[] = { L"fault-owner", L"--owned-git" };
  uint64_t value, ticks, now, edge;
  OWNER clock_state;
  if (argc != 2) return 1;
  if (!wcscmp(argv[1], L"--query-failure")) fixture_fault = 1;
  else if (!wcscmp(argv[1], L"--assignment-failure")) fixture_fault = 2;
  else if (!wcscmp(argv[1], L"--resume-failure")) fixture_fault = 3;
  else if (!wcscmp(argv[1], L"--pause-after-create")) fixture_fault = 4;
  else if (!wcscmp(argv[1], L"--owner-loss-after-create")) fixture_fault = 5;
  else if (!wcscmp(argv[1], L"--clock-vector")) {
    return clock_convert(10000000ULL, 10000000ULL, &value) && value == 1000000000ULL ? 0 : 1;
  } else if (!wcscmp(argv[1], L"--delayed-entry")) {
    ZeroMemory(&clock_state, sizeof(clock_state));
    if (!sample(&clock_state, &ticks, &now, &edge)) return 1;
    // Keep the inherited immutable deadline unchanged across pre-main delay.
    Sleep(200);
  } else return 1;
  return production_wmain(2, fixed);
}
