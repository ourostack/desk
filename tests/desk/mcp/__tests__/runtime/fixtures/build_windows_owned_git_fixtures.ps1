# SOURCE ONLY. The host must observe this script's original process fullclose.
# Worker facts below never assert this host's future close or issue bootstrap authority.
[CmdletBinding(DefaultParameterSetName='Native')]
param(
  [Parameter(Mandatory=$true,ParameterSetName='Native')][string]$PublicMcpRoot,
  [Parameter(Mandatory=$true,ParameterSetName='Native')][string]$FixtureRoot,
  [Parameter(Mandatory=$true,ParameterSetName='Native')][string]$SourceRevision,
  [Parameter(Mandatory=$true,ParameterSetName='Native')][string]$EnvelopeDeadlineNs,
  [Parameter(Mandatory=$true,ParameterSetName='Native')][string]$GitNodeExecutable,
  [Parameter(Mandatory=$true,ParameterSetName='F0')][string]$F0RepositoryRoot,
  [Parameter(Mandatory=$true,ParameterSetName='F0')][string]$F0SourceRevision,
  [Parameter(Mandatory=$true,ParameterSetName='F0')][string]$F0NodePath,
  [Parameter(Mandatory=$true,ParameterSetName='F0')][string]$F0IntentSha256,
  [Parameter(Mandatory=$true,ParameterSetName='F0')][ValidateRange(1,300000)][int]$F0RemainingMs,
  [ValidateSet('host-build','host-coverage','build-worker','coverage-tools','f0-host','f0-worker')][string]$WorkerMode = 'host-build'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$f0 = [string]::Equals($PSCmdlet.ParameterSetName, 'F0', [StringComparison]::Ordinal)
$f0Clock = [Diagnostics.Stopwatch]::StartNew()
if ($f0) {
  if (!([string]::Equals($WorkerMode, 'f0-host', [StringComparison]::Ordinal) -or
        [string]::Equals($WorkerMode, 'f0-worker', [StringComparison]::Ordinal)) -or
      ![string]::Equals($PSVersionTable.PSEdition, 'Core', [StringComparison]::Ordinal) -or
      $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::Is64BitProcess -or
      !($F0SourceRevision -cmatch '\A[0-9a-f]{40}\z') -or !($F0IntentSha256 -cmatch '\A[0-9a-f]{64}\z')) {
    [Console]::Error.WriteLine('foundation'); exit 1
  }
  foreach ($value in @($F0RepositoryRoot, $F0NodePath)) {
    if (![IO.Path]::IsPathFullyQualified($value) -or [Text.Encoding]::UTF8.GetByteCount($value) -gt 1024 -or
        $value.IndexOfAny([char[]]@([char]0,[char]13,[char]10,[char]34)) -ge 0) {
      [Console]::Error.WriteLine('foundation'); exit 1
    }
  }
  $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..\..'))
  if (![string]::Equals($repository, $F0RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    [Console]::Error.WriteLine('foundation'); exit 1
  }
} else {
  throw 'not_admitted'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or
    ![Environment]::Is64BitProcess -or $SourceRevision -cnotmatch '^[0-9a-f]{40}$' -or
    $EnvelopeDeadlineNs -cnotmatch '^(0|[1-9][0-9]{0,19})$') { throw 'not_admitted' }
$H = [UInt64]::Parse($EnvelopeDeadlineNs, [Globalization.CultureInfo]::InvariantCulture)
if ($H -le 90000000000UL) { throw 'deadline' }
$cutoff = if ($WorkerMode -in @('host-build','build-worker')) { $H - 90000000000UL } else { $H }
$allocation = 'e46fbabf1bc604b2531d3c3e573ea2110cbfb2282e3717ca72d68766ce6acee4'
$base = '55b82d6949ddf475d122f2cd2dce5fa767d7a422'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..\..'))
$PublicMcpRoot = [IO.Path]::GetFullPath($PublicMcpRoot)
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$public = Split-Path $FixtureRoot
$stage = Split-Path $public
if ($FixtureRoot -cne (Join-Path $public 'fixtures') -or $PublicMcpRoot -cne (Join-Path $public 'mcp') -or
    (Split-Path $public -Leaf) -cne 'public' -or (Split-Path $stage -Leaf) -cne 'owned-git-product-output') { throw 'guard_failed' }
foreach ($p in @($repository, $PublicMcpRoot, $FixtureRoot, $PSCommandPath, $GitNodeExecutable)) {
  if (!$p -or $p -match '["%!\r\n&|<>^]' -or !$([IO.Path]::IsPathFullyQualified($p))) { throw 'guard_failed' }
}
}

# PowerShell Core's bundled Roslyn Add-Type implementation is used in process.
# No csc.exe, dotnet build, SDK installer, external compiler or fallback is allowed.
if (!(Test-Path -LiteralPath (Join-Path $PSHOME 'Microsoft.CodeAnalysis.CSharp.dll') -PathType Leaf)) {
  throw 'tool_missing'
}
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OwnedGitBuild {
  const uint PENDING=997, INCOMPLETE=996, ABORTED=995, BROKEN=109, NOT_FOUND=1168;
  const uint WAIT_TIMEOUT=258, CREATE_SUSPENDED=4, EXTENDED=0x80000, UNICODE_ENV=0x400;
  static readonly IntPtr INVALID=new IntPtr(-1);
  [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public uint cb; public string reserved, desktop, title; public uint x,y,xs,ys,xc,yc,fill,flags;
    public ushort show,reserved2; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr a,b,c,d; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
    public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct OV { public IntPtr a,b; public uint offset,high; public IntPtr ev; }
  [StructLayout(LayoutKind.Sequential)] struct FILEINFO {
    public uint attributes,createdLow,createdHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetHandleInformation(IntPtr h,out uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int cls,ref LIMIT data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int cls,out ACCOUNT data,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(
    string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int n,uint flags,ref UIntPtr bytes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(
    IntPtr p,uint flags,IntPtr attr,IntPtr data,UIntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipeW(
    string name,uint access,uint mode,uint instances,uint output,uint input,uint timeout,ref SA sa);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ConnectNamedPipe(IntPtr pipe,IntPtr ov);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(
    string file,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateEventW(IntPtr sa,bool manual,bool initial,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ResetEvent(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,IntPtr data,uint size,out uint n,IntPtr ov);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetOverlappedResult(IntPtr h,IntPtr ov,out uint n,bool wait);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CancelIoEx(IntPtr h,IntPtr ov);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryPerformanceCounter(out long q);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryPerformanceFrequency(out long f);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr data,uint size,out uint needed);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid,out IntPtr text);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FILEINFO info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder path,uint count,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(IntPtr file);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetModuleFileNameW(IntPtr h,StringBuilder path,uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string sddl,uint revision,out IntPtr sd,out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);

  sealed class F0Clock {
    readonly System.Diagnostics.Stopwatch watch=System.Diagnostics.Stopwatch.StartNew();
    readonly int allowance;
    long last;
    public F0Clock(int remaining) { Require(remaining>=1 && remaining<=300000); allowance=remaining; }
    public int Remaining() {
      long ticks=watch.Elapsed.Ticks;
      long elapsed=ticks/TimeSpan.TicksPerMillisecond+(ticks%TimeSpan.TicksPerMillisecond==0?0:1);
      Require(elapsed>=last && elapsed<allowance); last=elapsed;
      return checked(allowance-(int)elapsed);
    }
  }
  sealed class F0Refusal : Exception {
    public readonly string reason;
    public F0Refusal(string value) : base("catalogue") { reason=value; }
  }
  sealed class F0Buffer : MemoryStream {
    readonly int cap;
    public F0Buffer(int maximum) { cap=maximum; }
    public override void Write(byte[] bytes,int offset,int count) {
      Require(count>=0 && Position<=cap-count); base.Write(bytes,offset,count);
    }
    public override void Write(ReadOnlySpan<byte> bytes) {
      Require(Position<=cap-bytes.Length); base.Write(bytes);
    }
    public override void WriteByte(byte value) { Require(Position<cap); base.WriteByte(value); }
  }
  static Dictionary<string,object> F0Object(params object[] pairs) {
    Require(pairs.Length%2==0 && pairs.Length<=32);
    var value=new Dictionary<string,object>(StringComparer.Ordinal);
    for(int i=0;i<pairs.Length;i+=2) value.Add((string)pairs[i],pairs[i+1]);
    return value;
  }
  static readonly System.Text.Json.JsonSerializerOptions F0JsonOptions=new System.Text.Json.JsonSerializerOptions {
    Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  };
  static byte[] F0Encode(object value,int cap) {
    using(var buffer=new F0Buffer(cap)) {
      System.Text.Json.JsonSerializer.Serialize(buffer,value,F0JsonOptions);
      Require(buffer.Length>0 && buffer.Length<=cap);
      return buffer.ToArray();
    }
  }
  static object F0Version(Version value) {
    Require(value.Major>=0 && value.Major<=65535 && value.Minor>=0 && value.Minor<=65535 &&
      value.Build<=65535 && value.Revision<=65535);
    return F0Object("major",value.Major,"minor",value.Minor,"build",value.Build<0?(object)null:value.Build,
      "revision",value.Revision<0?(object)null:value.Revision);
  }
  static string F0Absolute(string value) {
    Require(!String.IsNullOrEmpty(value) && Encoding.UTF8.GetByteCount(value)<=1024 &&
      value.IndexOfAny(new[]{'\0','\r','\n','"'})<0 && value.Length>=3 && value[1]==':' && value[2]=='\\' &&
      ((value[0]>='A' && value[0]<='Z') || (value[0]>='a' && value[0]<='z')) &&
      String.Equals(Path.GetFullPath(value),value,StringComparison.OrdinalIgnoreCase));
    return value;
  }
  static string F0EnvironmentValue(string name) { return F0Absolute(Environment.GetEnvironmentVariable(name)); }
  static void F0Inputs(string root,string revision,string node,string intent) {
    Require(IntPtr.Size==8 && BitConverter.IsLittleEndian && Environment.OSVersion.Platform==PlatformID.Win32NT);
    F0Absolute(root); F0Absolute(node);
    Require(System.Text.RegularExpressions.Regex.IsMatch(revision,@"\A[0-9a-f]{40}\z") &&
      System.Text.RegularExpressions.Regex.IsMatch(intent,@"\A[0-9a-f]{64}\z") &&
      String.Equals(Path.GetFileName(node),"node.exe",StringComparison.OrdinalIgnoreCase));
  }
  static IntPtr F0Environment() {
    string systemRoot=F0EnvironmentValue("SystemRoot"),windir=F0EnvironmentValue("WINDIR");
    string drive=Environment.GetEnvironmentVariable("SystemDrive"),ps=F0EnvironmentValue("PSHOME");
    Require(String.Equals(systemRoot,windir,StringComparison.OrdinalIgnoreCase) &&
      drive!=null && drive.Length==2 && String.Equals(systemRoot.Substring(0,2),drive,StringComparison.OrdinalIgnoreCase));
    var entries=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase) {
      {"SystemRoot",systemRoot},{"WINDIR",windir},{"SystemDrive",drive},{"PSHOME",ps},
      {"PSModulePath",Path.Combine(ps,"Modules")},{"PSModuleAnalysisCachePath","NUL"},
      {"POWERSHELL_TELEMETRY_OPTOUT","1"},{"DOTNET_EnableDiagnostics","0"},
      {"F0_RUNNER_TOOL_CACHE",F0EnvironmentValue("F0_RUNNER_TOOL_CACHE")}
    };
    var block=new StringBuilder();
    Require(entries.Count==9);
    foreach(var entry in entries) {
      Require(entry.Value.IndexOf('\0')<0);
      block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
    }
    block.Append('\0'); Require(block.Length<=8192);
    return Marshal.StringToHGlobalUni(block.ToString());
  }
  static void F0Frame(object value,int cap) {
    byte[] body=F0Encode(value,cap),prefix=BitConverter.GetBytes(body.Length);
    using(Stream output=Console.OpenStandardOutput()) {
      output.Write(prefix,0,4); output.Write(body,0,body.Length); output.Flush();
    }
  }
  static void F0Json(System.Text.Json.JsonElement value,ref int tokens) {
    Require(++tokens<=16384);
    switch(value.ValueKind) {
      case System.Text.Json.JsonValueKind.Object:
        var keys=new HashSet<string>(StringComparer.Ordinal);
        foreach(var field in value.EnumerateObject()) {
          Require(keys.Count<32 && field.Name.Length<=64 && keys.Add(field.Name) &&
            field.Name!="__proto__" && field.Name!="prototype" && field.Name!="constructor");
          foreach(char c in field.Name) Require(c>=32 && c<=126);
          F0Json(field.Value,ref tokens);
        }
        break;
      case System.Text.Json.JsonValueKind.Array:
        Require(value.GetArrayLength()<=411);
        foreach(var item in value.EnumerateArray()) F0Json(item,ref tokens);
        break;
      case System.Text.Json.JsonValueKind.String:
        string text=value.GetString(); Require(text.Length<=1024);
        foreach(char c in text) Require(c>=32 && c<=126);
        break;
      case System.Text.Json.JsonValueKind.Number:
        ulong number;
        string raw=value.GetRawText();
        Require(raw.Length<=16 && System.Text.RegularExpressions.Regex.IsMatch(raw,@"\A(?:0|[1-9][0-9]*)\z") &&
          value.TryGetUInt64(out number) && number<=9007199254740991UL);
        break;
      case System.Text.Json.JsonValueKind.Null:
      case System.Text.Json.JsonValueKind.True:
      case System.Text.Json.JsonValueKind.False: break;
      default: Require(false); break;
    }
  }
  static void F0Keys(System.Text.Json.JsonElement value,params string[] names) {
    Require(value.ValueKind==System.Text.Json.JsonValueKind.Object);
    var keys=new HashSet<string>(names,StringComparer.Ordinal);
    foreach(var field in value.EnumerateObject()) Require(keys.Remove(field.Name));
    Require(keys.Count==0);
  }
  static System.Text.Json.JsonElement F0WorkerRecord(byte[] framed) {
    Require(framed.Length>=5 && framed.Length<=458756);
    int length=BitConverter.ToInt32(framed,0);
    Require(length>0 && length<=458752 && length==framed.Length-4);
    using(var document=System.Text.Json.JsonDocument.Parse(new ReadOnlyMemory<byte>(framed,4,length),
      new System.Text.Json.JsonDocumentOptions { MaxDepth=16 })) {
      var value=document.RootElement;
      int tokens=0; F0Json(value,ref tokens);
      F0Keys(value,"schema","foundation","collection","error","visited");
      Require(value.GetProperty("schema").GetString()=="na1-f0-worker/1");
      var collection=value.GetProperty("collection");
      F0Keys(collection,"basis","roots","selectors","files");
      Require(collection.GetProperty("basis").GetString()=="fixed-catalogue-only" &&
        collection.GetProperty("roots").GetArrayLength()==17 && collection.GetProperty("selectors").GetArrayLength()==22 &&
        collection.GetProperty("files").GetArrayLength()==411);
      F0Keys(value.GetProperty("error"),"code","stage","subject");
      F0Keys(value.GetProperty("visited"),"files","selectors","bytes");
      Require(value.GetProperty("visited").GetProperty("files").GetUInt32()==411 &&
        value.GetProperty("visited").GetProperty("selectors").GetUInt32()==22 &&
        value.GetProperty("visited").GetProperty("bytes").GetUInt64()<=8589934592UL);
      return value.Clone();
    }
  }
  public static void F0Host(string script,string root,string revision,string node,string intent,int remaining) {
    F0Inputs(root,revision,node,intent);
    var clock=new F0Clock(remaining);
    var owner=new Owner(); var stdout=new Pipe(); var stderr=new Pipe(); PI pi=new PI();
    IntPtr job=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero,jobs=IntPtr.Zero,env=IntPtr.Zero,sd=IntPtr.Zero;
    bool initialized=false,created=false,complete=false;
    object worker=null;
    try {
      string ps=F0EnvironmentValue("PSHOME"),image=ImagePath();
      Require(String.Equals(image,Path.Combine(ps,"pwsh.exe"),StringComparison.OrdinalIgnoreCase) &&
        String.Equals(script,Path.Combine(root,@"tests\desk\mcp\__tests__\runtime\fixtures\build_windows_owned_git_fixtures.ps1"),
          StringComparison.OrdinalIgnoreCase));
      uint size;
      string sid=TokenSid(owner);
      Require(!String.IsNullOrEmpty(sid) &&
        ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+sid+"D:P(A;;GA;;;"+sid+")",1,out sd,out size));
      stdout.Create(owner,sd); stderr.Create(owner,sd);
      job=owner.Keep(CreateJobObjectW(IntPtr.Zero,null));
      var limit=new LIMIT(); limit.basic.flags=0x2000|8|0x100|0x200; limit.basic.active=4;
      limit.a=new UIntPtr(1073741824UL); limit.b=new UIntPtr(2147483648UL);
      Require(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf<LIMIT>()));
      var sa=new SA { size=Marshal.SizeOf<SA>(),inherit=1 };
      IntPtr nul=owner.Keep(CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero),true);
      UIntPtr bytes=UIntPtr.Zero;
      Require(!InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes) &&
        (uint)Marshal.GetLastWin32Error()==122 && bytes.ToUInt64()>0 && bytes.ToUInt64()<=65536);
      attrs=Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
      Require(InitializeProcThreadAttributeList(attrs,2,0,ref bytes)); initialized=true;
      handles=Marshal.AllocHGlobal(3*IntPtr.Size);
      Marshal.WriteIntPtr(handles,0,nul); Marshal.WriteIntPtr(handles,IntPtr.Size,stdout.client);
      Marshal.WriteIntPtr(handles,2*IntPtr.Size,stderr.client);
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new UIntPtr((uint)(3*IntPtr.Size)),IntPtr.Zero,IntPtr.Zero) &&
        UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000d),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var startup=new SIX(); startup.si.cb=(uint)Marshal.SizeOf<SIX>(); startup.si.flags=0x100;
      startup.si.input=nul; startup.si.output=stdout.client; startup.si.error=stderr.client; startup.attributes=attrs;
      env=F0Environment();
      string command=Argument(image)+" -NoLogo -NoProfile -NonInteractive -File "+Argument(script)+
        " -WorkerMode f0-worker -F0RepositoryRoot "+Argument(root)+" -F0SourceRevision "+revision+
        " -F0NodePath "+Argument(node)+" -F0IntentSha256 "+intent+
        " -F0RemainingMs "+clock.Remaining().ToString(System.Globalization.CultureInfo.InvariantCulture);
      Require(command.Length<=8192 && owner.handles.Count<=62 &&
        CreateProcessW(image,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,
          CREATE_SUSPENDED|EXTENDED|UNICODE_ENV,env,root,ref startup,out pi));
      created=true;
      owner.handles.Add(pi.process); owner.handles.Add(pi.thread);
      bool member; uint processFlags,threadFlags;
      Require(pi.process!=IntPtr.Zero && pi.thread!=IntPtr.Zero &&
        SetHandleInformation(pi.process,1,0) && SetHandleInformation(pi.thread,1,0) &&
        GetHandleInformation(pi.process,out processFlags) && (processFlags&1)==0 &&
        GetHandleInformation(pi.thread,out threadFlags) && (threadFlags&1)==0 &&
        IsProcessInJob(pi.process,job,out member) && member);
      clock.Remaining(); Require(ResumeThread(pi.thread)==1);
      owner.Close(stdout.client); stdout.client=IntPtr.Zero;
      owner.Close(stderr.client); stderr.client=IntPtr.Zero; owner.Close(nul);
      long outputBytes=0,errorBytes=0;
      using(var capture=new F0Buffer(458756)) {
        while(true) {
          clock.Remaining();
          stdout.Poll(ref outputBytes,capture,458756); stderr.Poll(ref errorBytes,null,4096);
          uint waited=WaitForSingleObject(pi.process,0);
          Require(waited==0 || waited==WAIT_TIMEOUT);
          ACCOUNT accounting;
          Require(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf<ACCOUNT>(),IntPtr.Zero));
          if(waited==0 && stdout.eof && stderr.eof && accounting.active==0) {
            uint code; Require(GetExitCodeProcess(pi.process,out code) && code==0);
            Require(!stdout.pending && !stderr.pending);
            worker=F0WorkerRecord(capture.ToArray()); complete=true; break;
          }
          Thread.Sleep(1);
        }
      }
      clock.Remaining();
      Require(!stdout.pending && !stderr.pending);
      stdout.Free(); stderr.Free();
      DeleteProcThreadAttributeList(attrs); initialized=false;
      Marshal.FreeHGlobal(attrs); attrs=IntPtr.Zero;
      Marshal.FreeHGlobal(handles); handles=IntPtr.Zero;
      Marshal.FreeHGlobal(jobs); jobs=IntPtr.Zero;
      Marshal.FreeHGlobal(env); env=IntPtr.Zero;
      Require(LocalFree(sd)==IntPtr.Zero); sd=IntPtr.Zero;
      owner.CloseAll(); Require(owner.closed);
      clock.Remaining();
      F0Frame(F0Object("schema","na1-f0-host/1","worker",worker,"completion",F0Object(
        "workerExit",0,"workerExitObserved",true,"workerStdoutEOF",true,"workerStderrEOF",true,
        "jobActive",0,"ioReaped",true,"criticalHandlesClosed",true,"ownership","closed")),524288);
    } catch {
      // Kernel-referenced storage is deliberately not freed on an unknown join.
      if(created && job!=IntPtr.Zero) TerminateJobObject(job,91);
      Environment.Exit(1);
    }
    Require(complete && !initialized && attrs==IntPtr.Zero && handles==IntPtr.Zero && jobs==IntPtr.Zero && env==IntPtr.Zero);
  }
  sealed class F0SelectorSpec {
    public string id,root,type;
    public string[] parts;
    public int limit;
  }
  sealed class F0FileSpec {
    public string id,root,kind,selector;
    public string[] parts;
    public int rank,insertAt;
  }
  static readonly string[] F0VS={"v22c","v22e","v22p","v22b","v18c","v18e","v18p","v18b"};
  static readonly string[] F0Roots={"repo","os","ps","rtc","n24","g64","g32",
    "v22c","v22e","v22p","v22b","v18c","v18e","v18p","v18b","sdk","vsdb"};
  static void F0File(List<F0FileSpec> files,string id,string root,string parts,string kind,
    string selector=null,int rank=0,int insertAt=0) {
    files.Add(new F0FileSpec { id=id,root=root,parts=parts.Split('/'),kind=kind,selector=selector,rank=rank,insertAt=insertAt });
  }
  static void F0Catalogue(out List<F0SelectorSpec> selectors,out List<F0FileSpec> files) {
    selectors=new List<F0SelectorSpec>(); files=new List<F0FileSpec>();
    F0File(files,"node20","rtc","node/20.0.0/x64/node.exe","pe");
    F0File(files,"node22","rtc","node/22.23.3/x64/node.exe","pe"); F0File(files,"node24","n24","node.exe","pe");
    string[] psIds={"pwsh","sma","roslyn","utility"};
    string[] psNames={"pwsh.exe","System.Management.Automation.dll","Microsoft.CodeAnalysis.CSharp.dll","Microsoft.PowerShell.Commands.Utility.dll"};
    for(int i=0;i<4;i++) F0File(files,"ps."+psIds[i],"ps",psNames[i],"pe");
    foreach(string r in new[]{"os","ps"}) {
      string prefix=r=="os"?"System32/WindowsPowerShell/v1.0/":"";
      F0File(files,"la."+r+".manifest",r,prefix+"Modules/Microsoft.PowerShell.LocalAccounts/Microsoft.PowerShell.LocalAccounts.psd1","manifest");
      F0File(files,"la."+r+".assembly",r,prefix+"Modules/Microsoft.PowerShell.LocalAccounts/Microsoft.PowerShell.LocalAccounts.dll","pe");
    }
    string[] gitIds={"command","direct","sh","env","msys","gitconfig","fstab","userfstab","packages","release","bash","mintty"};
    string[] gitPaths={"cmd/git.exe","mingw64/bin/git.exe","usr/bin/sh.exe","usr/bin/env.exe","usr/bin/msys-2.0.dll",
      "etc/gitconfig","etc/fstab","etc/fstab.d/deskstd","etc/package-versions.txt","etc/git-for-windows-extra-release-notes.md","bin/bash.exe","usr/bin/mintty.exe"};
    for(int g=0;g<2;g++) for(int i=0;i<12;i++) F0File(files,"git."+new[]{"g64","g32"}[g]+"."+gitIds[i],
      new[]{"g64","g32"}[g],gitPaths[i],i>=5&&i<=7?"config":i==8||i==9?"metadata":"pe");
    foreach(string g in new[]{"g64","g32"}) foreach(string dir in new[]{"mingw","usr"}) {
      string q="git."+g+"."+dir,p=dir=="mingw"?"mingw64/bin":"usr/bin";
      selectors.Add(new F0SelectorSpec { id=q,root=g,parts=p.Split('/'),type="git",limit=16 });
      for(int rank=1;rank<=16;rank++) F0File(files,"dll."+g+"."+dir+"."+rank.ToString("D2"),g,p,"pe",q,rank,2);
    }
    foreach(string v in F0VS) selectors.Add(new F0SelectorSpec { id="llvm."+v,root=v,
      parts="VC/Tools/Llvm/x64/lib/clang".Split('/'),type="llvm",limit=8 });
    foreach(string v in F0VS) selectors.Add(new F0SelectorSpec { id="msvc."+v,root=v,
      parts="VC/Tools/MSVC".Split('/'),type="msvc",limit=8 });
    selectors.Add(new F0SelectorSpec { id="sdk.lib",root="sdk",parts=new[]{"Lib"},type="sdk",limit=8 });
    selectors.Add(new F0SelectorSpec { id="vs.instances",root="vsdb",parts=Array.Empty<string>(),type="instance",limit=16 });
    string[] vsIds={"clang","lld","readobj","profdata","cov","devcmd","toolversion","devenv"};
    string[] vsPaths={"VC/Tools/Llvm/x64/bin/clang-cl.exe","VC/Tools/Llvm/x64/bin/lld-link.exe",
      "VC/Tools/Llvm/x64/bin/llvm-readobj.exe","VC/Tools/Llvm/x64/bin/llvm-profdata.exe","VC/Tools/Llvm/x64/bin/llvm-cov.exe",
      "Common7/Tools/VsDevCmd.bat","VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt","Common7/IDE/devenv.exe"};
    foreach(string v in F0VS) for(int i=0;i<8;i++) F0File(files,"vs."+v+"."+vsIds[i],v,vsPaths[i],i==5?"script":i==6?"metadata":"pe");
    foreach(string v in F0VS) for(int rank=1;rank<=8;rank++) F0File(files,"profile."+v+"."+rank.ToString("D2"),v,
      "VC/Tools/Llvm/x64/lib/clang/lib/windows/clang_rt.profile-x86_64.lib","library","llvm."+v,rank,6);
    foreach(string v in F0VS) for(int rank=1;rank<=8;rank++) foreach(string k in new[]{"cmt","vcruntime"})
      F0File(files,"crt."+v+"."+rank.ToString("D2")+"."+k,v,"VC/Tools/MSVC/lib/x64/"+(k=="cmt"?"libcmt.lib":"libvcruntime.lib"),
        "library","msvc."+v,rank,3);
    for(int rank=1;rank<=8;rank++) foreach(string k in new[]{"ucrt","kernel","advapi"})
      F0File(files,"sdk."+rank.ToString("D2")+"."+k,"sdk","Lib/"+(k=="ucrt"?"ucrt/x64/libucrt.lib":
        k=="kernel"?"um/x64/kernel32.lib":"um/x64/advapi32.lib"),"library","sdk.lib",rank,1);
    for(int rank=1;rank<=16;rank++) foreach(string k in new[]{"state","catalog"})
      F0File(files,"instance."+rank.ToString("D2")+"."+k,"vsdb",k+".json","metadata","vs.instances",rank,0);
    Require(F0Roots.Length==17 && selectors.Count==22 && files.Count==411);
  }
  static uint F0Attributes(string path) {
    uint attributes=GetFileAttributesW(path);
    if(attributes==UInt32.MaxValue) {
      int code=Marshal.GetLastWin32Error();
      throw new F0Refusal(code==2||code==3?"missing":code==5||code==32?"access":"io");
    }
    return attributes;
  }
  static string F0Final(IntPtr handle) {
    var value=new StringBuilder(2048);
    uint count=GetFinalPathNameByHandleW(handle,value,2048,0);
    if(count==0 || count>=2048) throw new F0Refusal("io");
    string path=value.ToString();
    if(path.StartsWith(@"\\?\",StringComparison.Ordinal)) path=path.Substring(4);
    return path;
  }
  static List<KeyValuePair<string,string>> F0Directories(string directory,F0Clock clock) {
    F0Absolute(directory);
    var guards=new List<KeyValuePair<string,string>>();
    string current=Path.GetPathRoot(directory);
    var components=directory.Substring(current.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries);
    for(int i=-1;i<components.Length;i++) {
      clock.Remaining(); if(i>=0) current=Path.Combine(current,components[i]);
      uint attributes=F0Attributes(current);
      if((attributes&0x400)!=0) throw new F0Refusal("reparse");
      if((attributes&0x10)==0) throw new F0Refusal("not-regular");
      guards.Add(new KeyValuePair<string,string>(current,DirectoryIdentity(current)));
    }
    return guards;
  }
  static void F0Recheck(List<KeyValuePair<string,string>> guards,F0Clock clock) {
    foreach(var guard in guards) {
      clock.Remaining();
      uint attributes=F0Attributes(guard.Key);
      if((attributes&0x400)!=0) throw new F0Refusal("reparse");
      if((attributes&0x10)==0 || DirectoryIdentity(guard.Key)!=guard.Value) throw new F0Refusal("changed");
    }
  }
  static Dictionary<string,object> F0Root(string id,string path,F0Clock clock) {
    if(String.IsNullOrEmpty(path)) return F0Object("id",id,"state","error","reason","io");
    try { F0Absolute(path); }
    catch(InvalidOperationException) { return F0Object("id",id,"state","refused","reason","outside-root"); }
    try {
      var guards=F0Directories(path,clock); F0Recheck(guards,clock);
      return F0Object("id",id,"state","present","reason","none");
    } catch(F0Refusal failure) {
      string state=failure.reason=="missing"?"missing":failure.reason=="access"||failure.reason=="io"||failure.reason=="changed"?"error":"refused";
      return F0Object("id",id,"state",state,"reason",failure.reason);
    } catch(UnauthorizedAccessException) { return F0Object("id",id,"state","error","reason","access"); }
      catch(IOException) { return F0Object("id",id,"state","error","reason","io"); }
  }
  static string F0Path(string root,string[] parts) {
    string value=root; foreach(string part in parts) value=Path.Combine(value,part);
    string canonical=Path.GetFullPath(value);
    if(!String.Equals(canonical,root,StringComparison.OrdinalIgnoreCase) &&
      !canonical.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) throw new F0Refusal("outside-root");
    return canonical;
  }
  static string F0NamePattern(string type) {
    switch(type) {
      case "git": return @"\A[A-Za-z0-9._+-]{1,124}\.[dD][lL][lL]\z";
      case "llvm": return @"\A[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}\z";
      case "msvc": return @"\A[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,6}\z";
      case "sdk": return @"\A[0-9]{1,3}(?:\.[0-9]{1,6}){2,3}\z";
      case "instance": return @"\A[A-Za-z0-9_-]{1,64}\z";
      default: throw new InvalidOperationException("schema");
    }
  }
  static Dictionary<string,object> F0Select(F0SelectorSpec spec,string root,string rootState,F0Clock clock) {
    if(rootState!="present") return F0Object("id",spec.id,"state",rootState=="missing"?"parent-missing":"not-collected",
      "names",Array.Empty<string>(),"reason",rootState=="missing"?"parent-missing":"not-started");
    try {
      string directory=F0Path(root,spec.parts);
      var guards=F0Directories(directory,clock); var names=new List<string>();
      var unique=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var options=new EnumerationOptions { RecurseSubdirectories=false,IgnoreInaccessible=false,
        ReturnSpecialDirectories=false,AttributesToSkip=0,BufferSize=4096,MatchType=MatchType.Simple };
      using(var entries=Directory.EnumerateFileSystemEntries(directory,"*",options).GetEnumerator()) {
        while(true) {
          clock.Remaining(); if(!entries.MoveNext()) break;
          string path=entries.Current,name=Path.GetFileName(path); uint attr=F0Attributes(path);
          bool isDirectory=(attr&0x10)!=0,isReparse=(attr&0x400)!=0;
          bool named=System.Text.RegularExpressions.Regex.IsMatch(name,F0NamePattern(spec.type));
          if(spec.type=="git" ? !name.EndsWith(".dll",StringComparison.OrdinalIgnoreCase) : !isDirectory && !isReparse && !named) continue;
          if(isReparse) throw new F0Refusal("reparse");
          if(spec.type=="git"?isDirectory:!isDirectory) throw new F0Refusal("not-regular");
          if(name.Length>128 || !named) throw new F0Refusal("unsupported-name");
          if(!unique.Add(name)) throw new F0Refusal("ambiguous-case");
          if(names.Count>=spec.limit) return F0Object("id",spec.id,"state","over-limit","names",Array.Empty<string>(),"reason","count-cap");
          names.Add(name);
        }
      }
      F0Recheck(guards,clock); names.Sort(StringComparer.Ordinal);
      var row=F0Object("id",spec.id,"state","listed","names",names.ToArray(),"reason","none");
      // Enforce F0-M1 on the actual emitted selector, before any ranked file is resolved.
      if(F0Encode(row,4096).Length>2048) return F0Object("id",spec.id,"state","over-limit","names",Array.Empty<string>(),"reason","count-cap");
      return row;
    } catch(F0Refusal failure) {
      string state=failure.reason=="missing"?"parent-missing":
        failure.reason=="access"||failure.reason=="io"||failure.reason=="changed"?"unreadable":"unsupported-name";
      return F0Object("id",spec.id,"state",state,"names",Array.Empty<string>(),
        "reason",failure.reason=="missing"?"parent-missing":failure.reason);
    } catch(UnauthorizedAccessException) { return F0Object("id",spec.id,"state","unreadable","names",Array.Empty<string>(),"reason","access"); }
      catch(IOException) { return F0Object("id",spec.id,"state","unreadable","names",Array.Empty<string>(),"reason","io"); }
  }
  static Dictionary<string,object> F0FileRow(F0FileSpec spec,object locator,string state,string reason,object bytes=null,string hash=null) {
    var row=F0Object("id",spec.id,"locator",locator,"state",state,"kind",spec.kind,"bytes",bytes,"sha256",hash,"reason",reason);
    F0Encode(row,768); return row;
  }
  static Dictionary<string,object> F0Read(F0FileSpec spec,string root,string rootState,
    Dictionary<string,Dictionary<string,object>> selected,F0Clock clock,ref ulong total) {
    if(rootState!="present") return F0FileRow(spec,null,rootState=="missing"?"parent-missing":"not-collected",
      rootState=="missing"?"parent-missing":"not-started");
    var parts=new List<string>(spec.parts);
    if(spec.selector!=null) {
      var selector=selected[spec.selector]; string state=(string)selector["state"];
      if(state!="listed") return F0FileRow(spec,null,state=="parent-missing"?"parent-missing":"not-collected",
        state=="parent-missing"?"parent-missing":"not-started");
      var names=(string[])selector["names"];
      if(spec.rank>names.Length) return F0FileRow(spec,null,"slot-empty","slot-empty");
      parts.Insert(spec.insertAt,names[spec.rank-1]);
    }
    Require(parts.Count>=1 && parts.Count<=12 && String.Join("/",parts).Length<=256);
    var locator=F0Object("root",spec.root,"parts",parts.ToArray());
    IntPtr file=IntPtr.Zero;
    try {
      string path=F0Path(root,parts.ToArray());
      var guards=F0Directories(Path.GetDirectoryName(path),clock);
      uint attributes=F0Attributes(path);
      if((attributes&0x400)!=0) throw new F0Refusal("reparse");
      if((attributes&0x10)!=0) throw new F0Refusal("not-regular");
      var sa=new SA { size=Marshal.SizeOf<SA>() };
      file=CreateFileW(path,0x80000000,1,ref sa,3,0x08200000,IntPtr.Zero);
      if(file==IntPtr.Zero || file==INVALID) {
        file=IntPtr.Zero; int error=Marshal.GetLastWin32Error();
        throw new F0Refusal(error==2||error==3?"missing":error==5||error==32?"access":"io");
      }
      uint flags; FILEINFO before,after;
      Require(SetHandleInformation(file,1,0) && GetHandleInformation(file,out flags) && (flags&1)==0);
      if(GetFileType(file)!=1) throw new F0Refusal("not-regular");
      if(!GetFileInformationByHandle(file,out before)) throw new F0Refusal("io");
      if((before.attributes&0x400)!=0) throw new F0Refusal("reparse");
      if((before.attributes&0x10)!=0) throw new F0Refusal("not-regular");
      if(!String.Equals(F0Final(file),path,StringComparison.OrdinalIgnoreCase)) throw new F0Refusal("outside-root");
      ulong size=((ulong)before.sizeHigh<<32)|before.sizeLow;
      if(size>536870912UL || total>8589934592UL-size) return F0FileRow(spec,locator,"too-large",
        size>536870912UL?"file-cap":"aggregate-cap",size<=9007199254740991UL?(object)size:null);
      string hash;
      using(var safe=new Microsoft.Win32.SafeHandles.SafeFileHandle(file,false))
      using(var stream=new FileStream(safe,FileAccess.Read,65536,false))
      using(var digest=System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256)) {
        byte[] buffer=new byte[65536]; ulong read=0;
        while(read<size) {
          clock.Remaining(); int count=stream.Read(buffer,0,(int)Math.Min(65536UL,size-read));
          if(count<=0) throw new F0Refusal("changed");
          read+=(ulong)count; total+=(ulong)count;
          Require(total<=8589934592UL); digest.AppendData(buffer,0,count);
        }
        clock.Remaining();
        hash=Convert.ToHexString(digest.GetHashAndReset()).ToLowerInvariant();
        if(!GetFileInformationByHandle(file,out after) || before.volume!=after.volume ||
          before.indexHigh!=after.indexHigh || before.indexLow!=after.indexLow ||
          before.sizeHigh!=after.sizeHigh || before.sizeLow!=after.sizeLow ||
          before.writeHigh!=after.writeHigh || before.writeLow!=after.writeLow ||
          (after.attributes&(0x400u|0x10u))!=0) throw new F0Refusal("changed");
        if(Identity(path)!=OpenIdentity(safe)) throw new F0Refusal("changed");
        F0Recheck(guards,clock);
      }
      return F0FileRow(spec,locator,"present","none",size,hash);
    } catch(F0Refusal failure) {
      string state=failure.reason=="missing"?"missing":
        failure.reason=="access"||failure.reason=="io"||failure.reason=="changed"?"unreadable":"refused";
      return F0FileRow(spec,locator,state,failure.reason);
    } catch(UnauthorizedAccessException) { return F0FileRow(spec,locator,"unreadable","access"); }
      catch(IOException) { return F0FileRow(spec,locator,"unreadable","io"); }
    finally { if(file!=IntPtr.Zero) Require(CloseHandle(file)); }
  }
  static string F0KnownJoin(string root,params string[] parts) {
    if(String.IsNullOrEmpty(root)) return null;
    string value=root; foreach(string part in parts) value=Path.Combine(value,part);
    return value;
  }
  public static void F0Worker(string root,string revision,string node,string intent,int remaining,int psMajor,int psMinor,int psPatch) {
    try {
      F0Inputs(root,revision,node,intent); RequireJobMembership();
      var clock=new F0Clock(remaining);
      string pf=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles,Environment.SpecialFolderOption.DoNotVerify);
      string pfx=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86,Environment.SpecialFolderOption.DoNotVerify);
      string common=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData,Environment.SpecialFolderOption.DoNotVerify);
      var paths=new Dictionary<string,string>(StringComparer.Ordinal) {
        {"repo",root},{"os",F0EnvironmentValue("SystemRoot")},{"ps",F0EnvironmentValue("PSHOME")},
        {"rtc",F0EnvironmentValue("F0_RUNNER_TOOL_CACHE")},{"n24",Path.GetDirectoryName(node)},
        {"g64",F0KnownJoin(pf,"Git")},{"g32",F0KnownJoin(pfx,"Git")},{"sdk",F0KnownJoin(pfx,@"Windows Kits\10")},
        {"vsdb",F0KnownJoin(common,@"Microsoft\VisualStudio\Packages\_Instances")}
      };
      string[] editions={"Community","Enterprise","Professional","BuildTools"};
      for(int i=0;i<8;i++) paths.Add(F0VS[i],F0KnownJoin(pf,"Microsoft Visual Studio",i<4?"2022":"18",editions[i%4]));
      List<F0SelectorSpec> selectors; List<F0FileSpec> files; F0Catalogue(out selectors,out files);
      var roots=new List<Dictionary<string,object>>();
      var rootStates=new Dictionary<string,string>(StringComparer.Ordinal);
      foreach(string id in F0Roots) { var row=F0Root(id,paths[id],clock); roots.Add(row); rootStates.Add(id,(string)row["state"]); }
      foreach(string id in new[]{"repo","os","ps","rtc","n24"}) Require(rootStates[id]=="present");
      var selected=new Dictionary<string,Dictionary<string,object>>(StringComparer.Ordinal);
      var selectorRows=new List<Dictionary<string,object>>();
      foreach(var spec in selectors) {
        var row=F0Select(spec,paths[spec.root],rootStates[spec.root],clock); selected.Add(spec.id,row); selectorRows.Add(row);
      }
      ulong total=0; var fileRows=new List<Dictionary<string,object>>();
      foreach(var spec in files) fileRows.Add(F0Read(spec,paths[spec.root],rootStates[spec.root],selected,clock,ref total));
      foreach(string id in new[]{"node24","ps.pwsh","ps.sma","ps.roslyn","ps.utility"})
        Require((string)fileRows.Find(row=>(string)row["id"]==id)["state"]=="present");
      var nodeRow=fileRows.Find(row=>(string)row["id"]=="node24");
      Require((string)nodeRow["sha256"]=="9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de");
      string failed=null;
      foreach(var row in roots) if(failed==null && (string)row["state"]!="present" && (string)row["state"]!="missing") failed=(string)row["id"];
      foreach(var row in selectorRows) if(failed==null && (string)row["state"]!="listed" && (string)row["state"]!="parent-missing") failed=(string)row["id"];
      foreach(var row in fileRows) if(failed==null && (string)row["state"]!="present" && (string)row["state"]!="missing" &&
        (string)row["state"]!="parent-missing" && (string)row["state"]!="slot-empty") failed=(string)row["id"];
      var foundation=F0Object("node",F0Object("version","24.18.0","sha256",nodeRow["sha256"]),
        "powershell",F0Object("edition","Core","version",F0Version(new Version(psMajor,psMinor,psPatch))),
        "dotnet",F0Object("version",F0Version(Environment.Version)),
        "os",F0Object("platform","win32","version",F0Version(Environment.OSVersion.Version)),
        "scope","R0-R1-bootstrap-assumed");
      clock.Remaining();
      F0Frame(F0Object("schema","na1-f0-worker/1","foundation",foundation,"collection",F0Object("basis","fixed-catalogue-only",
        "roots",roots,"selectors",selectorRows,"files",fileRows),
        "error",F0Object("code",failed==null?"none":"catalogue","stage",failed==null?"none":"collect","subject",failed),
        "visited",F0Object("files",fileRows.Count,"selectors",selectorRows.Count,"bytes",total)),458752);
    } catch { Environment.Exit(1); }
  }

  public sealed class Facts {
    public string schema="desk.owned-git-infrastructure-worker/1", role, Hns, sourceRevision, deadlineNs, finishedNs;
    public bool workerExitObserved,workerRetired,workerStdoutEOF,workerStderrEOF,realJobSealed,controlReaped,criticalHandlesClosed;
    public uint? realActiveProcesses;
    public uint workerExitCode;
    public string gap="none";
  }
  static void Require(bool good) { if(!good) throw new InvalidOperationException("owned_build_failed"); }
  public static string ImagePath() {
    var b=new StringBuilder(32768); uint n=GetModuleFileNameW(IntPtr.Zero,b,32768);
    Require(n>0 && n<32768); return b.ToString();
  }
  sealed class Clock {
    long frequency,last; bool failed;
    public ulong Now() {
      long q,f;
      if(failed || !QueryPerformanceCounter(out q) || !QueryPerformanceFrequency(out f) ||
        q<=0 || f<=0 || (frequency!=0 && frequency!=f) || (last!=0 && q<last)) {
        failed=true; throw new InvalidOperationException("clock_mismatch");
      }
      frequency=f; last=q;
      double scale=(double)f/1000000000.0;
      double n=(double)((ulong)q+1)/scale;
      Require(n>=0 && n<18446744073709551616.0);
      return checked((ulong)n);
    }
  }
  static readonly Clock commandClock=new Clock();
  public static ulong Nanoseconds() { return commandClock.Now(); }
  public static void RequireJobMembership() {
    bool member; Require(IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out member) && member);
  }
  public static void CheckJson(byte[] bytes) {
    Require(bytes.Length<=8388608);
    new UTF8Encoding(false,true).GetString(bytes);
    using(var document=System.Text.Json.JsonDocument.Parse(bytes,new System.Text.Json.JsonDocumentOptions { MaxDepth=16 })) {
      int entries=0; CheckElement(document.RootElement,ref entries);
    }
  }
  static void CheckElement(System.Text.Json.JsonElement value,ref int entries) {
    Require(++entries<=8192);
    if(value.ValueKind==System.Text.Json.JsonValueKind.Object) {
      var names=new HashSet<string>(StringComparer.Ordinal);
      foreach(var field in value.EnumerateObject()) {
        Require(names.Add(field.Name) && field.Name.IndexOf('\0')<0);
        CheckElement(field.Value,ref entries);
      }
    } else if(value.ValueKind==System.Text.Json.JsonValueKind.Array) {
      foreach(var item in value.EnumerateArray()) CheckElement(item,ref entries);
    } else if(value.ValueKind==System.Text.Json.JsonValueKind.String) {
      Require(value.GetString().IndexOf('\0')<0);
    }
  }
  sealed class Owner {
    public readonly List<IntPtr> handles=new List<IntPtr>();
    public bool closed=true;
    public IntPtr Keep(IntPtr h,bool inherited=false) {
      Require(h!=IntPtr.Zero && h!=INVALID);
      if(handles.Count>=64) { CloseHandle(h); throw new InvalidOperationException("quota"); }
      handles.Add(h);
      uint flags;
      Require(inherited ? GetHandleInformation(h,out flags) && (flags&1)!=0 :
        SetHandleInformation(h,1,0) && GetHandleInformation(h,out flags) && (flags&1)==0);
      return h;
    }
    public void Close(IntPtr h) {
      int at=handles.IndexOf(h); Require(at>=0);
      if(CloseHandle(h)) handles[at]=IntPtr.Zero;
      else { closed=false; throw new InvalidOperationException("owned_build_close"); }
    }
    public void CloseAll() {
      for(int i=handles.Count-1;i>=0;i--) if(handles[i]!=IntPtr.Zero) {
        if(!CloseHandle(handles[i])) closed=false; else handles[i]=IntPtr.Zero;
      }
    }
  }
  sealed class Pipe {
    public IntPtr server,client,ev,ov,data;
    public bool pending,eof;
    public void Create(Owner owner,IntPtr sd) {
      var sa=new SA { size=Marshal.SizeOf<SA>(),descriptor=sd,inherit=0 };
      string name=@"\\.\pipe\desk-owned-git-build-"+Guid.NewGuid().ToString("N");
      server=owner.Keep(CreateNamedPipeW(name,0x40080001,8,1,65536,65536,0,ref sa));
      ev=owner.Keep(CreateEventW(IntPtr.Zero,true,false,null));
      ov=Marshal.AllocHGlobal(Marshal.SizeOf<OV>());
      Marshal.StructureToPtr(new OV { ev=ev },ov,false);
      data=Marshal.AllocHGlobal(65536);
      sa.inherit=1;
      client=owner.Keep(CreateFileW(name,0x40000000,0,ref sa,3,0,IntPtr.Zero),true);
      if(!ConnectNamedPipe(server,ov)) {
        uint error=(uint)Marshal.GetLastWin32Error();
        if(error==PENDING) pending=true; // Failure unwind must reap even an unexpected pending connect.
        Require(error==535);
      }
    }
    public long observedBytes;
    public void Poll(ref long bytes,MemoryStream capture=null,int limit=1048576) {
      if(eof) return;
      uint n; bool ok;
      if(pending) {
        ok=GetOverlappedResult(server,ov,out n,false);
        uint error=(uint)Marshal.GetLastWin32Error();
        if(!ok && error==INCOMPLETE) return;
        pending=false;
        if(!ok) { Require(error==BROKEN || error==233); eof=true; return; }
      } else {
        Require(ResetEvent(ev));
        ok=ReadFile(server,data,65536,out n,ov);
        uint error=(uint)Marshal.GetLastWin32Error();
        if(!ok && error==PENDING) { pending=true; return; }
        if(!ok) { Require(error==BROKEN || error==233); eof=true; return; }
      }
      if(n==0) eof=true;
      else {
        Require(n<=65536); observedBytes+=n; bytes+=n; Require(bytes<=limit);
        if(capture!=null) {
          byte[] copy=new byte[65536];
          Marshal.Copy(data,copy,0,checked((int)n)); capture.Write(copy,0,checked((int)n));
        }
      }
    }
    public bool CancelAndReap(Clock clock,ulong cutoff) {
      if(!pending) return true;
      if(!CancelIoEx(server,ov) && (uint)Marshal.GetLastWin32Error()!=NOT_FOUND) return false;
      while(clock.Now()<cutoff) {
        uint n;
        if(GetOverlappedResult(server,ov,out n,false)) { pending=false; return true; }
        uint error=(uint)Marshal.GetLastWin32Error();
        if(error==ABORTED || error==BROKEN || error==233) { pending=false; return true; }
        if(error!=INCOMPLETE) return false;
        Thread.Sleep(1);
      }
      return false; // Cancellation is not EOF.
    }
    public void Free() {
      Require(!pending);
      if(data!=IntPtr.Zero) { Marshal.FreeHGlobal(data); data=IntPtr.Zero; }
      if(ov!=IntPtr.Zero) { Marshal.FreeHGlobal(ov); ov=IntPtr.Zero; }
    }
  }
  static string Quote(string v) {
    Require(!String.IsNullOrEmpty(v) && Path.IsPathFullyQualified(v) && v.IndexOfAny(new[]{'"','\r','\n','\0'})<0);
    return "\""+v+"\"";
  }
  static IntPtr EnvironmentBlock(string H) {
    var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach(string k in new[]{"SystemRoot","WINDIR","SystemDrive","COMSPEC","PATH","PATHEXT","TEMP","TMP",
      "ProgramFiles","ProgramFiles(x86)","ProgramW6432","USERPROFILE","APPDATA","LOCALAPPDATA"}) {
      string v=Environment.GetEnvironmentVariable(k);
      if(v!=null) { Require(v.IndexOf('\0')<0); env[k]=v; }
    }
    // The closed Node launcher does not forward these installed-tool inputs.
    string programFiles=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
    string programFilesX86=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
    Require(Path.IsPathFullyQualified(programFiles) && Path.IsPathFullyQualified(programFilesX86));
    env["ProgramFiles"]=programFiles; env["ProgramW6432"]=programFiles;
    env["ProgramFiles(x86)"]=programFilesX86;
    env["DESK_TEST_OWNED_GIT_H"]=H;
    var b=new StringBuilder();
    foreach(var pair in env) b.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
    b.Append('\0'); Require(b.Length<32768);
    return Marshal.StringToHGlobalUni(b.ToString());
  }
  static string TokenSid(Owner owner) {
    IntPtr token,info=IntPtr.Zero,text=IntPtr.Zero; uint needed;
    Require(OpenProcessToken(GetCurrentProcess(),8,out token)); owner.Keep(token);
    try {
      Require(!GetTokenInformation(token,1,IntPtr.Zero,0,out needed) &&
        (uint)Marshal.GetLastWin32Error()==122 && needed>0 && needed<=65536);
      info=Marshal.AllocHGlobal(checked((int)needed));
      Require(GetTokenInformation(token,1,info,needed,out needed) &&
        ConvertSidToStringSidW(Marshal.ReadIntPtr(info),out text));
      return Marshal.PtrToStringUni(text);
    } finally {
      if(text!=IntPtr.Zero && LocalFree(text)!=IntPtr.Zero) owner.closed=false;
      if(info!=IntPtr.Zero) Marshal.FreeHGlobal(info);
      owner.Close(token);
    }
  }
  public static string Identity(string file) {
    var sa=new SA {size=Marshal.SizeOf<SA>()};
    IntPtr h=CreateFileW(file,0x80,7,ref sa,3,0x200000,IntPtr.Zero);
    Require(h!=IntPtr.Zero && h!=INVALID);
    try {
      uint flags; FILEINFO i=new FILEINFO();
      Require(SetHandleInformation(h,1,0) && GetHandleInformation(h,out flags) && (flags&1)==0 &&
        GetFileInformationByHandle(h,out i) && (i.attributes&(0x400u|0x10u))==0);
      return i.volume+":"+i.indexHigh+":"+i.indexLow+":"+i.sizeHigh+":"+i.sizeLow+":"+i.writeHigh+":"+i.writeLow;
    } finally { Require(CloseHandle(h)); }
  }
  public static string DirectoryIdentity(string directory) {
    var sa=new SA {size=Marshal.SizeOf<SA>()};
    IntPtr h=CreateFileW(directory,0x80,7,ref sa,3,0x02200000,IntPtr.Zero);
    Require(h!=IntPtr.Zero && h!=INVALID);
    try {
      uint flags; FILEINFO i=new FILEINFO();
      Require(SetHandleInformation(h,1,0) && GetHandleInformation(h,out flags) && (flags&1)==0 &&
        GetFileInformationByHandle(h,out i) && (i.attributes&0x10u)!=0 && (i.attributes&0x400u)==0);
      return i.volume+":"+i.indexHigh+":"+i.indexLow+":"+i.sizeHigh+":"+i.sizeLow+":"+i.writeHigh+":"+i.writeLow;
    } finally { Require(CloseHandle(h)); }
  }
  public static string OpenIdentity(Microsoft.Win32.SafeHandles.SafeFileHandle handle) {
    FILEINFO i;
    Require(GetFileInformationByHandle(handle.DangerousGetHandle(),out i) && (i.attributes&(0x400u|0x10u))==0);
    string value=i.volume+":"+i.indexHigh+":"+i.indexLow+":"+i.sizeHigh+":"+i.sizeLow+":"+i.writeHigh+":"+i.writeLow;
    GC.KeepAlive(handle); return value;
  }
  public static Facts Run(string script,string mode,string publicRoot,string fixtures,string revision,ulong H,string gitNode) {
    Require(false);
    Require(IntPtr.Size==8 && (mode=="build-worker" || mode=="coverage-tools") &&
      System.Text.RegularExpressions.Regex.IsMatch(revision,"^[0-9a-f]{40}$") &&
      Path.GetFileName(script)=="build_windows_owned_git_fixtures.ps1");
    string image=ImagePath(); Require(Path.GetFileName(image).Equals("pwsh.exe",StringComparison.OrdinalIgnoreCase));
    var clock=new Clock(); ulong start=clock.Now();
    Require(H>90000000000UL && H>start && H-start<=120000000000UL);
    ulong cutoff=mode=="build-worker" ? H-90000000000UL : H;
    Require(start<cutoff);
    var owner=new Owner(); var stdout=new Pipe(); var stderr=new Pipe(); PI pi=new PI();
    var facts=new Facts { role=mode=="build-worker"?"build":"coverage-tools",Hns=H.ToString(),
      sourceRevision=revision,deadlineNs=cutoff.ToString() };
    IntPtr job=IntPtr.Zero,attrs=IntPtr.Zero,list=IntPtr.Zero,env=IntPtr.Zero,sd=IntPtr.Zero,nul=IntPtr.Zero;
    bool initialized=false,created=false,assigned=false,complete=false;
    try {
      uint size;
      string sid=TokenSid(owner);
      Require(!String.IsNullOrEmpty(sid) &&
        ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+sid+"D:P(A;;GA;;;"+sid+")",1,out sd,out size));
      stdout.Create(owner,sd); stderr.Create(owner,sd);
      job=owner.Keep(CreateJobObjectW(IntPtr.Zero,null));
      var limit=new LIMIT(); limit.basic.flags=0x2000|8|0x100|0x200; limit.basic.active=256;
      limit.a=new UIntPtr(1073741824UL); limit.b=new UIntPtr(2147483648UL);
      Require(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf<LIMIT>()));
      var sa=new SA {size=Marshal.SizeOf<SA>(),inherit=1};
      nul=owner.Keep(CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero),true);
      UIntPtr bytes=UIntPtr.Zero;
      Require(!InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes) &&
        (uint)Marshal.GetLastWin32Error()==122 && bytes.ToUInt64()>0 && bytes.ToUInt64()<=65536);
      attrs=Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
      Require(InitializeProcThreadAttributeList(attrs,1,0,ref bytes)); initialized=true;
      list=Marshal.AllocHGlobal(3*IntPtr.Size);
      Marshal.WriteIntPtr(list,0,nul); Marshal.WriteIntPtr(list,IntPtr.Size,stdout.client); Marshal.WriteIntPtr(list,2*IntPtr.Size,stderr.client);
      Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),list,new UIntPtr((uint)(3*IntPtr.Size)),IntPtr.Zero,IntPtr.Zero));
      var startup=new SIX(); startup.si.cb=(uint)Marshal.SizeOf<SIX>(); startup.si.flags=0x100;
      startup.si.input=nul; startup.si.output=stdout.client; startup.si.error=stderr.client; startup.attributes=attrs;
      env=EnvironmentBlock(H.ToString());
      string command=Quote(image)+" -NoProfile -NonInteractive -File "+Quote(script)+
        " -PublicMcpRoot "+Quote(publicRoot)+" -FixtureRoot "+Quote(fixtures)+" -SourceRevision "+revision+
        " -EnvelopeDeadlineNs "+H+" -WorkerMode "+mode+" -GitNodeExecutable "+Quote(gitNode);
      Require(clock.Now()<cutoff && owner.handles.Count<=62 && CreateProcessW(image,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,
        CREATE_SUSPENDED|EXTENDED|UNICODE_ENV,env,Path.GetDirectoryName(script),ref startup,out pi));
      created=true;
      // Record both returned handles before checking either one's flags.
      owner.handles.Add(pi.process); owner.handles.Add(pi.thread);
      uint pflags,tflags;
      Require(SetHandleInformation(pi.process,1,0) && SetHandleInformation(pi.thread,1,0) &&
        GetHandleInformation(pi.process,out pflags) && GetHandleInformation(pi.thread,out tflags) &&
        (pflags&1)==0 && (tflags&1)==0 && clock.Now()<cutoff && AssignProcessToJobObject(job,pi.process));
      assigned=true; Require(clock.Now()<cutoff && ResumeThread(pi.thread)==1);
      owner.Close(stdout.client); stdout.client=IntPtr.Zero;
      owner.Close(stderr.client); stderr.client=IntPtr.Zero;
      owner.Close(nul); nul=IntPtr.Zero;
      long diagnosticBytes=0;
      while(clock.Now()<cutoff) {
        stdout.Poll(ref diagnosticBytes); stderr.Poll(ref diagnosticBytes);
        uint waited=WaitForSingleObject(pi.process,0);
        Require(waited==0 || waited==WAIT_TIMEOUT);
        if(waited==0) {
          uint code; Require(GetExitCodeProcess(pi.process,out code));
          facts.workerExitObserved=true; facts.workerRetired=true; facts.workerExitCode=code;
          if(!facts.realJobSealed) { Require(TerminateJobObject(job,91)); facts.realJobSealed=true; }
        }
        ACCOUNT accounting;
        Require(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf<ACCOUNT>(),IntPtr.Zero));
        if(facts.realJobSealed && accounting.active==0) facts.realActiveProcesses=0;
        if(facts.workerRetired && facts.realActiveProcesses==0 && stdout.eof && stderr.eof) {
          facts.workerStdoutEOF=true; facts.workerStderrEOF=true; complete=true; break;
        }
        Thread.Sleep(1);
      }
      Require(complete && facts.workerExitCode==0);
    } finally {
      bool retired=!created,reaped=false;
      try {
        if(created && !assigned && WaitForSingleObject(pi.process,0)!=0) Require(TerminateProcess(pi.process,90));
        if(job!=IntPtr.Zero && !facts.realJobSealed && TerminateJobObject(job,91)) facts.realJobSealed=true;
        while(clock.Now()<cutoff && created) {
          uint waited=WaitForSingleObject(pi.process,0); ACCOUNT accounting;
          if(waited==0 && job!=IntPtr.Zero &&
            QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf<ACCOUNT>(),IntPtr.Zero) && accounting.active==0) {
            retired=true; break;
          }
          if(waited!=0 && waited!=WAIT_TIMEOUT) break;
          Thread.Sleep(1);
        }
        reaped=stdout.CancelAndReap(clock,cutoff) && stderr.CancelAndReap(clock,cutoff);
      } catch {
        Environment.FailFast("owned_build_cleanup_unknown");
      }
      if(!reaped) Environment.FailFast("owned_build_io_unreaped"); // Never free kernel-referenced storage.
      if(created && !retired) Environment.FailFast("owned_build_worker_unretired");
      facts.controlReaped=true;
      if(initialized) DeleteProcThreadAttributeList(attrs);
      if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
      if(sd!=IntPtr.Zero && LocalFree(sd)!=IntPtr.Zero) owner.closed=false;
      stdout.Free(); stderr.Free();
      owner.CloseAll(); facts.criticalHandlesClosed=owner.closed;
      Require(retired && reaped && owner.closed && clock.Now()<cutoff);
    }
    facts.finishedNs=clock.Now().ToString();
    Require(complete && facts.realActiveProcesses==0 && facts.workerStdoutEOF && facts.workerStderrEOF);
    return facts;
  }
  static string Argument(string value) {
    Require(value!=null && value.IndexOfAny(new[]{'\0','\r','\n'})<0);
    var output=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') { output.Append('\\',slashes*2+1).Append(c); slashes=0; continue; }
      output.Append('\\',slashes).Append(c); slashes=0;
    }
    output.Append('\\',slashes*2).Append('"'); return output.ToString();
  }
  // These fixed tools inherit the already-owned worker's nonbreakaway job.
  // Retain creation-returned handles; no Process.Kill/HasExited/PID reopening.
  static IntPtr ToolEnvironment(string[] entries) {
    Require(entries!=null && entries.Length>0 && entries.Length<=40);
    var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach(string entry in entries) {
      Require(entry!=null && entry.IndexOf('\0')<0);
      int at=entry.IndexOf('=');
      Require(at>0 && at<=256);
      string key=entry.Substring(0,at);
      Require(!values.ContainsKey(key)); values.Add(key,entry.Substring(at+1));
    }
    var block=new StringBuilder();
    foreach(var pair in values) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
    // StringToHGlobalUni appends one further NUL to the already terminated block.
    block.Append('\0'); Require(block.Length<32768);
    return Marshal.StringToHGlobalUni(block.ToString());
  }
  public static byte[] Tool(string image,string[] args,string cwd,ulong cutoff,bool capture,int limit,bool requireEmptyStderr=false,string[] environment=null) {
    Require(limit==1048576 || limit==8388608);
    RequireJobMembership();
    var clock=new Clock(); Require(clock.Now()<cutoff);
    var owner=new Owner(); var stdout=new Pipe(); var stderr=new Pipe(); PI pi=new PI();
    IntPtr sd=IntPtr.Zero,attrs=IntPtr.Zero,list=IntPtr.Zero,nul=IntPtr.Zero,toolEnv=IntPtr.Zero;
    bool created=false,initialized=false,joined=false;
    using(var output=new MemoryStream()) {
      try {
        uint size;
        string sid=TokenSid(owner);
        Require(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+sid+"D:P(A;;GA;;;"+sid+")",1,out sd,out size));
        stdout.Create(owner,sd); stderr.Create(owner,sd);
        var sa=new SA {size=Marshal.SizeOf<SA>(),inherit=1};
        nul=owner.Keep(CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero),true);
        UIntPtr count=UIntPtr.Zero;
        Require(!InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref count) &&
          (uint)Marshal.GetLastWin32Error()==122 && count.ToUInt64()>0 && count.ToUInt64()<=65536);
        attrs=Marshal.AllocHGlobal(checked((int)count.ToUInt64()));
        Require(InitializeProcThreadAttributeList(attrs,1,0,ref count)); initialized=true;
        list=Marshal.AllocHGlobal(3*IntPtr.Size);
        Marshal.WriteIntPtr(list,0,nul); Marshal.WriteIntPtr(list,IntPtr.Size,stdout.client); Marshal.WriteIntPtr(list,2*IntPtr.Size,stderr.client);
        Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),list,new UIntPtr((uint)(3*IntPtr.Size)),IntPtr.Zero,IntPtr.Zero));
        var startup=new SIX(); startup.si.cb=(uint)Marshal.SizeOf<SIX>(); startup.si.flags=0x100;
        startup.si.input=nul; startup.si.output=stdout.client; startup.si.error=stderr.client; startup.attributes=attrs;
        string command=Quote(image);
        if(Path.GetFileName(image).Equals("cmd.exe",StringComparison.OrdinalIgnoreCase)) {
          Require(args.Length==4 && args[0]=="/d" && args[1]=="/s" && args[2]=="/c" &&
            args[3].IndexOfAny(new[]{'\0','\r','\n'})<0);
          command+=" /d /s /c \""+args[3]+"\""; // cmd's own /s quote grammar, not a CRT argv parser.
        } else foreach(string arg in args) command+=" "+Argument(arg);
        if(environment!=null) toolEnv=ToolEnvironment(environment);
        Require(clock.Now()<cutoff && owner.handles.Count<=62 &&
          CreateProcessW(image,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,
            CREATE_SUSPENDED|EXTENDED|(toolEnv!=IntPtr.Zero?UNICODE_ENV:0),toolEnv,cwd,ref startup,out pi));
        created=true; owner.handles.Add(pi.process); owner.handles.Add(pi.thread);
        uint pflags,tflags; bool member;
        Require(SetHandleInformation(pi.process,1,0) && SetHandleInformation(pi.thread,1,0) &&
          GetHandleInformation(pi.process,out pflags) && GetHandleInformation(pi.thread,out tflags) &&
          (pflags&1)==0 && (tflags&1)==0 &&
          IsProcessInJob(pi.process,IntPtr.Zero,out member) && member &&
          clock.Now()<cutoff && ResumeThread(pi.thread)==1);
        owner.Close(stdout.client); stdout.client=IntPtr.Zero;
        owner.Close(stderr.client); stderr.client=IntPtr.Zero;
        owner.Close(nul); nul=IntPtr.Zero;
        long total=0;
        while(clock.Now()<cutoff) {
          stdout.Poll(ref total,capture?output:null,limit); stderr.Poll(ref total,null,limit);
          uint waited=WaitForSingleObject(pi.process,0);
          Require(waited==0 || waited==WAIT_TIMEOUT);
          if(waited==0 && stdout.eof && stderr.eof) {
            uint code; Require(GetExitCodeProcess(pi.process,out code)); joined=true;
            Require(code==0 && (!requireEmptyStderr || stderr.observedBytes==0)); return output.ToArray();
          }
          Thread.Sleep(1);
        }
        throw new InvalidOperationException("deadline");
      } finally {
        try {
          if(created && !joined) {
            uint waited=WaitForSingleObject(pi.process,0);
            if(waited!=0) Require(waited==WAIT_TIMEOUT && TerminateProcess(pi.process,90));
            while(clock.Now()<cutoff) {
              if(WaitForSingleObject(pi.process,0)==0) { joined=true; break; }
              Thread.Sleep(1);
            }
          }
          if(created && !joined) Environment.FailFast("owned_build_tool_unjoined");
          if(!stdout.CancelAndReap(clock,cutoff) || !stderr.CancelAndReap(clock,cutoff))
            Environment.FailFast("owned_build_tool_io_unreaped");
        } catch {
          Environment.FailFast("owned_build_tool_cleanup_unknown");
        }
        if(initialized) DeleteProcThreadAttributeList(attrs);
        if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
        if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
        if(toolEnv!=IntPtr.Zero) Marshal.FreeHGlobal(toolEnv);
        if(sd!=IntPtr.Zero && LocalFree(sd)!=IntPtr.Zero) owner.closed=false;
        stdout.Free(); stderr.Free(); owner.CloseAll();
        Require(owner.closed && clock.Now()<cutoff);
      }
    }
  }
}
'@
} catch {
  [Console]::Error.WriteLine('foundation')
  exit 1
}
if ($f0) {
  try {
    $remaining = $F0RemainingMs - [int][Math]::Ceiling($f0Clock.Elapsed.TotalMilliseconds)
    if ($remaining -lt 1 -or $remaining -gt 300000) { throw 'foundation' }
    if ([string]::Equals($WorkerMode, 'f0-host', [StringComparison]::Ordinal)) {
      [OwnedGitBuild]::F0Host($PSCommandPath, $F0RepositoryRoot, $F0SourceRevision, $F0NodePath, $F0IntentSha256, $remaining)
    } else {
      [OwnedGitBuild]::F0Worker($F0RepositoryRoot, $F0SourceRevision, $F0NodePath, $F0IntentSha256, $remaining,
        $PSVersionTable.PSVersion.Major, $PSVersionTable.PSVersion.Minor, $PSVersionTable.PSVersion.Patch)
    }
    exit 0
  } catch {
    [Console]::Error.WriteLine('foundation')
    exit 1
  }
}

