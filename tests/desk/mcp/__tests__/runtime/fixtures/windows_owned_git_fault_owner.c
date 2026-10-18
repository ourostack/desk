#if defined(DESK_NA1_PROFILE_SUPPORT)
int __llvm_profile_runtime = 0;
#else
/* Class C translation unit only; not a production entrypoint or asset.
 * Include identical production bytes; only this unit binds finite API faults.
 * Source-only: denominators and genuine kernel effects require later measurement.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdint.h>

static BOOL WINAPI fixture_query(HANDLE, JOBOBJECTINFOCLASS, LPVOID, DWORD, LPDWORD);
static BOOL WINAPI fixture_assign(HANDLE, HANDLE);
static DWORD WINAPI fixture_resume(HANDLE);
static BOOL WINAPI fixture_create(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
  BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
static BOOL WINAPI fixture_qpc(LARGE_INTEGER *);
static BOOL WINAPI fixture_qpf(LARGE_INTEGER *);
static LPVOID WINAPI fixture_heap_alloc(HANDLE, DWORD, SIZE_T);
static BOOL WINAPI fixture_heap_free(HANDLE, DWORD, LPVOID);
static DWORD WINAPI fixture_wait(HANDLE, DWORD);
static BOOL WINAPI fixture_write(HANDLE, LPCVOID, DWORD, LPDWORD, LPOVERLAPPED);
static BOOL WINAPI fixture_overlapped_result(HANDLE, LPOVERLAPPED, LPDWORD, BOOL);
static BOOL WINAPI fixture_cancel_io(HANDLE, LPOVERLAPPED);
static BOOL WINAPI fixture_membership(HANDLE, HANDLE, PBOOL);
static BOOL WINAPI fixture_read(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
static BOOL WINAPI fixture_close_handle(HANDLE);
static DECLSPEC_NORETURN VOID WINAPI fixture_exit(UINT);
#define QueryInformationJobObject fixture_query
#define AssignProcessToJobObject fixture_assign
#define ResumeThread fixture_resume
#define CreateProcessW fixture_create
#define QueryPerformanceCounter fixture_qpc
#define QueryPerformanceFrequency fixture_qpf
#define HeapAlloc fixture_heap_alloc
#define HeapFree fixture_heap_free
#define WaitForSingleObject fixture_wait
#define WriteFile fixture_write
#define GetOverlappedResult fixture_overlapped_result
#define CancelIoEx fixture_cancel_io
#define IsProcessInJob fixture_membership
#define ExitProcess fixture_exit
#define ReadFile fixture_read
#define CloseHandle fixture_close_handle
#define wmain production_wmain
#include "../../../../../../plugins/desk/mcp/native/windows-owned-git.c"
#undef wmain
#undef ResumeThread
#undef CreateProcessW
#undef AssignProcessToJobObject
#undef QueryInformationJobObject
#undef QueryPerformanceCounter
#undef QueryPerformanceFrequency
#undef HeapAlloc
#undef HeapFree
#undef WaitForSingleObject
#undef WriteFile
#undef GetOverlappedResult
#undef CancelIoEx
#undef IsProcessInJob
#undef ExitProcess
#undef ReadFile
#undef CloseHandle

/* All bodies below call original APIs after undef. These extra handles/storage
 * are distinct from OWNER.resources[24]; none is forwarded to the Root. */
enum { REQUEST_NONE, REQUEST_CONTINUE, REQUEST_RESUME, REQUEST_SAMPLE, REQUEST_FINISH,
  REQUEST_SNAPSHOT, REQUEST_VECTOR0 = 16 };
