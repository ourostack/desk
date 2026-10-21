import {test} from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import {createRequire} from "node:module"

const require=createRequire(import.meta.url)
const loader=require("./fixtures/native-template-loader.cjs")
const phase="signedWorkerFixture.initial-daemon"
function observer(...args) {
  assert.equal(typeof loader.observeNextVerifyGeneration,"function","test-only one-shot diagnostic is not implemented")
  return loader.observeNextVerifyGeneration(...args)
}
function memoryContext(behavior) {
  const context={behavior}
  vm.runInNewContext(
    "function verifyGeneration(...args){return behavior.apply(this,args)};"+
    "function binding(...args){return verifyGeneration.apply(this,args)}",context)
  return context
}
function thrownBy(fn) {
  let threw=false,value
  try { fn() } catch(error) { threw=true;value=error }
  assert.equal(threw,true,"the original refusal must still throw")
  return value
}

test("GivenSuccess_WhenObserved_VerificationRunsOnceAndPreservesReceiverArgumentsAndResult",()=>{
  const returned={receipt:"memory-only"},args=[{dir:"unused-memory-value"},undefined],caller={tag:"memory-caller"}
  let calls=0,receiver,seen
  const context=memoryContext(function(...values){calls++;receiver=this;seen=values;return returned})
  const original=context.verifyGeneration,events=[]
  const restore=observer(context,phase,value=>events.push(value))
  assert.strictEqual(context.binding.call(caller,...args),returned)
  assert.equal(calls,1)
  assert.strictEqual(receiver,caller)
  assert.deepEqual(seen,args)
  assert.strictEqual(context.verifyGeneration,original)
  assert.deepEqual(events,[])
  restore()
})

test("GivenRefusal_WhenObserved_ExactSameErrorRethrowsWithSafePhaseAndGuardAttribution",()=>{
  const error=Object.assign(new Error("injected-secret-message"),{
    code:"NATIVE_PRIVATE_PATH_INVALID",status:2,signal:null,
    stack:"Error: injected-secret-message\n"+
      "    at assertPrivateGeneration (C:\\private-secret\\web-extension-credential.cjs:562:12)\n"+
      "    at caller (C:\\private-secret\\unrelated.cjs:88:1)",
  })
  let calls=0
  const context=memoryContext(()=>{calls++;throw error}),events=[]
  observer(context,phase,value=>events.push(value))
  assert.strictEqual(thrownBy(()=>context.binding()),error)
  assert.equal(calls,1)
  assert.deepEqual(events,[{
    setupPhase:phase,originalCode:"NATIVE_PRIVATE_PATH_INVALID",status:2,signal:"unknown",
    guard:{file:"plugins/desk/mcp/web-extension-credential.cjs",line:562},
  }])
  const encoded=JSON.stringify(events)
  for(const secret of ["injected-secret","private-secret","unrelated.cjs","C:\\"])
    assert.equal(encoded.includes(secret),false)
})

test("GivenStoredWrapper_WhenCalledTwice_OnlyFirstInvocationIsObservedWithoutRetry",()=>{
  const error={code:"EACCES"},events=[]
  let calls=0
  const context=memoryContext(()=>{calls++;throw error})
  observer(context,phase,value=>events.push(value))
  const wrapped=context.verifyGeneration
  assert.strictEqual(thrownBy(()=>wrapped()),error)
  assert.strictEqual(thrownBy(()=>wrapped()),error)
  assert.equal(calls,2,"two explicit callers, not an internal verification retry")
  assert.equal(events.length,1)
})

test("GivenDiagnosticSinkFailure_WhenVerifierRefuses_OriginalErrorStillRethrows",()=>{
  const error={code:"EIO"},sinkError=new Error("secret-sink-message")
  let calls=0
  const context=memoryContext(()=>{calls++;throw error})
  observer(context,phase,()=>{throw sinkError})
  assert.strictEqual(thrownBy(()=>context.binding()),error)
  assert.equal(calls,1)
})

test("GivenUnusedObserver_WhenRestored_NoLaterInvocationIsObserved",()=>{
  const error={code:"EPERM"},events=[]
  const context=memoryContext(()=>{throw error}),original=context.verifyGeneration
  const restore=observer(context,phase,value=>events.push(value))
  restore()
  assert.strictEqual(context.verifyGeneration,original)
  assert.strictEqual(thrownBy(()=>context.binding()),error)
  assert.deepEqual(events,[])
})

test("GivenInjectedFields_WhenRefused_OnlyAllowlistedDataIsEmitted",()=>{
  const secret="PRIVATE_DIAGNOSTIC_MARKER"
  const error={
    code:secret,status:"2 "+secret,signal:"SIGTERM "+secret,
    message:"Authorization Bearer "+secret,path:"/private/"+secret,
    command:"powershell "+secret,stdout:secret,stderr:secret,
    stack:"Error: "+secret+"\n    at operation (/private/"+secret+"/unknown.cjs:12:1)",
  }
  const context=memoryContext(()=>{throw error}),events=[]
  observer(context,"/private/"+secret,value=>events.push(value))
  assert.strictEqual(thrownBy(()=>context.binding()),error)
  assert.deepEqual(events,[{
    setupPhase:"unknown",originalCode:"unknown",status:"unknown",signal:"unknown",
    guard:{file:"unknown",line:"unknown"},
  }])
  assert.equal(JSON.stringify(events).includes(secret),false)
})

