import {test} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {createRequire} from "node:module"
import os from "node:os"
import vm from "node:vm"
import {mcpRoot} from "./_mcp_handshake.js"
import {mkTempRoot} from "../_temp_roots.js"
import {removeTree} from "../_remove_tree.js"
const require = createRequire(import.meta.url)
test("fresh worker refuses unknown modes before loading CLI modules", async () => {
  const file = path.join(mcpRoot,"browser-context-runtime.cjs")
  assert.ok(fs.existsSync(file),"shared maintained CLI worker must exist")
  await assert.rejects(require(file).main({mode:"automatic"}),{code:"invalid_arguments"})
})

test("actual maintained daemon options can reach native acquisition using the strict owner config alone", async t => {
  const root = await mkTempRoot("desk-F-profile-route-")
  t.after(()=>removeTree(root))
  const home = path.join(root,"native-home"), info = os.userInfo()
  t.mock.method(os,"userInfo",()=>({...info,homedir:home}))
  const put = (file,value) => {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
    fs.writeFileSync(file,typeof value === "string" ? value : JSON.stringify(value),{mode:0o600})
  }
  const actualCli = process.env.DESK_TEST_MAINTAINED_CLI_DIR
  assert.ok(actualCli,"requires admitted maintained source")
  const input = require("./fixtures/playwright-native-error-transport.cjs").read()
  const lib = path.join(root,"generation/node_modules/playwright-core/lib")
  put(path.join(lib,"coreBundle.js"),fs.readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs",import.meta.url),"utf8")+input.core)
  put(path.join(lib,"tools/cli-client/session.js"),input.sessionSource)
  const patch = require(path.join(mcpRoot,"web-playwright-patch.cjs"))
  const installed = {dir:path.join(root,"generation"),version:"owned-F-route",core:null}
  patch.apply(installed)
  assert.equal(patch.readRevision(installed),4)
  const app = path.join(home,"Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
  put(app,"owned observation fixture, never launched")
  const discovery = require(path.join(mcpRoot,"web-browser-discovery.cjs"))
  const candidates = discovery.browserPaths("msedge",process.platform,process.env)
  const observedFs = Object.create(fs)
  observedFs.existsSync = file => candidates.includes(String(file)) ? process.platform !== "darwin" : fs.existsSync(file)
  observedFs.realpathSync = file => candidates.includes(String(file)) && process.platform !== "darwin" ? app : fs.realpathSync(file)
  const id = "11111111-1111-4111-8111-111111111111"
  const record = {version:1,contextId:id,label:"Route qualification",channel:"msedge",
    userDataDir:path.join(root,"profile"),profileDirName:"Default",nativeReadyFile:path.join(root,"ready.json"),
    extensionId:"a".repeat(32),sourceDigest:"b".repeat(64)}
  const config = {extension:true,browser:{browserName:"chromium",userDataDir:record.userDataDir,
    launchOptions:{channel:"msedge"}},deskNativeContext:record}
  const configFile = path.join(root,"owner/config/browser.json")
  put(configFile,config)
  const {loadTemplate} = require("./fixtures/native-template-loader.cjs")
  const module = {exports:{}}
  const credential = loadTemplate(path.join(lib,"desk-extension-credential.cjs"),{
    module,__dirname:lib,process,Buffer,setTimeout,clearTimeout,
    require:name=>name === "fs" ? observedFs : require(name),
  })
  const core = fs.readFileSync(path.resolve(actualCli,"../../coreBundle.js"),"utf8")
  function region(text,start,end) {
    const at = text.indexOf(start);assert.ok(at>=0)
    return text.slice(at,text.indexOf(end,at))
  }
  const resolver = region(core,"function resolveExtensionOptions(","\nasync function validateBrowserConfig(")
  const browserParam = region(core,"function resolveBrowserParam(","\nfunction configFromCLIOptions(")
  const patched = fs.readFileSync(path.join(lib,"coreBundle.js"),"utf8")
  const browser = region(patched,"async function createBrowser(config,","\nasync function connectToBrowserEndpoint(")
  let acquisitions = 0
  const create = vm.runInNewContext(resolver+"\n"+browserParam+"\n"+browser+"\ncreateBrowser",{
    process:{env:{}},envToString:value=>value,
    require:name=>{assert.equal(name,"./desk-extension-credential.cjs");return credential},
    async createExtensionBrowser(){acquisitions++;throw Object.assign(new Error("owned acquisition checkpoint"),{code:"ACQUISITION_REACHED"})},
  })
  // Control: actual preflight accepts the same exact record when an explicit
  // profile option exists. The following call stops before native effects.
  await assert.rejects(create(config,{}, {browser:"msedge",profileDirName:"Default"},{}),{code:"ACQUISITION_REACHED"})
  assert.equal(acquisitions,1)
  // Session.startDaemon forwards browser/extension/persistent/config/idle only.
  // Its daemon has no profile-dir-name option. The supplied maintained resolver
  // therefore sees this real option shape, not the E harness's opts=>opts seam.
  let rejected
  try { await create(config,{}, {browser:"msedge",extension:true,persistent:true,config:configFile,idleTimeout:0},{}) }
  catch(error) { rejected = error }
  assert.equal(acquisitions,2,
    "strict native owner config must supply its profile to actual CLI acquisition; observed "+(rejected?.code || "no error"))
})