typedef struct {
  OWNER *owner;
  HANDLE extra[64], control, stalled, peer;
  DWORD count, peak, used, target, outLength, outAt, requests, samples, vectors;
  OVERLAPPED input, output, connection, fileWrite, cueWrite;
  unsigned char incoming[4101], outgoing[4101];
  uint64_t end, H, qpcLast, eofAt;
  char mode[4], lastState[3072];
  int readPending, writePending, connectPending, filePending, cuePending, request;
  int enabled, failed, gap, seenOwner, ownerFreed, authChanged, pressure, dropping, suspended;
  int assignModeled, resumeModeled, memberModeled, queryModeled, waitModeled, clockModeled, liveWitness;
  int entryExpired, deadlineInputModeled;
  int utilityKind, expectedRequest, observationOnly;
  DWORD creationCalls;
  int cancelRead, cancelWrite, readReaped, writeReaped, rootLive, broaderMember;
  int routeSubmitted, routeWasPending, routeOutstanding, routeCancel, routeReaped;
} FIXTURE;
static FIXTURE fixture;
#define F_EVENT "desk.owned-git-fixture-event/1"
#define F_CONTROL "desk.owned-git-fixture-control/1"
static int fixture_now(uint64_t *now) {
  LARGE_INTEGER q, f;
  return QueryPerformanceCounter(&q) && QueryPerformanceFrequency(&f) &&
    q.QuadPart > 0 && f.QuadPart > 0 && clock_convert((uint64_t)q.QuadPart, (uint64_t)f.QuadPart, now);
}
static int fixture_live(void) {
  uint64_t now;
  return !fixture.failed && fixture_now(&now) && now < fixture.end;
}
static int fixture_transport_live(void) {
  uint64_t now, end=fixture.end;
  if (fixture.observationOnly) {
    if (fixture.H<=20000000000ULL) return 0;
    end=fixture.H-20000000000ULL;
  }
  return !fixture.failed && fixture_now(&now) && now<end;
}
static int fixture_track(HANDLE h) {
  if (!h || h == INVALID_HANDLE_VALUE || fixture.count == 64) return 0;
  fixture.extra[fixture.count++] = h;
  if (fixture.count > fixture.peak) fixture.peak = fixture.count;
  return private_handle(h);
}
static int fixture_close(HANDLE h) {
  DWORD i;
  for (i = 0; i < fixture.count; ++i) if (fixture.extra[i] == h) {
    if (!CloseHandle(h)) return 0;
    fixture.extra[i] = NULL; return 1;
  }
  return 0;
}
static int fixture_extra_close(void) {
  DWORD i; int good = 1;
  if (fixture.readPending || fixture.writePending || fixture.connectPending ||
      fixture.filePending || fixture.cuePending) return 0;
  for (i = fixture.count; i; --i) if (fixture.extra[i-1] && fixture.extra[i-1]!=fixture.control &&
    !fixture_close(fixture.extra[i-1])) good = 0;
  return good;
}
static int fixture_reset(OVERLAPPED *ov) {
  HANDLE event_handle=ov->hEvent;
  ZeroMemory(ov,sizeof(*ov)); ov->hEvent=event_handle;
  return ResetEvent(event_handle)!=0;
}
static void fixture_bridge_poll(void) {
  DWORD n = 0, error; BOOL ok;
  if (!fixture.enabled) return;
  if (fixture.writePending) {
    ok = GetOverlappedResult(fixture.control, &fixture.output, &n, FALSE); error = GetLastError();
    if (ok || error != ERROR_IO_INCOMPLETE) {
      fixture.writePending = 0;
      if (!ok || !n || n > fixture.outLength-fixture.outAt) fixture.failed = 1;
      else fixture.outAt += n;
    }
  }
  if (fixture.outAt < fixture.outLength && !fixture.writePending && !fixture.failed) {
    if (!fixture_reset(&fixture.output)) { fixture.failed=1; return; }
    ok = WriteFile(fixture.control, fixture.outgoing+fixture.outAt,
      fixture.outLength-fixture.outAt, &n, &fixture.output); error = GetLastError();
    if (!ok && error == ERROR_IO_PENDING) fixture.writePending = 1;
    else if (!ok || !n || n > fixture.outLength-fixture.outAt) fixture.failed = 1;
    else fixture.outAt += n;
  }
  if (fixture.readPending) {
    ok = GetOverlappedResult(fixture.control, &fixture.input, &n, FALSE); error = GetLastError();
    if (ok || error != ERROR_IO_INCOMPLETE) {
      fixture.readPending = 0;
      if (!ok || !n || n > fixture.target-fixture.used) fixture.failed = 1;
      else fixture.used += n;
    }
  }
  if (!fixture.observationOnly && fixture.used == fixture.target) {
    if (fixture.target == 4) {
      DWORD length; memcpy(&length, fixture.incoming, 4);
      if (!length || length > 4096) fixture.failed = 1;
      else fixture.target = length+4;
    } else {
      const char *body = (const char *)fixture.incoming+4; unsigned i;
      static const char *commands[] = { "CONTINUE", "RESUME_SERVER", "SAMPLE", "FINISH", "SNAPSHOT" };
      char expected[160];
      fixture.incoming[fixture.target] = 0;
      if (fixture.request || ++fixture.requests > 128) fixture.failed = 1;
      for (i=0; i<5; ++i) {
        sprintf_s(expected, sizeof(expected), "{\"schema\":\"" F_CONTROL "\",\"type\":\"%s\"}", commands[i]);
        if (!strcmp(body,expected)) fixture.request = (int)i+1;
      }
      for (i=0; i<8; ++i) {
        sprintf_s(expected,sizeof(expected),"{\"schema\":\"" F_CONTROL "\",\"type\":\"VECTOR%u\"}",i);
        if (!strcmp(body,expected)) fixture.request = REQUEST_VECTOR0+(int)i;
      }
      if (!fixture.request) fixture.failed = 1;
      if (fixture.utilityKind==1 || fixture.utilityKind==3) fixture.failed=1;
      else if (fixture.utilityKind==2 && fixture.request!=REQUEST_SAMPLE && fixture.request!=REQUEST_FINISH &&
        !(fixture.request>=REQUEST_VECTOR0 && fixture.request<REQUEST_VECTOR0+8)) fixture.failed=1;
      else if (!fixture.utilityKind && fixture.request!=REQUEST_SNAPSHOT && fixture.request!=fixture.expectedRequest) fixture.failed=1;
      SecureZeroMemory(fixture.incoming,sizeof(fixture.incoming)); fixture.used=0; fixture.target=4;
    }
  }
  if (!fixture.observationOnly && !fixture.readPending && !fixture.request && !fixture.failed) {
    if (!fixture_reset(&fixture.input)) { fixture.failed=1; return; }
    ok = ReadFile(fixture.control,fixture.incoming+fixture.used,fixture.target-fixture.used,&n,&fixture.input);
    error=GetLastError();
    if (!ok && error==ERROR_IO_PENDING) fixture.readPending=1;
    else if (!ok || !n || n>fixture.target-fixture.used) fixture.failed=1;
    else fixture.used+=n;
  }
}
static int fixture_emit(const char *body) {
  size_t length = strlen(body); DWORD size;
  if (!fixture.enabled) return 0;
  fixture_bridge_poll();
  if (fixture.failed || fixture.writePending || fixture.outAt != fixture.outLength ||
      !length || length > 4096) { fixture.gap=1; return 0; }
  size=(DWORD)length; memcpy(fixture.outgoing,&size,4); memcpy(fixture.outgoing+4,body,length);
  fixture.outLength=size+4; fixture.outAt=0; fixture_bridge_poll();
  return !fixture.failed;
}
static void fixture_capture_state(void) {
  OWNER *s=fixture.owner; BOOL member=FALSE; uint64_t now;
  const char *live="null", *broader="null"; char eof[32];
  if (!s) return;
  if (s->pi.hProcess) {
    DWORD waited=WaitForSingleObject(s->pi.hProcess,0);
    if (waited==WAIT_TIMEOUT) { live="true"; fixture.rootLive=1; }
    else if (waited==WAIT_OBJECT_0) live="false";
    if (IsProcessInJob(s->pi.hProcess,NULL,&member)) { broader=member?"true":"false"; fixture.broaderMember=member!=0; }
  }
  if (fixture.eofAt) sprintf_s(eof,sizeof(eof),"\"%llu\"",(unsigned long long)fixture.eofAt);
  else strcpy_s(eof,sizeof(eof),"null");
  if (!fixture_now(&now)) fixture.failed=1;
  sprintf_s(fixture.lastState,sizeof(fixture.lastState),
    "\"mode\":\"%s\",\"ownerCaptured\":true,\"created\":%s,\"assigned\":%s,\"resumed\":%s,"
    "\"startIssued\":%s,\"rootRetiredReported\":%s,\"privateZeroReported\":%s,"
    "\"rootLiveActual\":%s,\"anyJobMemberActual\":%s,\"assignmentModeled\":%s,\"resumeModeled\":%s,\"membershipModeled\":%s,"
    "\"queryModeled\":%s,\"rootWaitModeled\":%s,\"clockModeled\":%s,\"authMutated\":%s,"
    "\"ioRouteInstrumented\":%s,\"pendingRead\":%s,\"pendingWrite\":%s,\"cancelReadRequested\":%s,"
    "\"cancelWriteRequested\":%s,\"readReaped\":%s,\"writeReaped\":%s,\"storageRetained\":true,"
    "\"rootEOFAtNs\":%s,\"extraHandlesPeak\":%lu,\"deadlineNs\":\"%llu\"",
    fixture.mode,s->pi.hProcess?"true":"false",s->assigned?"true":"false",s->resumed?"true":"false",
    s->startIssued?"true":"false",s->rootRetired?"true":"false",s->zero?"true":"false",live,broader,
    fixture.assignModeled?"true":"false",fixture.resumeModeled?"true":"false",fixture.memberModeled?"true":"false",fixture.queryModeled?"true":"false",
    fixture.waitModeled?"true":"false",fixture.clockModeled?"true":"false",fixture.authChanged?"true":"false",
    (fixture.routeSubmitted&&fixture.routeWasPending)?"true":"false",(s->parent.reading||s->root.reading)?"true":"false",
    (!strcmp(fixture.mode,"C07")?fixture.routeOutstanding:(s->parent.writing||s->root.writing))?"true":"false",fixture.cancelRead?"true":"false",
    (!strcmp(fixture.mode,"C07")?fixture.routeCancel:fixture.cancelWrite)?"true":"false",fixture.readReaped?"true":"false",
    (!strcmp(fixture.mode,"C07")?fixture.routeReaped:fixture.writeReaped)?"true":"false",
    eof,(unsigned long)fixture.peak,(unsigned long long)fixture.end);
}
static void fixture_state(const char *phase) {
  char body[4097];
  if (strcmp(phase,"FINAL")) fixture_capture_state();
  if (!fixture.lastState[0]) return;
  sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"STATE\",\"phase\":\"%s\",%s,\"telemetryGap\":%s}",
    phase,fixture.lastState,fixture.gap?"true":"false");
  fixture_emit(body);
}
static int fixture_barrier(int request, const char *phase) {
  fixture.expectedRequest=request;
  fixture_state(phase);
  while (fixture_live()) {
    fixture_bridge_poll();
    if (fixture.request) {
      int got=fixture.request; fixture.request=0;
      if (got==request) { fixture.expectedRequest=0; return 1; }
      fixture.failed=1; break;
    }
    Sleep(1);
  }
  fixture.expectedRequest=0; return 0;
}
static void fixture_wait_deadline(void) {
  uint64_t now;
  while (fixture_now(&now) && now<fixture.end) { fixture_bridge_poll(); Sleep(1); }
}
static int fixture_stalled_pair(void) {
  wchar_t name[160]; DWORD n=0,error; BOOL ok;
  if (fixture.stalled) return 1;
  if (!fixture.owner) return 0;
  if (!strcmp(fixture.mode,"C08")) {
    if (swprintf_s(name,160,L"\\\\.\\pipe\\desk-owned-git-c1-io-%lu-%llu",
      (unsigned long)GetCurrentProcessId(),(unsigned long long)fixture.end)<0) return 0;
  } else if (!hex64(fixture.owner->generation) ||
    swprintf_s(name,160,L"\\\\.\\pipe\\desk-owned-git-c1-%hs",fixture.owner->generation)<0) return 0;
  fixture.stalled=CreateNamedPipeW(name,PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,512,512,0,NULL);
  if (!fixture_track(fixture.stalled)) return 0;
  fixture.connection.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(fixture.connection.hEvent)) return 0;
  ok=ConnectNamedPipe(fixture.stalled,&fixture.connection); error=GetLastError();
  if (!ok && error==ERROR_IO_PENDING) fixture.connectPending=1;
  else if (!ok && error!=ERROR_PIPE_CONNECTED) return 0;
  fixture.peer=CreateFileW(name,GENERIC_READ|GENERIC_WRITE,0,NULL,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,NULL);
  if (!fixture_track(fixture.peer)) return 0;
  while (fixture.connectPending && fixture_live()) {
    ok=GetOverlappedResult(fixture.stalled,&fixture.connection,&n,FALSE); error=GetLastError();
    if (ok || error!=ERROR_IO_INCOMPLETE) { fixture.connectPending=0; if (!ok) return 0; }
    else Sleep(1);
  }
  return !fixture.connectPending;
}
static int fixture_drop_server(OWNER *s) {
  DWORD prior; int good=0;
  if (!s || !s->pi.hThread || WaitForSingleObject(s->pi.hProcess,0)!=WAIT_TIMEOUT) return 0;
  prior=SuspendThread(s->pi.hThread);
  if (prior==MAXDWORD) return 0;
  if (prior) { if (ResumeThread(s->pi.hThread)!=prior+1) fixture.failed=1; return 0; }
  fixture.suspended=1; fixture.dropping=1;
  cancel(s,&s->root);
  if (s->connecting && !CancelIoEx(s->root.handle,&s->connect) && GetLastError()!=ERROR_NOT_FOUND) goto done;
  while ((s->root.reading||s->root.writing||s->connecting) && fixture_live()) {
    poll(s,&s->root); connect_poll(s); fixture_bridge_poll(); Sleep(1);
  }
  if (s->root.reading||s->root.writing||s->connecting || !release(s,s->root.handle)) goto done;
  s->root.handle=INVALID_HANDLE_VALUE;
  good=fixture_barrier(REQUEST_RESUME,"SERVER_CLOSED");
done:
  if (fixture.suspended) {
    if (!fixture_live()) good=0; /* Leave failed/expired work to actual job retirement. */
    else {
      if (ResumeThread(s->pi.hThread)!=1) good=0;
      fixture.suspended=0;
    }
  }
  fixture.dropping=0; return good;
}
static BOOL WINAPI fixture_query(HANDLE job,JOBOBJECTINFOCLASS kind,LPVOID data,DWORD size,LPDWORD length) {
  OWNER *s=fixture.owner;
  if (s && job==s->job && kind==JobObjectBasicAccountingInformation && s->retiring &&
      !strcmp(fixture.mode,"O05")) { fixture.queryModeled=1; SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  if (s && job==s->job && kind==JobObjectBasicAccountingInformation && !strcmp(fixture.mode,"C15")) {
    fixture.queryModeled=1;
    if (size<sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)) { SetLastError(ERROR_BAD_LENGTH); return FALSE; }
    ZeroMemory(data,sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); return TRUE;
  }
  return QueryInformationJobObject(job,kind,data,size,length);
}
static BOOL WINAPI fixture_assign(HANDLE job,HANDLE process) {
  if (!strcmp(fixture.mode,"O02") || !strcmp(fixture.mode,"O07")) {
    fixture.assignModeled=1;
    if (!strcmp(fixture.mode,"O02")) fixture_barrier(REQUEST_CONTINUE,"CREATED_SUSPENDED");
    SetLastError(ERROR_ACCESS_DENIED); return FALSE;
  }
  if (!strcmp(fixture.mode,"C15")) { fixture.assignModeled=1; return TRUE; }
  return AssignProcessToJobObject(job,process);
}
static DWORD WINAPI fixture_resume(HANDLE thread) {
  if (!strcmp(fixture.mode,"O03") || !strcmp(fixture.mode,"O06")) {
    fixture.resumeModeled=1;
    if (!strcmp(fixture.mode,"O03")) fixture_barrier(REQUEST_CONTINUE,"ASSIGNED_SUSPENDED");
    SetLastError(ERROR_ACCESS_DENIED); return MAXDWORD;
  }
  return ResumeThread(thread);
}
static BOOL WINAPI fixture_membership(HANDLE process,HANDLE job,PBOOL member) {
  if (fixture.owner && process==fixture.owner->pi.hProcess && job==fixture.owner->job) {
    if (!strcmp(fixture.mode,"C15")) { fixture.memberModeled=1; *member=TRUE; return TRUE; }
    if (!strcmp(fixture.mode,"C04")) {
      BOOL result=IsProcessInJob(process,job,member);
      if (!result || !*member || WaitForSingleObject(process,0)!=WAIT_TIMEOUT) {
        fixture.failed=1; return result;
      }
      fixture_state("ASSIGNED_SUSPENDED"); fixture_wait_deadline(); return result;
    }
  }
  return IsProcessInJob(process,job,member);
}
static BOOL WINAPI fixture_create(LPCWSTR app,LPWSTR line,LPSECURITY_ATTRIBUTES pa,LPSECURITY_ATTRIBUTES ta,
  BOOL inherit,DWORD flags,LPVOID env,LPCWSTR cwd,LPSTARTUPINFOW startup,LPPROCESS_INFORMATION pi) {
  if (flags & CREATE_BREAKAWAY_FROM_JOB) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  ++fixture.creationCalls;
  return CreateProcessW(app,line,pa,ta,inherit,flags,env,cwd,startup,pi);
}
static BOOL WINAPI fixture_qpf(LARGE_INTEGER *frequency) {
  if (!strcmp(fixture.mode,"C16")) { fixture.clockModeled=1; fixture_state("CLOCK_REFUSAL"); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  return QueryPerformanceFrequency(frequency);
}
static BOOL WINAPI fixture_qpc(LARGE_INTEGER *ticks) {
  BOOL result=QueryPerformanceCounter(ticks);
  if (result && !strcmp(fixture.mode,"C18")) {
    if (fixture.qpcLast) { ticks->QuadPart=(LONGLONG)(fixture.qpcLast-1); fixture.clockModeled=1; fixture_state("CLOCK_REFUSAL"); }
    else fixture.qpcLast=(uint64_t)ticks->QuadPart;
  }
  return result;
}
static LPVOID WINAPI fixture_heap_alloc(HANDLE heap,DWORD flags,SIZE_T size) {
  LPVOID value=HeapAlloc(heap,flags,size);
  if (value && !fixture.seenOwner && size==sizeof(OWNER)) { fixture.owner=(OWNER *)value; fixture.seenOwner=1; }
  return value;
}
static BOOL WINAPI fixture_heap_free(HANDLE heap,DWORD flags,LPVOID value) {
  BOOL result;
  if (value==fixture.owner) { fixture_state("FINAL"); fixture.owner=NULL; result=HeapFree(heap,flags,value); fixture.ownerFreed=result!=0; return result; }
  return HeapFree(heap,flags,value);
}
static BOOL WINAPI fixture_close_handle(HANDLE handle) {
  OWNER *s=fixture.owner;
  /* S01 clears OWNER before HeapFree. Cache scalars while its original process
   * handle is still owned; FINAL serializes that cache, never zeroed/freed data. */
  if (s && handle==s->pi.hProcess) fixture_capture_state();
  return CloseHandle(handle);
}
static DWORD WINAPI fixture_wait(HANDLE handle,DWORD milliseconds) {
  if (fixture.owner && fixture.owner->retiring && handle==fixture.owner->pi.hProcess && !strcmp(fixture.mode,"C15")) {
    fixture.waitModeled=1; return WAIT_OBJECT_0;
  }
  return WaitForSingleObject(handle,milliseconds);
}
static int fixture_auth(OWNER *s) {
  MESSAGE *m; char raw[BODY+1], *key=NULL; DWORD length; int good=1;
  if (fixture.authChanged || strcmp(fixture.mode,"C09")<0 || strcmp(fixture.mode,"C13")>0 ||
      !s->root.queued || s->root.offset || s->root.writing) return 1;
  length=s->root.length[0]-4;
  if (!length || length>BODY) return 0;
  memcpy(raw,s->root.output[0]+4,length); raw[length]=0;
  m=(MESSAGE *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*m));
  if (!m) { SecureZeroMemory(raw,sizeof(raw)); return 0; }
  if (!parse(raw,m) || strcmp(m->type,"AUTH")) goto done;
  if (!strcmp(fixture.mode,"C09")) key=strstr(raw,"\"capability\":\"");
  if (!strcmp(fixture.mode,"C10")) key=strstr(raw,"\"clientNonce\":\"");
  if (!strcmp(fixture.mode,"C11")) key=strstr(raw,"\"generation\":\"");
  if (key) { key=strchr(key,':')+2; *key=*key=='a'?'b':'a'; }
  else if (!strcmp(fixture.mode,"C12")) {
    key=strstr(raw,"\"role\":\"owner\"");
    if (!key) { good=0; goto done; }
    memcpy(key+8,"other",5);
  } else if (!strcmp(fixture.mode,"C13")) {
    if (s->root.queued!=1 || !enqueue(s,&s->root,raw)) { good=0; goto done; }
  } else { good=0; goto done; }
  if (strcmp(fixture.mode,"C13")) memcpy(s->root.output[0]+4,raw,length);
  fixture.authChanged=1;
done:
  SecureZeroMemory(raw,sizeof(raw)); SecureZeroMemory(m,sizeof(*m));
  return HeapFree(GetProcessHeap(),0,m) && good;
}
static int fixture_start_frame(OWNER *s) {
  MESSAGE *m; char raw[BODY+1]; DWORD n; int start=0;
  if (!s || !s->root.queued || s->root.length[0]<4 || s->root.length[0]>FRAME) return 0;
  n=s->root.length[0]-4; memcpy(raw,s->root.output[0]+4,n); raw[n]=0;
  m=(MESSAGE *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*m));
  if (m) {
    start=parse(raw,m) && !strcmp(m->type,"START");
    SecureZeroMemory(m,sizeof(*m)); if (!HeapFree(GetProcessHeap(),0,m)) fixture.failed=1;
  } else fixture.failed=1;
  SecureZeroMemory(raw,sizeof(raw)); return start;
}
static BOOL WINAPI fixture_write(HANDLE handle,LPCVOID bytes,DWORD size,LPDWORD written,LPOVERLAPPED ov) {
  OWNER *s=fixture.owner; BOOL result;
  if (s && handle==s->root.handle && ov==&s->root.write && !fixture.dropping) {
    if (!fixture_auth(s)) { SetLastError(ERROR_INVALID_DATA); return FALSE; }
    if (!strcmp(fixture.mode,"C14") && s->nonce[0] && !s->authenticated) {
      if (!fixture_drop_server(s)) fixture.failed=1;
      *written=0; SetLastError(ERROR_BROKEN_PIPE); return FALSE;
    }
    if ((!strcmp(fixture.mode,"C07") || !strcmp(fixture.mode,"C15")) && s->startIssued && !fixture.pressure) {
      if (!strcmp(fixture.mode,"C07")) {
        char pressure[2049]; memset(pressure,'x',sizeof(pressure)-1); pressure[sizeof(pressure)-1]=0;
        while ((s->parent.queued||s->parent.writing) && fixture_live()) {
          poll(s,&s->parent); fixture_bridge_poll(); Sleep(1);
        }
        if (!fixture_stalled_pair() || !enqueue(s,&s->parent,pressure) || !enqueue(s,&s->parent,pressure)) {
          SetLastError(ERROR_NOT_ENOUGH_MEMORY); return FALSE;
        }
        fixture.writeReaped=0; fixture.cancelWrite=0;
      }
      fixture.pressure=!strcmp(fixture.mode,"C07");
    }
  }
  if (s && fixture.pressure && handle==s->parent.handle && ov==&s->parent.write) {
    DWORD error;
    result=WriteFile(fixture.stalled,bytes,size,written,ov); error=GetLastError();
    fixture.routeSubmitted=1;
    if (!result && error==ERROR_IO_PENDING) { fixture.routeWasPending=1; fixture.routeOutstanding=1; }
    SetLastError(error); return result;
  }
  result=WriteFile(handle,bytes,size,written,ov);
  if (result && s && !strcmp(fixture.mode,"C15") && handle==s->root.handle && ov==&s->root.write &&
      s->startIssued && *written==size && !fixture.liveWitness && fixture_start_frame(s)) {
    DWORD error=GetLastError(); fixture.liveWitness=1; fixture_state("ROOT_LIVE"); SetLastError(error);
  }
  return result;
}
static void fixture_parent_completion(HANDLE handle,LPOVERLAPPED ov,BOOL result,DWORD bytes,DWORD error) {
  OWNER *s=fixture.owner;
  if (!s || handle!=s->parent.handle || ov!=&s->parent.read) return;
  if (!strcmp(fixture.mode,"C06") && !result && !s->retiring &&
      (error==ERROR_BROKEN_PIPE||error==ERROR_PIPE_NOT_CONNECTED||error==ERROR_NO_DATA)) fixture_wait_deadline();
  if (result && !strcmp(fixture.mode,"C05") && s->parent.target>4 &&
      s->parent.used+bytes==s->parent.target) {
    char raw[BODY+1]; MESSAGE *m=(MESSAGE *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*m));
    if (!m) { fixture.failed=1; return; }
    memcpy(raw,s->parent.input+4,s->parent.target-4); raw[s->parent.target-4]=0;
    if (parse(raw,m) && !strcmp(m->type,"START")) { fixture_state("BEFORE_NATIVE_START"); fixture_wait_deadline(); }
    SecureZeroMemory(raw,sizeof(raw)); SecureZeroMemory(m,sizeof(*m));
    if (!HeapFree(GetProcessHeap(),0,m)) fixture.failed=1;
  }
}
static BOOL WINAPI fixture_read(HANDLE handle,LPVOID buffer,DWORD size,LPDWORD bytes,LPOVERLAPPED ov) {
  BOOL result=ReadFile(handle,buffer,size,bytes,ov); DWORD error=GetLastError();
  OWNER *s=fixture.owner;
  if (s && handle==s->root.handle && ov==&s->root.read &&
      ((result && !*bytes) || (!result && (error==ERROR_BROKEN_PIPE||error==ERROR_PIPE_NOT_CONNECTED||error==ERROR_NO_DATA))))
    fixture_now(&fixture.eofAt);
  if (result || error!=ERROR_IO_PENDING) fixture_parent_completion(handle,ov,result,*bytes,error);
  SetLastError(error); return result;
}
static BOOL WINAPI fixture_overlapped_result(HANDLE handle,LPOVERLAPPED ov,LPDWORD bytes,BOOL wait) {
  OWNER *s=fixture.owner; BOOL result; DWORD error;
  HANDLE actual=(s && fixture.pressure && handle==s->parent.handle && ov==&s->parent.write)?fixture.stalled:handle;
  result=GetOverlappedResult(actual,ov,bytes,wait); error=GetLastError();
  if (actual==fixture.stalled && s && ov==&s->parent.write && fixture.routeOutstanding &&
      (result || error==ERROR_OPERATION_ABORTED || error==ERROR_BROKEN_PIPE ||
       error==ERROR_NO_DATA || error==ERROR_PIPE_NOT_CONNECTED)) {
    fixture.routeOutstanding=0; fixture.routeReaped=1;
  }
  if (s && !strcmp(fixture.mode,"C06") && !result && error==ERROR_IO_INCOMPLETE &&
      handle==s->parent.handle && ov==&s->parent.read && s->resumed && !fixture.lastState[0]) fixture_state("OBSERVER_PENDING");
  if (s && (result || error!=ERROR_IO_INCOMPLETE)) {
    if (ov==&s->parent.read || ov==&s->root.read) fixture.readReaped=1;
    if (ov==&s->parent.write || ov==&s->root.write) fixture.writeReaped=1;
    if (handle==s->root.handle && ov==&s->root.read && ((!result &&
        (error==ERROR_BROKEN_PIPE||error==ERROR_NO_DATA||error==ERROR_PIPE_NOT_CONNECTED)) || (result && !*bytes)))
      fixture_now(&fixture.eofAt);
    fixture_parent_completion(handle,ov,result,*bytes,error);
    if (result && !strcmp(fixture.mode,"C15") && handle==s->root.handle && ov==&s->root.write &&
        s->startIssued && *bytes==s->root.length[0]-s->root.offset && !fixture.liveWitness &&
        fixture_start_frame(s)) { fixture.liveWitness=1; fixture_state("ROOT_LIVE"); }
  }
  fixture_bridge_poll();
  if (fixture.request==REQUEST_SNAPSHOT && s && strcmp(fixture.mode,"C08")) {
    fixture.request=0; fixture_state("OBSERVE");
  }
  SetLastError(error); return result;
}
static BOOL WINAPI fixture_cancel_io(HANDLE handle,LPOVERLAPPED ov) {
  OWNER *s=fixture.owner;
  if (s && (ov==&s->parent.read || ov==&s->root.read)) fixture.cancelRead=1;
  if (s && (ov==&s->parent.write || ov==&s->root.write)) fixture.cancelWrite=1;
  if (s && fixture.pressure && handle==s->parent.handle && ov==&s->parent.write) {
    BOOL result=CancelIoEx(fixture.stalled,ov); DWORD error=GetLastError();
    if (result && fixture.routeOutstanding) fixture.routeCancel=1;
    SetLastError(error); return result;
  }
  return CancelIoEx(handle,ov);
}
static int fixture_bridge_finish(void);
static int fixture_observation_cleanup_allowed(void) {
  OWNER *s=fixture.owner;
  if (!fixture.creationCalls && fixture.ownerFreed && !s) return 1;
  return s && s->pi.hProcess && s->assigned && s->job && s->terminated && s->sealed &&
    !fixture.assignModeled && !fixture.memberModeled && !fixture.waitModeled;
}
static DECLSPEC_NORETURN VOID WINAPI fixture_exit(UINT code) {
  char body[512];
  /* The included application's ExitProcess has ended dispatch. A successful
   * real private-job seal is required before delaying its actual teardown.
   * No application read/write/poll/resume runs in this fd4-only interval. */
  if ((!strcmp(fixture.mode,"O05") || !strcmp(fixture.mode,"C04") ||
      !strcmp(fixture.mode,"C05") || !strcmp(fixture.mode,"C06") || !strcmp(fixture.mode,"C07")) &&
      fixture_observation_cleanup_allowed()) {
    fixture.observationOnly=1;
    while ((fixture.writePending||fixture.outAt<fixture.outLength) && fixture_transport_live()) {
      fixture_bridge_poll(); Sleep(1);
    }
  }
  if (fixture.observationOnly) {
    fixture_state("TEARDOWN");
    while ((fixture.writePending||fixture.outAt<fixture.outLength) && fixture_transport_live()) {
      fixture_bridge_poll(); Sleep(1);
    }
    sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"ENTRY_RESULT\",\"creationCalls\":%lu,"
      "\"ownerFreed\":%s,\"expiredBeforeEntry\":%s,\"deadlineInputModeled\":%s,\"clockModeled\":%s,\"deadlineNs\":\"%llu\"}",
      (unsigned long)fixture.creationCalls,fixture.ownerFreed?"true":"false",fixture.entryExpired?"true":"false",fixture.deadlineInputModeled?"true":"false",
      fixture.clockModeled?"true":"false",(unsigned long long)fixture.end);
    fixture_emit(body);
    fixture_bridge_finish();
  }
  /* Pending buffers/events remain static/live through actual process teardown.
   * A best-effort final event is not an invented write completion or reap. */
  ExitProcess(code);
}

