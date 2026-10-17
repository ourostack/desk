/* Broader retained-job owner for intentionally stranded Class C fixtures.
 * No private retirement certificate is created here. Never a pack asset.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <wchar.h>

static int noninheritable(HANDLE handle) {
  DWORD flags;
  return SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) &&
    GetHandleInformation(handle, &flags) && !(flags & HANDLE_FLAG_INHERIT);
}
int wmain(int argc, wchar_t **argv) {
  HANDLE job = NULL; PROCESS_INFORMATION pi; STARTUPINFOW si;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  wchar_t line[32768]; ULONGLONG deadline = GetTickCount64() + 120000;
  int launched = 0, assigned = 0, retired = 0, zero = 0, result = 1; DWORD wait, code;
  if (argc != 3 || wcschr(argv[1], L'"') || wcschr(argv[2], L'"') ||
      swprintf_s(line, 32768, L"\"%ls\" \"%ls\"", argv[1], argv[2]) < 0) return 1;
  ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si); ZeroMemory(&pi, sizeof(pi)); ZeroMemory(&limits, sizeof(limits));
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !noninheritable(job) ||
      !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto done;
  if (!CreateProcessW(argv[1], line, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) goto done;
  launched = 1;
  if (!noninheritable(pi.hProcess) || !noninheritable(pi.hThread)) goto retire;
  if (!AssignProcessToJobObject(job, pi.hProcess)) goto retire;
  assigned = 1;
  if (ResumeThread(pi.hThread) != 1) goto retire;
  while (GetTickCount64() < deadline) {
    wait = WaitForSingleObject(pi.hProcess, 10);
    if (wait == WAIT_OBJECT_0) {
      if (GetExitCodeProcess(pi.hProcess, &code)) result = code == 0 ? 0 : 1;
      break;
    }
    if (wait != WAIT_TIMEOUT) break;
  }
retire:
  if (launched && !assigned && !TerminateProcess(pi.hProcess, 90)) result = 1;
  if (!TerminateJobObject(job, 91)) result = 1;
  while (GetTickCount64() < deadline) {
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) break;
    zero = accounting.ActiveProcesses == 0;
    retired = !launched || WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0;
    if (zero && retired) break;
    Sleep(5);
  }
  if (!zero || !retired) result = 1;
done:
  if (pi.hThread && !CloseHandle(pi.hThread)) result = 1;
  if (pi.hProcess && !CloseHandle(pi.hProcess)) result = 1;
  if (job && !CloseHandle(job)) result = 1;
  return result;
}