$sourcePaths = @(
  'plugins/desk/mcp/native/windows-owned-git.c',
  'plugins/desk/mcp/scripts/owned-git-child.cjs',
  'plugins/desk/mcp/scripts/build-owned-git.ps1',
  'plugins/desk/mcp/scripts/verify-owned-git.js',
  '.github/workflows/desk-windows-suite.yml',
  '.github/scripts/run-as-standard-user.ps1',
  '.github/scripts/run-suite-files.mjs',
  '.github/scripts/owned-git-product-io.mjs',
  'tests/desk/mcp/__tests__/runtime/windows_owned_git.test.js',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_driver.cjs',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_fault_root.cjs',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_fault_owner.c',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_supervisor.c',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_retention.cjs',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_workload.cjs',
  'tests/desk/mcp/__tests__/runtime/fixtures/windows_owned_git_preload.cjs',
  'tests/desk/mcp/__tests__/runtime/fixtures/build_windows_owned_git_fixtures.ps1'
)
$frozen = @(
  '05a68645f6b744ea6f76b685f973e1e0b727453ea23c7255fad9a23c1cf85122',
  '855f39ce6092a85c2285a6d45adc5403a0f772722bae496ec70d0a52e5093d38',
  'd8fa94904c58b245c342a98ca99dd2443e932b276c47cd0e3dcaaf2bd134ea37',
  '7fe7ac7b0dad4e6f379a7e7c8f546a765e64ceae36a6b262d7afd42856a09fc5'
)
$sourceNames = @('s01-production-owner.c','s02-production-root.cjs','s03-production-builder.ps1','s04-production-verifier.js',
  's05-windows-workflow.yml','s06-standard-user.ps1','s07-suite-runner.mjs','s08-product-io.mjs','s09-product-test.js',
  's10-driver.cjs','s11-test-root.cjs','s12-fault-owner.c','s13-supervisor.c','s14-retention.cjs','s15-workload.cjs',
  's16-preload.cjs','s17-fixture-builder.ps1')