/* Class C SOURCE ONLY: later native admission must execute the actual validator. */
static int fixture_result_vectors(BOOL bits[5]) {
  const char enoent[] =
    "eyJjb21tYW5kIjp7InN0YXRlIjoic3Bhd25fZmFpbGVkIiwiY29kZSI6IkVOT0VOVCJ9LCJpbnB1dCI6eyJzdGF0ZSI6ImNvbXBsZXRlIiwiZXhwZWN0ZWRCeXRlcyI6MCwic3VibWl0dGVkQnl0ZXMiOjAsImVycm9yQ29kZSI6bnVsbH19";
  const char maximal[] =
    "eyJjb21tYW5kIjp7InN0YXRlIjoic3Bhd25fZmFpbGVkIiwiY29kZSI6IlhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYIn0sImlucHV0Ijp7InN0YXRlIjoidW5rbm93biIsImV4cGVjdGVkQnl0ZXMiOjkwMDcxOTkyNTQ3NDA5OTEsInN1Ym1pdHRlZEJ5dGVzIjo5MDA3MTk5MjU0NzQwOTkxLCJlcnJvckNvZGUiOiJZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWSJ9fQ==";
  const char whitespace[] =
    "eyJjb21tYW5kIjp7InN0YXRlIjoic3Bhd25fZmFpbGVkIiwiY29kZSI6IkVOT0VOVCJ9LCJpbnB1dCI6eyJzdGF0ZSI6ImNvbXBsZXRlIiwiZXhwZWN0ZWRCeXRlcyI6MCwic3VibWl0dGVkQnl0ZXMiOjAsImVycm9yQ29kZSI6bnVsbH19IA==";
  char padded[sizeof(enoent) + 4], oversized[685]; size_t i;
  memcpy(padded, enoent, sizeof(enoent) - 1);
  memcpy(padded + sizeof(enoent) - 1, "====", 5);
  for (i = 0; i < 684; i += 4) memcpy(oversized + i, "ICAg", 4);
  oversized[684] = 0; /* 513 decoded spaces: within base64 bound, outside decoded bound. */
  bits[0]=result_valid(enoent); bits[1]=result_valid(maximal); bits[2]=result_valid(padded);
  bits[3]=result_valid(whitespace); bits[4]=result_valid(oversized);
  return bits[0] && bits[1] && !bits[2] && !bits[3] && !bits[4] ? 0 : 1;
}