test("GivenMalformedThrownValues_WhenObserved_IdentityAndExplicitUnknownsArePreserved",()=>{
  for(const error of [undefined,null,false,17,"PRIVATE_THROWN_VALUE",Symbol("PRIVATE_SYMBOL")]){
    const context=memoryContext(()=>{throw error}),events=[]
    observer(context,phase,value=>events.push(value))
    assert.ok(Object.is(thrownBy(()=>context.binding()),error))
    assert.deepEqual(events,[{
      setupPhase:phase,originalCode:"unknown",status:"unknown",signal:"unknown",
      guard:{file:"unknown",line:"unknown"},
    }])
  }
})

test("GivenAccessorOrProxyErrors_WhenObserved_DiagnosticsDoNotInvokeGettersOrReplaceError",()=>{
  let getterCalls=0
  const accessor={}
  for(const key of ["code","status","signal","stack"])
    Object.defineProperty(accessor,key,{get(){getterCalls++;throw new Error("PRIVATE_GETTER")}})
  const hostile=new Proxy({}, {getOwnPropertyDescriptor(){throw new Error("PRIVATE_PROXY")}})
  for(const error of [accessor,hostile]){
    const context=memoryContext(()=>{throw error}),events=[]
    observer(context,phase,value=>events.push(value))
    assert.strictEqual(thrownBy(()=>context.binding()),error)
    assert.deepEqual(events,[{
      setupPhase:phase,originalCode:"unknown",status:"unknown",signal:"unknown",
      guard:{file:"unknown",line:"unknown"},
    }])
    assert.equal(JSON.stringify(events).includes("PRIVATE"),false)
  }
  assert.equal(getterCalls,0)
})

test("GivenSignalWithoutCode_WhenObserved_NoTimeoutCauseIsInferred",()=>{
  const error={signal:"SIGTERM",status:null,stack:"PRIVATE_NONFRAME"},events=[]
  const context=memoryContext(()=>{throw error})
  observer(context,phase,value=>events.push(value))
  assert.strictEqual(thrownBy(()=>context.binding()),error)
  assert.equal(events[0].originalCode,"unknown")
  assert.equal(events[0].status,"unknown")
  assert.equal(events[0].signal,"SIGTERM")
  assert.equal(JSON.stringify(events).includes("ETIMEDOUT"),false)
})

test("GivenMalformedFrameAndNumericFields_WhenObserved_NoUnboundedValuesEscape",()=>{
  for(const error of [
    {code:"NATIVE_CODE_UNAVAILABLE",status:Infinity,signal:"PRIVATE_SIGNAL",
      stack:"    at guard (/private/web-extension-credential.cjs:99999999999:1)"},
    {code:"NATIVE_CODE_UNAVAILABLE",status:2**40,
      stack:"x".repeat(17000)+"\n    at guard (/private/web-extension-credential.cjs:562:1)"},
  ]){
    const context=memoryContext(()=>{throw error}),events=[]
    observer(context,phase,value=>events.push(value))
    assert.strictEqual(thrownBy(()=>context.binding()),error)
    assert.equal(events[0].originalCode,"NATIVE_CODE_UNAVAILABLE")
    assert.equal(events[0].status,"unknown")
    assert.equal(events[0].signal,"unknown")
    assert.deepEqual(events[0].guard,{file:"unknown",line:"unknown"})
    assert.ok(JSON.stringify(events).length<300)
  }
})

test("GivenNativeVmErrorStackAccessor_WhenObserved_KnownGuardSurvivesWithoutRawStack",()=>{
  const error=vm.runInNewContext('new Error("VM_PRIVATE_MESSAGE")',{},
    {filename:"C:\\private-vm-path\\web-extension-credential.cjs"})
  error.code="NATIVE_CODE_UNAVAILABLE"
  const context=memoryContext(()=>{throw error}),events=[]
  observer(context,phase,value=>events.push(value))
  assert.strictEqual(thrownBy(()=>context.binding()),error)
  assert.equal(events[0].guard.file,"plugins/desk/mcp/web-extension-credential.cjs")
  assert.equal(events[0].guard.line,1)
  assert.equal(JSON.stringify(events).includes("VM_PRIVATE"),false)
  assert.equal(JSON.stringify(events).includes("private-vm-path"),false)
})

test("GivenNativeErrorWithInjectedStackOrMessageGetter_WhenObserved_NoGetterExecutes",()=>{
  for(const field of ["stack","message"]){
    let calls=0
    const error=new Error("NATIVE_PRIVATE_MARKER")
    Object.defineProperty(error,field,{get(){calls++;throw new Error("PRIVATE_GETTER")}})
    const context=memoryContext(()=>{throw error}),events=[]
    observer(context,phase,value=>events.push(value))
    assert.strictEqual(thrownBy(()=>context.binding()),error)
    assert.equal(calls,0)
    assert.equal(JSON.stringify(events).includes("PRIVATE"),false)
  }
})