$binaryNames = @('production-owner.exe','production-owner-instrumented.exe','fault-owner.exe',
  'fault-owner-instrumented.exe','retained-supervisor.exe')
$variantNames = @('wrong-pid-delay.cjs','malformed.cjs','replay-result.cjs','trailing.cjs','partial-header.cjs',
  'partial-body.cjs','oversized.cjs','eof-before-result.cjs','pressure.cjs','normal.cjs','clock-companion.cjs')
function Deadline {
  if ([OwnedGitBuild]::Nanoseconds() -ge $cutoff) { throw 'deadline' }
}
function Hash([string]$File) {
  Deadline
  Guard $File $false
  $before = [OwnedGitBuild]::Identity($File)
  $hash = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([OwnedGitBuild]::Identity($File) -cne $before) { throw 'identity_changed' }
  Deadline
  return $hash
}
function Guard([string]$File,[bool]$Directory) {
  Deadline
  $full = [IO.Path]::GetFullPath($File)
  if ($full -cne $File -or $full -notmatch '^[A-Za-z]:\\' -or $full -match '~|["%!*?\r\n&|<>^]') { throw 'guard_failed' }
  $current = [IO.Path]::GetPathRoot($full)
  $segments = $full.Substring($current.Length).Split('\',[StringSplitOptions]::RemoveEmptyEntries)
  if ($segments.Length -gt 64) { throw 'quota' }
  for ($index=0; $index -lt $segments.Length; $index++) {
    # Exact-pattern Dirent lookup returns the long primary name, never an 8.3
    # spelling supplied by a resolver. Alias matches must not become fallback.
    $found = $null; $entries = 0
    $iterator = [IO.Directory]::EnumerateFileSystemEntries($current,$segments[$index]).GetEnumerator()
    try {
      while ($iterator.MoveNext()) {
        if (++$entries -gt 1) { throw 'guard_failed' }
        $candidate = $iterator.Current
        if (![StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFileName($candidate),$segments[$index])) { throw 'guard_failed' }
        $found = $candidate
      }
    } finally { $iterator.Dispose() }
    if (!$found) { throw 'guard_failed' }
    $item = Get-Item -LiteralPath $found -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($index -lt ($segments.Length - 1) -and !$item.PSIsContainer)) { throw 'guard_failed' }
    $current = $found
  }
  if ((Get-Item -LiteralPath $current -Force).PSIsContainer -ne $Directory) { throw 'guard_failed' }
}
function RequireEmpty([string]$Directory) {
  $iterator = [IO.Directory]::EnumerateFileSystemEntries($Directory).GetEnumerator()
  try { if ($iterator.MoveNext()) { throw 'namespace_not_fresh' } } finally { $iterator.Dispose() }
}
function CopyExact([string]$Source,[string]$Destination) {
  Guard $Source $false
  Guard (Split-Path $Destination) $true
  if (Test-Path -LiteralPath $Destination) { throw 'namespace_not_fresh' }
  $identity = [OwnedGitBuild]::Identity($Source)
  $expected = Hash $Source
  [IO.File]::Copy($Source,$Destination,$false)
  if ([OwnedGitBuild]::Identity($Source) -cne $identity -or (Hash $Source) -cne $expected -or
      (Hash $Destination) -cne $expected) { throw 'identity_changed' }
  Deadline
}
function ReadPublicJson([string]$File) {
  $bytes = ReadBounded $File 65536
  [OwnedGitBuild]::CheckJson($bytes)
  return ($utf8.GetString($bytes) | ConvertFrom-Json -AsHashtable -Depth 16)
}
function ReadBounded([string]$File,[int]$Limit) {
  Guard $File $false
  $identity = [OwnedGitBuild]::Identity($File)
  $length = (Get-Item -LiteralPath $File).Length
  if ($length -lt 1 -or $length -gt $Limit) { throw 'quota' }
  $bytes = [byte[]]::new([int]$length)
  $stream = [IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    if ([OwnedGitBuild]::OpenIdentity($stream.SafeFileHandle) -cne $identity) { throw 'identity_changed' }
    $offset = 0
    while ($offset -lt $length) {
      Deadline
      $read = $stream.Read($bytes,$offset,([int]$length - $offset))
      if ($read -le 0) { throw 'identity_changed' }
      $offset += $read
    }
    if ($stream.ReadByte() -ne -1 -or [OwnedGitBuild]::OpenIdentity($stream.SafeFileHandle) -cne $identity -or
        [OwnedGitBuild]::Identity($File) -cne $identity) { throw 'identity_changed' }
  } finally { $stream.Dispose() }
  Deadline
  return ,$bytes
}
function WriteJson([string]$File,$Value,[int]$Limit=65536) {
  Deadline
  Guard (Split-Path $File) $true
  $bytes = $utf8.GetBytes(($Value | ConvertTo-Json -Depth 16 -Compress) + "`n")
  if ($Limit -lt 1 -or $Limit -gt 65536 -or $bytes.Length -gt $Limit) { throw 'quota' }
  $stream = [IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Deadline
}
function Tool([string]$Image,[string[]]$Arguments,[bool]$Capture=$false,[int]$Limit=1048576,[bool]$RequireEmptyStderr=$false,[string[]]$Environment=$null) {
  return ,([OwnedGitBuild]::Tool($Image,$Arguments,$repository,$cutoff,$Capture,$Limit,$RequireEmptyStderr,$Environment))
}
function ToolText([string]$Image,[string[]]$Arguments) {
  $bytes = Tool $Image $Arguments $true
  $utf8.GetString($bytes)
}
function InstalledTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  Guard $vswhere $false
  $installation = (ToolText $vswhere @('-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath')).Trim()
  Guard $installation $true
  $bin = Join-Path $installation 'VC\Tools\Llvm\x64\bin'
  $tools = @{ compiler=(Join-Path $bin 'clang-cl.exe'); profdata=(Join-Path $bin 'llvm-profdata.exe')
    cov=(Join-Path $bin 'llvm-cov.exe'); devcmd=(Join-Path $installation 'Common7\Tools\VsDevCmd.bat')
    cmd=(Join-Path $env:SystemRoot 'System32\cmd.exe') }
  foreach ($file in $tools.Values) { Guard $file $false }
  return $tools
}
function ScanBinary([string]$File) {
  $bytes = ReadBounded $File 4194304
  # Decode both encodings for literal path-prefix rejection, never export text.
  $ascii = [Text.Encoding]::Latin1.GetString($bytes).ToLowerInvariant()
  $unicodeUtf8 = ([Text.UTF8Encoding]::new($false,$false)).GetString($bytes).ToLowerInvariant()
  $wide = [Text.Encoding]::Unicode.GetString($bytes).ToLowerInvariant()
  $wideOdd = [Text.Encoding]::Unicode.GetString($bytes,1,($bytes.Length - 1)).ToLowerInvariant()
  foreach ($prefix in @($repository,$stage,(Join-Path $stage 'private'),$PublicMcpRoot,$FixtureRoot)) {
    foreach ($spelling in @($prefix,$prefix.Replace('\','/'))) {
      $needle = $spelling.ToLowerInvariant()
      if ($ascii.Contains($needle) -or $unicodeUtf8.Contains($needle) -or $wide.Contains($needle) -or
          $wideOdd.Contains($needle)) { throw 'guard_failed' }
    }
  }
}
function ValidateBuilt {
  $sourceFile = Join-Path $FixtureRoot 'source-assets.json'
  $fixtureFile = Join-Path $FixtureRoot 'fixture-assets.json'
  $sourceManifest = ReadPublicJson $sourceFile
  $fixtureManifest = ReadPublicJson $fixtureFile
  $productionFile = Join-Path $PublicMcpRoot 'artifacts\owned-git\win32-x64\manifest.json'
  $production = ReadPublicJson $productionFile
  if ($sourceManifest.schema -cne 'desk.owned-git-sources/1' -or $sourceManifest.sourceRevision -cne $SourceRevision -or
      $sourceManifest.sourceTree -cnotmatch '^[0-9a-f]{40}$' -or $sourceManifest.allocationSha256 -cne $allocation -or
      $sourceManifest.sources.Count -ne 17 -or $fixtureManifest.schema -cne 'desk.owned-git-fixtures/1' -or
      $fixtureManifest.sourceRevision -cne $SourceRevision -or $fixtureManifest.sourceTree -cne $sourceManifest.sourceTree -or
      $fixtureManifest.allocationSha256 -cne $allocation -or $fixtureManifest.binaries.Count -ne 5 -or
      $fixtureManifest.roots.Count -ne 11 -or (Hash $sourceFile) -cne $fixtureManifest.sourceManifestSha256 -or
      (Hash $productionFile) -cne $fixtureManifest.productionManifestSha256) { throw 'source_mismatch' }
  $export = Join-Path $stage 'export'
  for ($i=0; $i -lt 17; $i++) {
    $row = $sourceManifest.sources[$i]
    if ($row.key -cne ('S{0:d2}' -f ($i+1)) -or $row.repositoryPath -cne $sourcePaths[$i] -or
        ($i -lt 4 -and $row.sha256 -cne $frozen[$i]) -or
        (Hash (Join-Path $repository $sourcePaths[$i])) -cne $row.sha256 -or
        (Hash (Join-Path $export ('sources\' + $sourceNames[$i]))) -cne $row.sha256) { throw 'source_mismatch' }
  }
  for ($i=0; $i -lt 5; $i++) {
    $image = Join-Path $FixtureRoot $binaryNames[$i]
    $copy = Join-Path $export ('binaries\' + $binaryNames[$i])
    ScanBinary $image; ScanBinary $copy
    if ($fixtureManifest.binaries[$i].key -cne $binaryNames[$i] -or
        (Hash $image) -cne $fixtureManifest.binaries[$i].sha256 -or
        (Hash $copy) -cne $fixtureManifest.binaries[$i].sha256) { throw 'source_mismatch' }
  }
  for ($i=0; $i -lt 11; $i++) {
    if ($fixtureManifest.roots[$i].basename -cne $variantNames[$i] -or
        (Hash (Join-Path $public ('test-roots\' + $variantNames[$i]))) -cne $sourceManifest.sources[10].sha256) { throw 'source_mismatch' }
  }
  if ((Hash (Join-Path $PublicMcpRoot 'artifacts\owned-git\win32-x64\desk-owned-git.exe')) -cne
        $fixtureManifest.binaries[0].sha256 -or $production.files.owner.sha256 -cne $fixtureManifest.binaries[0].sha256 -or
      (Hash (Join-Path $PublicMcpRoot 'artifacts\owned-git\win32-x64\owned-git-child.cjs')) -cne $frozen[1] -or
      $production.files.shim.sha256 -cne $frozen[1]) { throw 'source_mismatch' }
  if ((Hash (Join-Path $export 'shim\owned-git-child.cjs')) -cne $frozen[1] -or
      (Hash (Join-Path $export 'manifests\production-assets.json')) -cne (Hash $productionFile) -or
      (Hash (Join-Path $export 'manifests\fixture-assets.json')) -cne (Hash $fixtureFile) -or
      (Hash (Join-Path $export 'manifests\source-assets.json')) -cne (Hash $sourceFile)) { throw 'source_mismatch' }
}
function GitAttributes([string]$File) {
  Deadline
  try { return [IO.File]::GetAttributes($File) } catch {
    $errorValue = $_.Exception
    while ($null -ne $errorValue.InnerException) { $errorValue = $errorValue.InnerException }
    if ($errorValue -is [IO.FileNotFoundException] -or $errorValue -is [IO.DirectoryNotFoundException]) { return $null }
    throw
  }
}
function GitEmpty([string]$Directory) {
  Guard $Directory $true
  $iterator = [IO.Directory]::EnumerateFileSystemEntries($Directory).GetEnumerator()
  try { Deadline; if ($iterator.MoveNext()) { throw 'guard_failed' } } finally { $iterator.Dispose() }
}
function GitCanonical([string]$File,[bool]$Directory=$false) {
  if (!$File -or $File -cnotmatch '^[A-Za-z]:\\' -or $File.Substring(2).Contains(':') -or
      $File -match '[\x00\r\n;"''!$`*?=]' -or [IO.Path]::GetFullPath($File) -cne $File -or
      ($Directory -and $utf8.GetByteCount($File) -gt 241)) { throw 'guard_failed' }
}
function GitMount($Policy) {
  $file = Join-Path $Policy.home 'etc\fstab'
  $attributes = GitAttributes $file
  if ($null -eq $attributes) { return @{ sha256=$null;prefix='/cygdrive';identity=$null } }
  Guard $file $false
  $before = [OwnedGitBuild]::Identity($file)
  $length = (Get-Item -LiteralPath $file).Length
  if ($length -gt 4096) { throw 'quota' }
  [byte[]]$bytes = @()
  if ($length -ne 0) { $bytes = ReadBounded $file 4096 }
  foreach ($b in $bytes) { if ($b -eq 0 -or $b -gt 127) { throw 'guard_failed' } }
  $text = [Text.Encoding]::ASCII.GetString($bytes).Replace("`r`n","`n")
  if ($text.Contains("`r")) { throw 'guard_failed' }
  $record = $false
  foreach ($line in $text.Split([char]10)) {
    if (!$line.Trim() -or $line.TrimStart().StartsWith('#')) { continue }
    if ($record -or $line -cne 'none / cygdrive binary,posix=0,noacl,user 0 0') { throw 'guard_failed' }
    $record = $true
  }
  $digest = Hash $file
  if ([OwnedGitBuild]::Identity($file) -cne $before) { throw 'identity_changed' }
  return @{sha256=$digest;prefix=$(if($record){'/'}else{'/cygdrive'});identity=$before}
}
function GitPolicy {
  $installationRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Git'
  $git = Join-Path $installationRoot 'mingw64\bin\git.exe'
  $shell = Join-Path $installationRoot 'usr\bin\sh.exe'
  $envImage = Join-Path $installationRoot 'usr\bin\env.exe'
  $msys = Join-Path $installationRoot 'usr\bin\msys-2.0.dll'
  $exec = Join-Path $FixtureRoot 'na1-exec-empty'
  $directories = @($exec,(Split-Path $GitNodeExecutable),(Split-Path $shell),(Split-Path $git),
    (Join-Path $env:SystemRoot 'System32'))
  foreach ($dir in $directories) { GitCanonical $dir $true; Guard $dir $true }
  if (@($directories | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique).Count -ne 5) { throw 'guard_failed' }
  foreach ($dir in @($exec,$directories[1],$directories[4])) {
    if ($dir.Equals($installationRoot,[StringComparison]::OrdinalIgnoreCase) -or
        $dir.StartsWith($installationRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'guard_failed' }
  }
  $hashes = @{}
  foreach ($file in @($git,$shell,$envImage,$msys,$GitNodeExecutable)) {
    GitCanonical $file; Guard $file $false
    if ((Get-Item -LiteralPath $file).Length -gt 536870912) { throw 'quota' }
    $hashes[$file] = Hash $file
  }
  if ($hashes[$GitNodeExecutable] -cne '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de') { throw 'runtime_mismatch' }
  $policy = @{home=$installationRoot;git=$git;shell=$shell;envImage=$envImage;msys=$msys;exec=$exec
    directories=$directories;hashes=$hashes;snapshot=$null}
  $policy.mount = GitMount $policy
  return $policy
}
function InspectGitPolicy($Policy) {
  $rows = [Collections.Generic.List[string]]::new()
  foreach ($dir in $Policy.directories) {
    Deadline; Guard $dir $true
    $rows.Add($dir+'='+[OwnedGitBuild]::DirectoryIdentity($dir))
  }
  GitEmpty $Policy.exec
  foreach ($dir in $Policy.directories) {
    foreach ($base in @('git-owned','sh','env','node','git','busybox')) {
      $suffixes = if ($base -ceq 'busybox') { @('.exe') } else { @('','.exe','.lnk','.exe.lnk') }
      foreach ($suffix in $suffixes) {
        $file = Join-Path $dir ($base+$suffix)
        $required = $file -in @($Policy.git,$Policy.shell,$Policy.envImage,$GitNodeExecutable)
        $attr = GitAttributes $file
        if (!$required) { if ($null -ne $attr) { throw 'guard_failed' }; continue }
        if ($null -eq $attr) { throw 'guard_failed' }
        Guard $file $false
        if ((Hash $file) -cne $Policy.hashes[$file]) { throw 'identity_changed' }
        $rows.Add($file+'='+[OwnedGitBuild]::Identity($file))
      }
    }
  }
  $mount = GitMount $Policy
  if ($mount.sha256 -cne $Policy.mount.sha256 -or $mount.prefix -cne $Policy.mount.prefix -or
      $mount.identity -cne $Policy.mount.identity) { throw 'identity_changed' }
  $user = Join-Path $Policy.home 'etc\fstab.d'
  if ($null -ne (GitAttributes $user)) { GitEmpty $user; $rows.Add($user+'='+[OwnedGitBuild]::DirectoryIdentity($user)) }
  if ((Hash $Policy.msys) -cne $Policy.hashes[$Policy.msys]) { throw 'identity_changed' }
  $rows.Add($Policy.msys+'='+[OwnedGitBuild]::Identity($Policy.msys))
  Deadline
  return [string]::Join("`n",$rows)
}
function GitEnvironment($Policy) {
  $values = @{}
  foreach ($key in @('SystemRoot','WINDIR','SystemDrive','COMSPEC','PATHEXT','TEMP','TMP',
      'ProgramFiles','ProgramFiles(x86)','ProgramW6432','USERPROFILE','APPDATA','LOCALAPPDATA')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($null -ne $value) { $values[$key]=$value }
  }
  $values.PATH = ($Policy.directories[1..4] -join ';')
  $values.GIT_EXEC_PATH=$Policy.exec; $values.MSYSTEM='MINGW64'; $values.MSYS2_ENV_CONV_EXCL='GIT_EXEC_PATH='
  $values.GIT_CONFIG_NOSYSTEM='1'; $values.GIT_CONFIG_GLOBAL=(Join-Path $Policy.exec 'na1-no-global.cfg')
  $values.GIT_OPTIONAL_LOCKS='0'; $values.GIT_NO_REPLACE_OBJECTS='1'; $values.GIT_TERMINAL_PROMPT='0'
  $values.GCM_INTERACTIVE='never'; $values.LANG='C'; $values.LC_ALL='C'; $values.LANGUAGE='C'
  return [string[]]@($values.Keys | Sort-Object | ForEach-Object { $_+'='+$values[$_] })
}
function GitArguments($Policy,[string]$Kind) {
  GitCanonical $repository; Guard $repository $true
  $prefix = @(('--exec-path='+$Policy.exec),'-c',('safe.directory='+$repository),'--no-pager',
    '-c','core.fsmonitor=false','-c',('core.hooksPath='+$Policy.exec),'-c','submodule.recurse=false')
  $tail = switch -CaseSensitive ($Kind) {
    'head' { @('-C',$repository,'rev-parse','HEAD') }
    'tree' { @('-C',$repository,'rev-parse','HEAD^{tree}') }
    'status' { @('-C',$repository,'status','--porcelain=v1','--untracked-files=no','--ignore-submodules=all') }
    'version' { @('--version') }
    default { throw 'guard_failed' }
  }
  return [string[]]($prefix+$tail)
}
function GitMetadata([string]$Kind) {
  $before = InspectGitPolicy $gitPolicy
  if ($null -eq $gitPolicy.snapshot) { $gitPolicy.snapshot=$before }
  if ($gitPolicy.snapshot -cne $before) { throw 'identity_changed' }
  $argv = GitArguments $gitPolicy $Kind
  $environment = GitEnvironment $gitPolicy
  $bytes = Tool $gitPolicy.git $argv $true 1048576 $true $environment
  if ((InspectGitPolicy $gitPolicy) -cne $before) { throw 'identity_changed' }
  return $utf8.GetString($bytes)
}
function CheckSource {
  $head = (GitMetadata 'head').Trim()
  $tree = (GitMetadata 'tree').Trim()
  if ($head -cne $SourceRevision -or $tree -cnotmatch '^[0-9a-f]{40}$' -or
      (GitMetadata 'status').Trim()) { throw 'source_mismatch' }
  return $tree
}
function InvokeCompile($Tools,[string]$Source,[string]$Output,[bool]$Coverage,[string]$Support='',[string]$SupportSha='') {
  $object = [IO.Path]::ChangeExtension($Output,'.obj')
  $extra = ''
  if ($Coverage) {
    if (!$Support -or (Hash $Support) -cne $SupportSha -or
        (Hash (Join-Path $repository $sourcePaths[11])) -cne $sources[11].sha256) { throw 'source_mismatch' }
    $extra = ' /clang:-fprofile-instr-generate /clang:-fcoverage-mapping /clang:-fcoverage-compilation-dir=.' +
      ' /clang:"-ffile-prefix-map=' + $repository + '=."' +
      ' /clang:"-fcoverage-prefix-map=' + $repository + '=."'
  }
  $command = 'call "' + $Tools.devcmd + '" -arch=x64 -host_arch=x64 >nul && "' + $Tools.compiler +
    '" /W4 /WX /MT /O2 /fp:precise' + $extra + ' "' + $Source + '"' +
    $(if ($Coverage) { ' "' + $Support + '"' } else { '' }) + ' /Fe:"' + $Output + '" /Fo:"' + $object +
    '" /link kernel32.lib advapi32.lib'
  $null = Tool $Tools.cmd @('/d','/s','/c',$command)
  if ($Coverage -and ((Hash $Support) -cne $SupportSha -or
      (Hash (Join-Path $repository $sourcePaths[11])) -cne $sources[11].sha256)) { throw 'identity_changed' }
  ScanBinary $Output
}
function RequireSyntheticInput {
  $scratch = Join-Path $FixtureRoot 'na1-known-scratch'
  $text = Join-Path $scratch 'zero.txt'
  Guard $scratch $true; Guard $text $false
  if ((Get-Item -LiteralPath $text).Length -ne 32 -or
      (Hash $text) -cne '662970fac258865cfe4002ed63efa04be7a132f9319451a70ffd15233a55eb1f') { throw 'source_mismatch' }
}

if ($WorkerMode -in @('host-build','host-coverage')) {
  # The external host observes this pwsh process separately. This fact file is
  # written only after the internal worker, real job0 and all own handles close.
  Guard $stage $true
  if (!(Test-Path -LiteralPath $public)) { [IO.Directory]::CreateDirectory($public) | Out-Null }
  Guard $public $true
  if (!(Test-Path -LiteralPath $FixtureRoot)) { [IO.Directory]::CreateDirectory($FixtureRoot) | Out-Null }
  Guard $FixtureRoot $true
  if ($WorkerMode -eq 'host-build') {
    if (Test-Path -LiteralPath $PublicMcpRoot) { throw 'namespace_not_fresh' }
    RequireSyntheticInput
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $null = $names.Add('na1-known-scratch'); $null = $names.Add('na1-exec-empty')
    $children = [IO.Directory]::EnumerateFileSystemEntries($FixtureRoot).GetEnumerator()
    try {
      while ($children.MoveNext()) {
        if (!$names.Remove([IO.Path]::GetFileName($children.Current))) { throw 'namespace_not_fresh' }
      }
    } finally { $children.Dispose() }
    if ($names.Count -ne 0 -or
        @(Get-ChildItem -LiteralPath (Join-Path $FixtureRoot 'na1-known-scratch') -Force).Count -ne 1) { throw 'namespace_not_fresh' }
    GitEmpty (Join-Path $FixtureRoot 'na1-exec-empty')
  }
  $mode = if ($WorkerMode -eq 'host-build') { 'build-worker' } else { 'coverage-tools' }
  $facts = [OwnedGitBuild]::Run($PSCommandPath,$mode,$PublicMcpRoot,$FixtureRoot,$SourceRevision,$H,$GitNodeExecutable)
  if ($WorkerMode -eq 'host-build') { ValidateBuilt }
  WriteJson (Join-Path $FixtureRoot ('infrastructure-' + $facts.role + '.json')) $facts
  exit 0
}

Guard $stage $true
Guard $FixtureRoot $true
[OwnedGitBuild]::RequireJobMembership()
$gitPolicy = GitPolicy
$tree = CheckSource
$tools = InstalledTools
if ($WorkerMode -eq 'coverage-tools') {
  # Caller is the post-bootstrap native host. This worker never consumes a
  # bootstrap/JSON permit; checkpoint B must guard the actual launch callsite.
  $pairs = @()
  $fixtureManifestPath = Join-Path $FixtureRoot 'fixture-assets.json'
  Guard $fixtureManifestPath $false
  if ((Get-Item -LiteralPath $fixtureManifestPath).Length -gt 65536) { throw 'quota' }
  $fixtureIdentity = [OwnedGitBuild]::Identity($fixtureManifestPath)
  $fixture = ReadPublicJson $fixtureManifestPath
  if ([OwnedGitBuild]::Identity($fixtureManifestPath) -cne $fixtureIdentity -or
      $fixture.schema -cne 'desk.owned-git-fixtures/1' -or $fixture.sourceRevision -cne $SourceRevision -or
      $fixture.sourceTree -cne $tree -or $fixture.allocationSha256 -cne $allocation -or
      $fixture.binaries.Count -ne 5 -or (Hash $tools.profdata) -cne $fixture.compiler.llvmProfdataSha256 -or
      (Hash $tools.cov) -cne $fixture.compiler.llvmCovSha256 -or
      (Hash $tools.compiler) -cne $fixture.compiler.imageSha256) { throw 'source_mismatch' }
  RequireSyntheticInput
  $baseline = Join-Path $FixtureRoot 'na1-known-scratch\zero.profdata'
  Guard $baseline $false
  $baselineIdentity = [OwnedGitBuild]::Identity($baseline)
  $baselineHash = Hash $baseline
  if ($fixture.compiler.coverageMode -cne 'synthetic-indexed-zero-v1' -or
      $fixture.compiler.runtimeProfilePolicy -cne 'support-symbol-no-file-init-v1' -or
      !$fixture.syntheticBaseline.roundTripObserved -or
      $fixture.syntheticBaseline.producerSha256 -cne (Hash $tools.profdata) -or
      $fixture.syntheticBaseline.indexedSha256 -cne $baselineHash -or
      $fixture.syntheticBaseline.indexedBytes -ne (Get-Item -LiteralPath $baseline).Length -or
      $fixture.syntheticBaseline.indexedBytes -lt 1 -or $fixture.syntheticBaseline.indexedBytes -gt 1024) { throw 'source_mismatch' }
  foreach ($index in @(0,1)) {
    $key = if ($index -eq 0) { 'production' } else { 'fault' }
    $image = Join-Path $FixtureRoot ($key + '-owner-instrumented.exe')
    Guard $image $false
    $binaryIndex = if ($index -eq 0) { 1 } else { 3 }
    if ($fixture.binaries[$binaryIndex].key -cne ([IO.Path]::GetFileName($image)) -or
        (Hash $image) -cne $fixture.binaries[$binaryIndex].sha256) { throw 'source_mismatch' }
    $bytes = Tool $tools.cov @('export',$image,('-instr-profile=' + $baseline),'-summary-only',
      '-format=text','-num-threads=1','-debuginfod=false') $true 8388608 $true
    if ([OwnedGitBuild]::Identity($baseline) -cne $baselineIdentity -or (Hash $baseline) -cne $baselineHash -or
        (Hash $image) -cne $fixture.binaries[$binaryIndex].sha256) { throw 'identity_changed' }
    [OwnedGitBuild]::CheckJson($bytes)
    $json = $utf8.GetString($bytes) | ConvertFrom-Json -AsHashtable -Depth 16
    if ($json.data.Count -ne 1 -or $json.data[0].files.Count -gt 1024) { throw 'denominator_missing' }
    $found = @()
    foreach ($file in $json.data[0].files) {
      $filename = $file.filename.Replace('\','/')
      if ($filename.StartsWith('./')) { $filename = $filename.Substring(2) }
      if ($filename -cnotin $sourcePaths -or $filename.Contains('../') -or $filename.Contains(':')) { throw 'guard_failed' }
      if ($filename -ceq $sourcePaths[0]) { $found += $file }
    }
    if ($found.Count -ne 1) { throw 'denominator_missing' }
    $denominator = [ordered]@{ source=$frozen[0] }
    foreach ($metric in @('regions','branches','functions','lines')) {
      $count = $found[0].summary[$metric].count
      if (($count -isnot [long] -and $count -isnot [int]) -or $count -le 0 -or $count -gt 9007199254740991) { throw 'denominator_missing' }
      $denominator[$metric] = $count
    }
    $denominator.origin = 'public-instrumented-mapping-synthetic-indexed-zero'; $pairs += $denominator
  }
  foreach ($metric in @('regions','branches','functions','lines')) {
    if ($pairs[0][$metric] -ne $pairs[1][$metric]) { throw 'denominator_mismatch' }
  }
  WriteJson (Join-Path $FixtureRoot 'coverage-pair.json') ([ordered]@{ production=$pairs[0];fault=$pairs[1]
    equal=$true;scope='identical-production-file-only';exact100=$false
    executionCounts='synthetic-zero';runtimeProfile='not-collected';baselineSha256=$baselineHash })
  exit 0
}

$selectedGit = $gitPolicy.git
$selectedGitHash = $gitPolicy.hashes[$selectedGit]
$selectedGitVersion = (GitMetadata 'version').Trim()
if ($selectedGitVersion -cnotmatch '^git version [0-9]+(?:\.[0-9]+){1,3}(?:\.windows\.[0-9]+)?$' -or
    (Hash $selectedGit) -cne $selectedGitHash) { throw 'runtime_mismatch' }
WriteJson (Join-Path $FixtureRoot 'git-binding.json') ([ordered]@{
  schema='desk.owned-git-fixture-git/2';sourceRevision=$SourceRevision;sourceTree=$tree
  executable=$selectedGit;sha256=$selectedGitHash;version=$selectedGitVersion
  shellExecutable=$gitPolicy.shell;shellSha256=$gitPolicy.hashes[$gitPolicy.shell]
  envSha256=$gitPolicy.hashes[$gitPolicy.envImage];msysRuntimeSha256=$gitPolicy.hashes[$gitPolicy.msys]
  imagePolicy='direct-mingw64-empty-exec-v1';execPath=$gitPolicy.exec;mountConfigSha256=$gitPolicy.mount.sha256
}) 4096
$sources = @()
for ($i=0; $i -lt 17; $i++) {
  $file = Join-Path $repository $sourcePaths[$i]
  Guard $file $false
  $length = (Get-Item -LiteralPath $file).Length
  $hash = Hash $file
  if ($length -lt 1 -or $length -gt 2097152 -or ($i -lt 4 -and $hash -cne $frozen[$i])) { throw 'source_mismatch' }
  $sources += [ordered]@{key=('S{0:d2}' -f ($i+1));repositoryPath=$sourcePaths[$i];sha256=$hash
    bytes=$length;hashOrigin='ci_host_rehashed'}
}
if (Test-Path -LiteralPath $PublicMcpRoot) { throw 'namespace_not_fresh' }
[IO.Directory]::CreateDirectory($PublicMcpRoot) | Out-Null
for ($i=0; $i -lt 4; $i++) {
  $relative = $sourcePaths[$i].Substring('plugins/desk/mcp/'.Length)
  $destination = Join-Path $PublicMcpRoot $relative
  [IO.Directory]::CreateDirectory((Split-Path $destination)) | Out-Null
  CopyExact (Join-Path $repository $sourcePaths[$i]) $destination
  if ((Hash $destination) -cne $frozen[$i]) { throw 'source_mismatch' }
}
$version = ((ToolText $tools.compiler @('--version')) -split "`r?`n")[0].Trim()
if ($version -cnotmatch '^clang version ([0-9]+\.[0-9]+\.[0-9]+)(?: \(https://github\.com/llvm/llvm-project(?:\.git)? [0-9a-f]{40}\))?$') { throw 'toolchain_shape' }
$compilerVersion = $Matches[1]
$toolHashes = @{ compiler=(Hash $tools.compiler);profdata=(Hash $tools.profdata);cov=(Hash $tools.cov) }
foreach ($tool in @($tools.profdata,$tools.cov)) {
  $versionOutput = ToolText $tool @('--version')
  if ($versionOutput -cnotmatch 'LLVM version ([0-9]+\.[0-9]+\.[0-9]+)' -or $Matches[1] -cne $compilerVersion) { throw 'toolchain_shape' }
}
RequireSyntheticInput
$scratch = Join-Path $FixtureRoot 'na1-known-scratch'
$support = Join-Path $scratch 'na1-profile-support.obj'
if (Test-Path -LiteralPath $support) { throw 'namespace_not_fresh' }
$null = Tool $tools.compiler @('/nologo','/TC','/c','/W4','/WX','/MT','/O2','/Zl',
  '/DDESK_NA1_PROFILE_SUPPORT=1','/clang:-fno-crash-diagnostics',('/Fo' + $support),$sourcePaths[11])
Guard $support $false
if ((Get-Item -LiteralPath $support).Length -lt 1 -or (Get-Item -LiteralPath $support).Length -gt 4096 -or
    (Hash (Join-Path $repository $sourcePaths[11])) -cne $sources[11].sha256) { throw 'source_mismatch' }
ScanBinary $support
$supportHash = Hash $support
$profileSupport = [ordered]@{sourceKey='S12';basename='na1-profile-support.obj';sha256=$supportHash
  bytes=(Get-Item -LiteralPath $support).Length;compileProfile='profile-support'
  definition='DESK_NA1_PROFILE_SUPPORT=1';instrumented=$false}
# S13 first; the in-process real infrastructure job already owns this compiler.
InvokeCompile $tools (Join-Path $repository $sourcePaths[12]) (Join-Path $FixtureRoot $binaryNames[4]) $false
$ordinaryBuilder = Join-Path $PublicMcpRoot 'scripts\build-owned-git.ps1'
$legacyPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Guard $legacyPowerShell $false
$null = Tool $legacyPowerShell @('-NoProfile','-NonInteractive','-File',$ordinaryBuilder,'-PublicMcpRoot',$PublicMcpRoot,'-SourceRevision',$SourceRevision)
$target = Join-Path $PublicMcpRoot 'artifacts\owned-git\win32-x64'
$productionManifestFile = Join-Path $target 'manifest.json'
Guard $productionManifestFile $false
if ((Get-Item -LiteralPath $productionManifestFile).Length -gt 65536) { throw 'quota' }
$production = ReadPublicJson $productionManifestFile
if ($production.schema -cne 'desk.owned-git-assets/1' -or $production.protocol -cne 'desk.owned-git/1' -or
    $production.variant -cne 'production' -or $production.target -cne 'win32-x64' -or
    $production.sourceRevision -cne $SourceRevision -or $production.toolchain.version -cne $version -or
    $production.toolchain.sdkVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' -or
    $production.toolchain.sdkVersion.Length -gt 32 -or
    ($production.toolchain.flags -join '|') -cne '/W4|/WX|/MT|/O2|/fp:precise|kernel32.lib|advapi32.lib') { throw 'toolchain_shape' }
for ($i=0; $i -lt 4; $i++) {
  if ($production.sources.Count -ne 4 -or $production.sources[$i].sha256 -cne $frozen[$i] -or
      $production.sources[$i].path -cne $sourcePaths[$i].Substring('plugins/desk/mcp/'.Length)) { throw 'source_mismatch' }
}
$ordinary = Join-Path $target 'desk-owned-git.exe'
$shim = Join-Path $target 'owned-git-child.cjs'
ScanBinary $ordinary
if ((Hash $ordinary) -cne $production.files.owner.sha256 -or (Hash $shim) -cne $production.files.shim.sha256 -or
    (Hash $shim) -cne $frozen[1]) { throw 'source_mismatch' }
CopyExact $ordinary (Join-Path $FixtureRoot $binaryNames[0])
InvokeCompile $tools (Join-Path $repository $sourcePaths[0]) (Join-Path $FixtureRoot $binaryNames[1]) $true $support $supportHash
InvokeCompile $tools (Join-Path $repository $sourcePaths[11]) (Join-Path $FixtureRoot $binaryNames[2]) $false
InvokeCompile $tools (Join-Path $repository $sourcePaths[11]) (Join-Path $FixtureRoot $binaryNames[3]) $true $support $supportHash
# The images are final before baseline creation (LLVM rejects newer-image warnings).
$zeroText = Join-Path $scratch 'zero.txt'
$baseline = Join-Path $scratch 'zero.profdata'
if (Test-Path -LiteralPath $baseline) { throw 'namespace_not_fresh' }
$textIdentity = [OwnedGitBuild]::Identity($zeroText)
$null = Tool $tools.profdata @('merge','-instr','-binary','-sparse=false','-num-threads=1',
  '-debuginfod=false','-failure-mode=any','-o',$baseline,$zeroText) $false 1048576 $true
Guard $baseline $false
if ((Get-Item -LiteralPath $baseline).Length -lt 1 -or (Get-Item -LiteralPath $baseline).Length -gt 1024 -or
    [OwnedGitBuild]::Identity($zeroText) -cne $textIdentity) { throw 'source_mismatch' }
$baselineIdentity = [OwnedGitBuild]::Identity($baseline)
$baselineHash = Hash $baseline
$roundTrip = Tool $tools.profdata @('merge','-instr','-text','-sparse=false','-num-threads=1',
  '-debuginfod=false','-failure-mode=any','-o','-',$baseline) $true 1048576 $true
$normalized = $utf8.GetString($roundTrip).Replace("`r`n","`n")
$canonical = "!na1.synthetic.zero!`n# Func Hash:`n0`n# Num Counters:`n1`n# Counter Values:`n0`n`n"
if ($normalized.Contains("`r") -or $normalized -cne $canonical -or $utf8.GetByteCount($normalized) -ne 75 -or
    [OwnedGitBuild]::Identity($baseline) -cne $baselineIdentity -or (Hash $baseline) -cne $baselineHash) { throw 'source_mismatch' }
$syntheticBaseline = [ordered]@{kind='fe-synthetic-zero-v1'
  textSha256='662970fac258865cfe4002ed63efa04be7a132f9319451a70ffd15233a55eb1f';textBytes=32
  indexedSha256=$baselineHash;indexedBytes=(Get-Item -LiteralPath $baseline).Length
  producerSha256=$toolHashes.profdata;roundTripObserved=$true}
$roots = Join-Path $public 'test-roots'
if (Test-Path -LiteralPath $roots) { throw 'namespace_not_fresh' }
[IO.Directory]::CreateDirectory($roots) | Out-Null
$variants = @()
foreach ($name in $variantNames) {
  $destination = Join-Path $roots $name
  CopyExact (Join-Path $repository $sourcePaths[10]) $destination
  if ((Hash $destination) -cne $sources[10].sha256) { throw 'source_mismatch' }
  $variants += [ordered]@{basename=$name;sourceKey='S11';sha256=(Hash $destination);production=$false}
}
foreach ($i in @(14,15)) {
  $destination = Join-Path $FixtureRoot ([IO.Path]::GetFileName($sourcePaths[$i]))
  CopyExact (Join-Path $repository $sourcePaths[$i]) $destination
  if ((Hash $destination) -cne $sources[$i].sha256) { throw 'source_mismatch' }
}
$hook = Join-Path $FixtureRoot 'hooks'
[IO.Directory]::CreateDirectory($hook) | Out-Null
CopyExact (Join-Path $repository $sourcePaths[14]) (Join-Path $hook 'pre-commit')
if ((Hash (Join-Path $hook 'pre-commit')) -cne $sources[14].sha256) { throw 'source_mismatch' }
$profiles = @('production','production-coverage','fault','fault-coverage','supervisor')
$binarySources = @('S01','S01','S12','S12','S13')
$binaries = @()
for ($i=0; $i -lt 5; $i++) {
  $file = Join-Path $FixtureRoot $binaryNames[$i]
  ScanBinary $file
  $binaries += [ordered]@{key=$binaryNames[$i];sha256=(Hash $file);bytes=(Get-Item -LiteralPath $file).Length
    sourceKey=$binarySources[$i];variant=$profiles[$i];hashOrigin='ci_host_rehashed'
    profileSupportSha256=$(if ($i -in @(1,3)) { $supportHash } else { $null })}
}
$pwshImage = [OwnedGitBuild]::ImagePath()
$pwshVersion = $PSVersionTable.PSVersion.ToString()
if ($pwshVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'toolchain_shape' }
foreach ($key in @('compiler','profdata','cov')) {
  if ((Hash $tools[$key]) -cne $toolHashes[$key]) { throw 'identity_changed' }
}
$compiler = [ordered]@{name='clang-cl';version=$version;sdkVersion=$production.toolchain.sdkVersion
  imageSha256=$toolHashes.compiler;llvmProfdataSha256=$toolHashes.profdata;llvmCovSha256=$toolHashes.cov
  pwshVersion=$pwshVersion;pwshImageSha256=(Hash $pwshImage);interop='in-process-fixed-source'
  flagsProfiles=($profiles + @('profile-support'));pathMappingApplied=$true;privatePathScanPassed=$true
  coverageMode='synthetic-indexed-zero-v1';runtimeProfilePolicy='support-symbol-no-file-init-v1'}
$sourceManifest = Join-Path $FixtureRoot 'source-assets.json'
WriteJson $sourceManifest ([ordered]@{schema='desk.owned-git-sources/1';sourceRevision=$SourceRevision;sourceTree=$tree
  productContentBase=$base;allocationSha256=$allocation;sources=$sources})
$fixtureManifest = Join-Path $FixtureRoot 'fixture-assets.json'
WriteJson $fixtureManifest ([ordered]@{schema='desk.owned-git-fixtures/1';sourceRevision=$SourceRevision;sourceTree=$tree
  allocationSha256=$allocation;compiler=$compiler;binaries=$binaries;roots=$variants
  profileSupport=$profileSupport;syntheticBaseline=$syntheticBaseline
  productionManifestSha256=(Hash $productionManifestFile);sourceManifestSha256=(Hash $sourceManifest)})
$export = Join-Path $stage 'export'
foreach ($child in @('sources','binaries','shim','manifests')) {
  $dir = Join-Path $export $child
  if (Test-Path -LiteralPath $dir) { throw 'namespace_not_fresh' }
  [IO.Directory]::CreateDirectory($dir) | Out-Null
}
for ($i=0; $i -lt 17; $i++) {
  $destination = Join-Path $export ('sources\' + $sourceNames[$i])
  CopyExact (Join-Path $repository $sourcePaths[$i]) $destination
  if ((Hash $destination) -cne $sources[$i].sha256) { throw 'source_mismatch' }
}
foreach ($name in $binaryNames) { CopyExact (Join-Path $FixtureRoot $name) (Join-Path $export ('binaries\' + $name)) }
CopyExact $shim (Join-Path $export 'shim\owned-git-child.cjs')
CopyExact $productionManifestFile (Join-Path $export 'manifests\production-assets.json')
CopyExact $fixtureManifest (Join-Path $export 'manifests\fixture-assets.json')
CopyExact $sourceManifest (Join-Path $export 'manifests\source-assets.json')
$leaves = @($sourceNames | ForEach-Object { Join-Path $export ('sources\' + $_) }) +
  @($binaryNames | ForEach-Object { Join-Path $export ('binaries\' + $_) }) +
  @('shim\owned-git-child.cjs','manifests\production-assets.json','manifests\fixture-assets.json','manifests\source-assets.json' |
    ForEach-Object { Join-Path $export $_ })
$total = 0L
foreach ($file in $leaves) { Guard $file $false; $total += (Get-Item -LiteralPath $file).Length }
if ($total -gt 33554432) { throw 'quota' }
Deadline