static int fixture_env_decimal(const wchar_t *key,uint64_t *value) {
  wchar_t wide_value[32]; char text[32]; DWORD n=GetEnvironmentVariableW(key,wide_value,32);
  return n && n<32 && WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide_value,-1,text,32,NULL,NULL) && decimal(text,value);
}
static int fixture_scope(int model) {
  uint64_t now; BOOL member=FALSE;
  if (!fixture_env_decimal(L"DESK_TEST_OWNED_GIT_H",&fixture.H) ||
      !fixture_env_decimal(model?L"DESK_TEST_OWNED_GIT_MODEL_D":L"DESK_TEST_OWNED_GIT_D",&fixture.end) ||
      !fixture_now(&now) || fixture.H<=20000000000ULL || fixture.end>fixture.H-12000000000ULL ||
      fixture.end<=now || fixture.end-now>(model?2000000000ULL:10000000000ULL) ||
      !IsProcessInJob(GetCurrentProcess(),NULL,&member) || !member) return 0;
  return 1;
}
static int fixture_bridge_open(void) {
  fixture.control=(HANDLE)_get_osfhandle(4);
  if (GetFileType(fixture.control)!=FILE_TYPE_PIPE || !private_handle(fixture.control)) return 0;
  fixture.extra[fixture.count++]=fixture.control; fixture.peak=fixture.count;
  fixture.input.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(fixture.input.hEvent)) return 0;
  fixture.output.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(fixture.output.hEvent)) return 0;
  fixture.target=4; fixture.enabled=1;
  return 1;
}
static int fixture_bridge_finish(void) {
  DWORD n=0,error; BOOL ok; int good=1; char body[256];
  while ((fixture.writePending || fixture.outAt<fixture.outLength) && fixture_transport_live()) { fixture_bridge_poll(); Sleep(1); }
  if (fixture.writePending || fixture.outAt<fixture.outLength) goto unknown;
  sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"CLOSED\","
    "\"requests\":%lu,\"creationCalls\":%lu,\"ownerFreed\":%s,\"telemetryGap\":%s,\"deadlineNs\":\"%llu\"}",
    (unsigned long)fixture.requests,(unsigned long)fixture.creationCalls,fixture.ownerFreed?"true":"false",fixture.gap?"true":"false",(unsigned long long)fixture.end);
  if (!fixture_emit(body)) goto unknown;
  while ((fixture.writePending || fixture.outAt<fixture.outLength) && fixture_transport_live()) { fixture_bridge_poll(); Sleep(1); }
  if (fixture.writePending || fixture.outAt<fixture.outLength) goto unknown;
  if (fixture.readPending) {
    if (!CancelIoEx(fixture.control,&fixture.input) && GetLastError()!=ERROR_NOT_FOUND) good=0;
    while (fixture.readPending && fixture_transport_live()) {
      ok=GetOverlappedResult(fixture.control,&fixture.input,&n,FALSE); error=GetLastError();
      if (ok || error!=ERROR_IO_INCOMPLETE) {
        fixture.readPending=0; if (!ok && error!=ERROR_OPERATION_ABORTED) good=0;
      } else Sleep(1);
    }
  }
  if (fixture.readPending) goto unknown;
  if (fixture.observationOnly) {
    /* Auxiliary/application OVERLAPPED storage and its handles are not reaped
     * by an fd4 flush. Keep them live until the real process teardown. */
    if (!fixture_close(fixture.input.hEvent) || !fixture_close(fixture.output.hEvent)) goto unknown;
  } else if (!fixture_extra_close()) goto unknown;
  fixture.enabled=0;
  if (_close(4)) good=0; else fixture.extra[0]=NULL;
  return good && !fixture.failed && !fixture.gap && fixture_transport_live();
unknown:
  if (fixture.readPending) CancelIoEx(fixture.control,&fixture.input);
  if (fixture.writePending) CancelIoEx(fixture.control,&fixture.output);
  if (fixture.connectPending) CancelIoEx(fixture.stalled,&fixture.connection);
  /* No post-D grace, freeing pending storage or fake CLOSED-on-exit inference. */
  ExitProcess(1);
}
static int fixture_clock_utility(void) {
  OWNER *state=(OWNER *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*state));
  static const uint64_t q[8]={10000000ULL,1,0,9007199254740993ULL,UINT64_MAX,1,1,UINT64_MAX};
  static const uint64_t f[8]={10000000ULL,10000000ULL,1000000000ULL,1000000000ULL,1000000000ULL,0,3,1};
  static const uint64_t expected[8]={1000000000ULL,100ULL,0,9007199254740992ULL,0,0,333333333ULL,0};
  static const int accepts[8]={1,1,1,1,0,0,1,0};
  unsigned vector_mask=0; int result=1;
  if (!state) return 1;
  while (fixture_live()) {
    int request; uint64_t ticks=0,now=0,edge=0,value=0; char body[512], converted[32]; int accepted;
    fixture_bridge_poll(); request=fixture.request;
    if (!request) { Sleep(1); continue; }
    fixture.request=0;
    while ((fixture.writePending || fixture.outAt<fixture.outLength) && fixture_live()) { fixture_bridge_poll(); Sleep(1); }
    if (!fixture_live()) break;
    if (request==REQUEST_SAMPLE && fixture.samples<64) {
      if (!sample(state,&ticks,&now,&edge)) break;
      sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"CLOCK\",\"index\":%lu,"
        "\"q\":\"%llu\",\"f\":\"%llu\",\"converted\":\"%llu\",\"edge\":\"%llu\",\"accepted\":true,\"modeled\":false}",
        (unsigned long)fixture.samples++,(unsigned long long)ticks,(unsigned long long)state->frequency,
        (unsigned long long)now,(unsigned long long)edge);
    } else if (request>=REQUEST_VECTOR0 && request<REQUEST_VECTOR0+8) {
      unsigned i=(unsigned)(request-REQUEST_VECTOR0);
      if (vector_mask&(1u<<i)) break;
      vector_mask|=1u<<i; ++fixture.vectors;
      accepted=clock_convert(q[i],f[i],&value);
      if (accepted!=accepts[i] || (accepted && value!=expected[i])) break;
      if (accepted) sprintf_s(converted,sizeof(converted),"\"%llu\"",(unsigned long long)value);
      else strcpy_s(converted,sizeof(converted),"null");
      sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"SCALAR\",\"index\":%u,"
        "\"q\":\"%llu\",\"f\":\"%llu\",\"converted\":%s,\"accepted\":%s,\"modeled\":true}",
        i,(unsigned long long)q[i],(unsigned long long)f[i],converted,accepted?"true":"false");
    } else if (request==REQUEST_FINISH && fixture.samples==64 && (fixture.vectors==0||fixture.vectors==8)) {
      result=0; break;
    } else break;
    if (!fixture_emit(body)) break;
  }
  SecureZeroMemory(state,sizeof(*state));
  if (!HeapFree(GetProcessHeap(),0,state)) result=1; else fixture.ownerFreed=1;
  return result;
}
static int fixture_io_utility(void) {
  OWNER *s=(OWNER *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*s));
  BOOL checks[8]={FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE}; char body[512], pressure[2049];
  unsigned passed=0,i; int result=1;
  if (!s) return 1;
  fixture.owner=s; fixture.seenOwner=1; strcpy_s(fixture.mode,sizeof(fixture.mode),"C08");
  /* A utility pipe name is not a generation or authority identifier. */
  if (!fixture_stalled_pair()) goto done;
  s->parent.handle=fixture.stalled; s->parent.target=4;
  s->parent.read.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(s->parent.read.hEvent)) goto done;
  s->parent.write.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(s->parent.write.hEvent)) goto done;
  memset(pressure,'p',sizeof(pressure)-1); pressure[sizeof(pressure)-1]=0;
  if (!enqueue(s,&s->parent,pressure) || !enqueue(s,&s->parent,pressure)) goto done;
  submit(s,&s->parent); poll(s,&s->parent);
  checks[0]=s->parent.reading!=0; checks[1]=s->parent.writing!=0;
  if (!checks[0] || !checks[1]) goto done;
  cancel(s,&s->parent);
  checks[2]=fixture.cancelRead!=0; checks[3]=fixture.cancelWrite!=0;
  while ((s->parent.reading||s->parent.writing) && fixture_live()) { poll(s,&s->parent); fixture_bridge_poll(); Sleep(1); }
  checks[4]=!s->parent.reading && fixture.readReaped;
  checks[5]=!s->parent.writing && fixture.writeReaped;
  checks[6]=checks[4]&&checks[5]; checks[7]=!s->parent.eof;
  for (i=0;i<8;++i) if (checks[i]) ++passed;
  sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"IO\",\"checks\":[%s,%s,%s,%s,%s,%s,%s,%s],"
    "\"checksPassed\":%u,\"syntheticEOF\":false,\"kernelCredit\":false}",
    checks[0]?"true":"false",checks[1]?"true":"false",checks[2]?"true":"false",checks[3]?"true":"false",
    checks[4]?"true":"false",checks[5]?"true":"false",checks[6]?"true":"false",checks[7]?"true":"false",passed);
  if (!fixture_emit(body)) goto done;
  result=passed==8?0:1;
done:
  if (s->parent.reading||s->parent.writing) {
    cancel(s,&s->parent);
    while ((s->parent.reading||s->parent.writing) && fixture_live()) { poll(s,&s->parent); fixture_bridge_poll(); Sleep(1); }
  }
  if (fixture.connectPending) {
    DWORD n=0; BOOL ok;
    CancelIoEx(fixture.stalled,&fixture.connection);
    while (fixture.connectPending && fixture_live()) {
      ok=GetOverlappedResult(fixture.stalled,&fixture.connection,&n,FALSE);
      if (ok || GetLastError()!=ERROR_IO_INCOMPLETE) fixture.connectPending=0; else Sleep(1);
    }
  }
  if (s->parent.reading||s->parent.writing||fixture.connectPending) ExitProcess(1);
  fixture_capture_state(); fixture.owner=NULL;
  SecureZeroMemory(s,sizeof(*s)); if (!HeapFree(GetProcessHeap(),0,s)) result=1; else fixture.ownerFreed=1;
  return result;
}
static int fixture_model_bootstrap(void) {
  OWNER *security_owner=NULL; SECURITY security; wchar_t root[32768],file[32768],value[128];
  char nonce[65],revision[41],tree[41],hash[65],body[2048]; HANDLE fd=NULL; DWORD n=0,error; BOOL ok; int result=1;
  static const char cue[]="MODEL_BOOTSTRAP_CLOSED\n";
  const wchar_t *keys[4]={L"DESK_TEST_OWNED_GIT_MODEL_NONCE",L"DESK_TEST_OWNED_GIT_MODEL_REVISION",
    L"DESK_TEST_OWNED_GIT_MODEL_TREE",L"DESK_TEST_OWNED_GIT_MODEL_FIXTURE_SHA256"};
  char *targets[4]={nonce,revision,tree,hash}; const int sizes[4]={65,41,41,65}; unsigned i;
  for (i=0;i<4;++i) {
    DWORD length=GetEnvironmentVariableW(keys[i],value,128); unsigned j;
    if (!length || length!=(DWORD)(sizes[i]-1)) return 1;
    for (j=0;j<length;++j) if (!((value[j]>=L'0'&&value[j]<=L'9')||(value[j]>=L'a'&&value[j]<=L'f'))) return 1;
    if (!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value,-1,targets[i],sizes[i],NULL,NULL)) return 1;
  }
  n=GetCurrentDirectoryW(32768,root);
  if (!n || n>=32760 || wcscat_s(root,32768,L"\\private")) return 1;
  security_owner=(OWNER *)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(*security_owner));
  if (!security_owner || !token_user(security_owner) ||
      !sid_security(security_owner,&security,FILE_ALL_ACCESS,SUB_CONTAINERS_AND_OBJECTS_INHERIT) ||
      !CreateDirectoryW(root,&security.attributes)) goto done;
  if (swprintf_s(file,32768,L"%ls\\bootstrap.json",root)<0) goto done;
  fd=CreateFileW(file,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OVERLAPPED,NULL);
  if (!fixture_track(fd)) goto done;
  fixture.fileWrite.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(fixture.fileWrite.hEvent)) goto done;
  sprintf_s(body,sizeof(body),"{\"schema\":\"desk.owned-git-real-retention/1\",\"nonce\":\"%s\",\"sourceRevision\":\"%s\","
    "\"sourceTree\":\"%s\",\"allocationSha256\":\"e46fbabf1bc604b2531d3c3e573ea2110cbfb2282e3717ca72d68766ce6acee4\","
    "\"fixtureManifestSha256\":\"%s\",\"Hns\":\"%llu\",\"controllerPid\":1,\"controllerRetired\":true,"
    "\"unassignedRetired\":true,\"jobSealed\":true,\"activeProcesses\":0,\"queryOrigin\":\"real-win32\","
    "\"controlReaped\":true,\"criticalHandlesClosed\":true,\"complete\":true}",
    nonce,revision,tree,hash,(unsigned long long)fixture.H);
  memcpy(fixture.incoming,body,strlen(body)); SecureZeroMemory(body,sizeof(body));
  ok=WriteFile(fd,fixture.incoming,(DWORD)strlen((const char *)fixture.incoming),&n,&fixture.fileWrite);
  error=GetLastError();
  if (!ok && error==ERROR_IO_PENDING) fixture.filePending=1;
  else if (!ok) goto done;
  while (fixture.filePending && fixture_live()) {
    ok=GetOverlappedResult(fd,&fixture.fileWrite,&n,FALSE); error=GetLastError();
    if (ok || error!=ERROR_IO_INCOMPLETE) { fixture.filePending=0; if (!ok) goto done; }
    else Sleep(1);
  }
  if (fixture.filePending || n!=(DWORD)strlen((const char *)fixture.incoming) || !fixture_close(fd)) goto done;
  fd=NULL;
  fixture.cueWrite.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);
  if (!fixture_track(fixture.cueWrite.hEvent)) goto done;
  ok=WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),cue,(DWORD)(sizeof(cue)-1),&n,&fixture.cueWrite); error=GetLastError();
  if (!ok && error==ERROR_IO_PENDING) fixture.cuePending=1;
  else if (!ok) goto done;
  while (fixture.cuePending && fixture_live()) {
    ok=GetOverlappedResult(GetStdHandle(STD_OUTPUT_HANDLE),&fixture.cueWrite,&n,FALSE); error=GetLastError();
    if (ok || error!=ERROR_IO_INCOMPLETE) { fixture.cuePending=0; if (!ok) goto done; }
    else Sleep(1);
  }
  if (!fixture.cuePending && n==sizeof(cue)-1 && fixture_live()) result=0;
done:
  if (fixture.filePending) CancelIoEx(fd,&fixture.fileWrite);
  if (fixture.cuePending) CancelIoEx(GetStdHandle(STD_OUTPUT_HANDLE),&fixture.cueWrite);
  while ((fixture.filePending||fixture.cuePending) && fixture_live()) {
    if (fixture.filePending) {
      ok=GetOverlappedResult(fd,&fixture.fileWrite,&n,FALSE);
      if (ok || GetLastError()!=ERROR_IO_INCOMPLETE) fixture.filePending=0;
    }
    if (fixture.cuePending) {
      ok=GetOverlappedResult(GetStdHandle(STD_OUTPUT_HANDLE),&fixture.cueWrite,&n,FALSE);
      if (ok || GetLastError()!=ERROR_IO_INCOMPLETE) fixture.cuePending=0;
    }
    Sleep(1);
  }
  if (fixture.filePending || fixture.cuePending) ExitProcess(1);
  if (!fixture_extra_close()) result=1;
  if (security_owner) { SecureZeroMemory(security_owner,sizeof(*security_owner)); if (!HeapFree(GetProcessHeap(),0,security_owner)) result=1; }
  return result;
}
static int fixture_select_mode(void) {
  wchar_t text[64]; DWORD n=GetEnvironmentVariableW(L"DESK_TEST_OWNED_GIT_FAULT_CASE",text,64);
  static const char *modes[]={"O02","O03","O05","O06","O07","C03","C04","C05","C06","C07",
    "C09","C10","C11","C12","C13","C14","C15","C16","C17","C18"};
  unsigned i;
  if (!n || n>=64) return 0;
  for (i=0;i<sizeof(modes)/sizeof(modes[0]);++i) {
    wchar_t prefix[4]; unsigned j;
    for (j=0;j<3;++j) prefix[j]=(wchar_t)modes[i][j]; prefix[3]=0;
    if (!wcsncmp(text,prefix,3) && (!wcscmp(text+3,L"-P20-R20")||!wcscmp(text+3,L"-P22-R22")||!wcscmp(text+3,L"-P24-R24"))) {
      if (modes[i][0]=='C' && wcscmp(text+3,L"-P24-R24")) return 0;
      strcpy_s(fixture.mode,sizeof(fixture.mode),modes[i]); return 1;
    }
  }
  return 0;
}
int wmain(int argc,wchar_t **argv) {
  wchar_t *fixed[]={L"fault-owner",L"--owned-git"}; BOOL bits[5]; char body[512]; int result=1;
  if (argc!=2) return 1;
  if (!wcscmp(argv[1],L"--retention-model-bootstrap")) {
    if (!fixture_scope(1)) return 1;
    return fixture_model_bootstrap();
  }
  fixture.utilityKind=!wcscmp(argv[1],L"--result-vectors")?1:
    !wcscmp(argv[1],L"--clock-samples")?2:!wcscmp(argv[1],L"--real-io-helpers")?3:0;
  if (!fixture_scope(0) || !fixture_bridge_open()) return 1;
  if (!wcscmp(argv[1],L"--result-vectors")) {
    result=fixture_result_vectors(bits);
    sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"VECTORS\",\"bits\":[%s,%s,%s,%s,%s],"
      "\"checksPassed\":%u,\"kernelCredit\":false}",bits[0]?"true":"false",bits[1]?"true":"false",
      bits[2]?"true":"false",bits[3]?"true":"false",bits[4]?"true":"false",
      (unsigned)((bits[0]!=0)+(bits[1]!=0)+(bits[2]==0)+(bits[3]==0)+(bits[4]==0)));
    if (!fixture_emit(body)) result=1;
  } else if (!wcscmp(argv[1],L"--clock-samples")) {
    uint64_t now;
    if (!fixture_now(&now) || now>=fixture.end || fixture.end-now>1000000000ULL) return 1;
    result=fixture_clock_utility();
  } else if (!wcscmp(argv[1],L"--real-io-helpers")) {
    uint64_t now;
    if (!fixture_now(&now) || now>=fixture.end || fixture.end-now>2000000000ULL) return 1;
    result=fixture_io_utility();
  }
  else if (!wcscmp(argv[1],L"--owned-git") && fixture_select_mode()) {
    if (!strcmp(fixture.mode,"C03")) fixture_wait_deadline();
    if (!strcmp(fixture.mode,"C17")) {
      wchar_t bad[32];
      if (fixture.end>UINT64_MAX-10000000001ULL) return 1;
      if (swprintf_s(bad,32,L"%llu",(unsigned long long)(fixture.end+10000000001ULL))<0 ||
        !SetEnvironmentVariableW(L"DESK_OWNED_GIT_DEADLINE_NS",bad)) return 1;
      fixture.deadlineInputModeled=1;
    }
    {
      uint64_t now;
      if (!fixture_now(&now)) return 1;
      fixture.entryExpired=now>=fixture.end;
    }
    result=production_wmain(2,fixed);
    if (!strcmp(fixture.mode,"C03") && fixture.entryExpired && fixture_observation_cleanup_allowed())
      fixture.observationOnly=1;
    /* Tracked call counters survive S01's secure OWNER clear. This is not an
     * inference from exit and cannot manufacture missing Root/kernel facts. */
    while ((fixture.writePending||fixture.outAt<fixture.outLength) && fixture_transport_live()) { fixture_bridge_poll(); Sleep(1); }
    sprintf_s(body,sizeof(body),"{\"schema\":\"" F_EVENT "\",\"type\":\"ENTRY_RESULT\",\"creationCalls\":%lu,"
      "\"ownerFreed\":%s,\"expiredBeforeEntry\":%s,\"deadlineInputModeled\":%s,\"clockModeled\":%s,\"deadlineNs\":\"%llu\"}",
      (unsigned long)fixture.creationCalls,fixture.ownerFreed?"true":"false",fixture.entryExpired?"true":"false",
      fixture.deadlineInputModeled?"true":"false",fixture.clockModeled?"true":"false",(unsigned long long)fixture.end);
    fixture_emit(body);
  }
  if (!fixture_bridge_finish()) result=1;
  return result;
}
#endif
