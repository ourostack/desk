import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { mkTempRoot } from '../_temp_roots.js';
import { createHash } from 'node:crypto';
import { ensureStateDirectory as brokerEnsureStateDirectory } from '../../../../../plugins/desk/browser-context-broker/src/registry.mjs';
import { ownIdentityReader as mirroredOwnIdentityReader } from '../../../../../plugins/desk/mcp/src/util/broker-lock.mjs';

const broker = new URL('../../../../../plugins/desk/browser-context-broker/src/', import.meta.url);
const util = new URL('../../../../../plugins/desk/mcp/src/util/', import.meta.url);
const primitives = new URL('primitives/', broker);
const roots = [];
async function ownedRoot(t, prefix) {
  const root = await mkTempRoot(prefix);
  roots.push(root);
  t.diagnostic(`owned primitive fixture root=${root}`);
  return root;
}
test.after(async () => {
  for (const root of roots) {
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    console.log(`confirmed primitive fixture absent=${root}`);
  }
});

test('native primitive import graph excludes registry and claim operations', async () => {
  // Before extraction the real lock imports registry/claims, even when it never
  // needs registry data. This tests the dependency boundary, not a missing import.
  const seen = new Set();
  async function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const text = await readFile(url, 'utf8');
    assert.doesNotMatch(text, /registry\.json|function (?:readRegistry|writeRegistry|reconcileContext|expandRequest)\b/);
    for (const [, specifier] of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      await visit(new URL(specifier, url));
    }
  }
  await visit(new URL('lock.mjs', broker));
  await visit(new URL('../browser/native-host.mjs', util));
  await visit(new URL('../browser/native-transport.mjs', util));
});

test('compatibility facades preserve constructor and function identity', async t => {
  const claims = await import(new URL('claims.mjs', broker));
  const lock = await import(new URL('lock.mjs', broker));
  const error = await import(new URL('broker-error.mjs', util));
  const state = await import(new URL('private-state.mjs', util));
  const primitive = await import(new URL('broker-lock.mjs', util));
  assert.equal(claims.BrokerError, error.BrokerError);
  assert.equal(brokerEnsureStateDirectory, state.ensureStateDirectory);
  assert.equal(lock.withBrokerLock, primitive.withBrokerLock);
  assert.equal(lock.ownIdentityReader, primitive.ownIdentityReader);
  assert.equal(lock.ownIdentityReader, mirroredOwnIdentityReader);
  const e = new error.BrokerError('TEST', 'bounded');
  assert.ok(e instanceof claims.BrokerError);
  assert.deepEqual(e.details, {});
  const dir = await ownedRoot(t, 'native-primitives-');
  await primitive.withBrokerLock(dir, async () => {
    assert.deepEqual(await readdir(dir), ['broker.lock']);
  }, { readOwnIdentity: async () => 'fixture-start' });
  assert.deepEqual(await readdir(dir), []);
});

test('extraction keeps the exact lock algorithm and private-state behavior', async () => {
  // Immutable goldens computed from the originally verified pre-extraction
  // 8c2d0c0bead7ee3a65a56ce349b8afa20b3a912b source, NOT this implementation.
  // A fresh clone needs no unpublished historical Git object.
  // plugins/desk/browser-context-broker/src/lock.mjs:
  // blob 92abd3f0bfcf9e1599f2b9c33834a101b5009e0d; full file, 10308 bytes,
  // with ONLY claims->broker-error, registry->private-state and factory/
  // windows-acl + readiness/process-start relative import paths rebased.
  const digest = text => createHash('sha256').update(text).digest('hex');
  const lock = (await readFile(new URL('broker-lock.mjs', primitives), 'utf8'))
    .replaceAll('../../../mcp/src/', '../');
  assert.equal(digest(lock),
    '3bab075b6c490aa2f8d128010fff5f9af5a82fc8f96aa47cbea08a63f57c6970');
  // registry.mjs blob db720012039c1d9ba49f881cf4b7f7f24a4c1206:
  // slice from "export async function ensureStateDirectory" to the following
  // "\nfunction validateRegistry", trimmed, windows-acl import rebased; 807 bytes.
  const state = (await readFile(new URL('private-state.mjs', primitives), 'utf8'))
    .replaceAll('../../../mcp/src/', '../');
  const currentHelper = state.slice(state.indexOf('export async function ensureStateDirectory')).trim();
  assert.equal(digest(currentHelper),
    '987c9088bbfc7a03fde027c727c5ce87dc10c83e6e38e437a387da092615a496');
});

test('absent PID reclaim and callback failure retain exact owner-token release', async t => {
  const { withBrokerLock } = await import(new URL('broker-lock.mjs', util));
  const root = await ownedRoot(t, 'native-lock-edges-');
  const lock = path.join(root, 'broker.lock'), owner = path.join(lock, 'owner.json');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(owner, JSON.stringify({
    pid: 123, token: 'stale', startIdentity: 'gone', createdAt: new Date(0).toISOString(),
  }), { mode: 0o600 });
  await assert.rejects(withBrokerLock(root, () => { throw Error('callback-failed'); }, {
    readOwnIdentity: async () => 'own', processIdentityReader: async () => undefined, staleMs: 0,
  }), /callback-failed/);
  assert.deepEqual(await readdir(root), []);
  await withBrokerLock(root, async () => {
    const record = JSON.parse(await readFile(owner, 'utf8'));
    await writeFile(owner, JSON.stringify({ ...record, token: 'replacement' }), { mode: 0o600 });
  }, { readOwnIdentity: async () => 'own' });
  assert.equal(JSON.parse(await readFile(owner, 'utf8')).token, 'replacement');
});

test('unknown initializing temp owner refuses reclaim after grace', async t => {
  const { withBrokerLock } = await import(new URL('broker-lock.mjs', util));
  const root = await ownedRoot(t, 'native-initializing-');
  const lock = path.join(root, 'broker.lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, '.owner-unknown.tmp'), JSON.stringify({
    pid: 123, token: 'initializing', startIdentity: 'unknown', createdAt: new Date(0).toISOString(),
  }), { mode: 0o600 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(withBrokerLock(root, () => assert.fail('unknown owner reclaimed'), {
    staleMs: 1, readOwnIdentity: async () => 'own',
    processIdentityReader: async () => { throw Error('unknown'); },
  }), error => error.code === 'STALE_BROKER_LOCK' && error.details.ownerState === 'unknown');
  assert.deepEqual(await readdir(lock), ['.owner-unknown.tmp']);
});

test('BigInt inode and device replacement refuse reclaim; Windows ACL created flags remain exact', async t => {
  const { spawnSync } = await import('node:child_process');
  const script = `
import vm from 'node:vm';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const base = ${JSON.stringify(primitives.href)};
const texts = Object.fromEntries(await Promise.all(['broker-lock.mjs','broker-error.mjs','private-state.mjs'].map(async name =>
  [name, await fs.readFile(new URL(name, base), 'utf8')])));
async function fixture(mode) {
  let locked = !['publish','acl-failure'].includes(mode), identityReads = 0, ownerReads = 0;
  const old = JSON.stringify({pid:800,token:'prior',startIdentity:'old',createdAt:new Date(0).toISOString()});
  let files = new Map(locked ? [['owner.json',old]] : []);
  const calls = [], acl = [];
  const directory = '/fixture', lock = '/fixture/broker.lock';
  const fsp = {
    async mkdir(target, options) {
      calls.push(['mkdir',target]);
      if(target === directory) return mode === 'state-created' ? directory : undefined;
      if(options.recursive) return undefined;
      if(locked) throw Object.assign(Error(),{code:'EEXIST'});
      locked=true; return undefined;
    },
    async stat(target, options) {
      if(target === directory) return {isDirectory:()=>true,mode:0o777};
      if(options?.bigint) {
        identityReads++;
        return {ino:9007199254740992n+(mode==='inode'&&identityReads>1?1n:0n),
          dev:9007199254740992n+(mode==='device'&&identityReads>1?1n:0n)};
      }
      return {isDirectory:()=>true,mode:0o777,mtimeMs:1,birthtimeMs:0,ctimeMs:0};
    },
    async readdir() { return [...files.keys()]; },
    async readFile(target) {
      assert.notEqual(target, '/fixture/registry.json');
      const content = files.get(target.split('/').pop());
      return mode==='fingerprint'&&++ownerReads>1 ? content.replace('"prior"','"replacement"') : content;
    },
    async writeFile(target, data) { files.set(target.split('/').pop(),data); },
    async rename(from,to) {
      calls.push(['rename',from,to]);
      if(from===lock) {locked=false;files.clear();}
      else {files.set('owner.json',files.get(from.split('/').pop()));files.delete(from.split('/').pop());}
    },
    async rm(target) {calls.push(['remove',target]);locked=false;files.clear();},
  };
  const context = vm.createContext({process:{pid:700,platform:'win32'},setTimeout,clearTimeout,Date,console});
  const cache = new Map();
  function synthetic(exports) {
    return new vm.SyntheticModule(Object.keys(exports),function(){
      for(const [key,value] of Object.entries(exports))this.setExport(key,value);
    },{context});
  }
  async function load(name) {
    if(cache.has(name))return cache.get(name);
    const module = new vm.SourceTextModule(texts[name],{context,
      importModuleDynamically: async spec => {
        const dep = synthetic(spec.endsWith('/windows-acl.js') ?
          {protectWindowsPaths:async(entries,options)=>{
            acl.push({entries,options});
            if(mode==='acl-failure'&&options.label==='desk_browser_lock')throw Error('fixture-acl-failed');
          }} :
          {readProcessStart:async()=> 'own'});
        await dep.link(()=>{});await dep.evaluate();return dep;
      }});
    cache.set(name,module);
    await module.link(async spec => {
      if(spec.startsWith('./'))return load(spec.slice(2));
      return synthetic(spec==='node:fs/promises'?fsp:spec==='node:path'?{default:path.posix}:await import(spec));
    });
    return module;
  }
  const module = await load(mode.startsWith('state')?'private-state.mjs':'broker-lock.mjs');
  await module.evaluate();
  if(mode.startsWith('state')) {
    await module.namespace.ensureStateDirectory(directory);
    assert.deepEqual(acl.map(c=>JSON.parse(JSON.stringify(c))),[
      {entries:[{path:directory,kind:'directory',created:mode==='state-created'}],options:{label:'desk_browser_state'}}]);
    return;
  }
  let entered=false;
  const operation=module.namespace.withBrokerLock(directory,()=>{entered=true},{
    readOwnIdentity:async()=> 'own',processIdentityReader:async()=>undefined,staleMs:0});
  if(['inode','device','fingerprint'].includes(mode)) {
    await assert.rejects(operation,e=>e.code==='STALE_BROKER_LOCK'&&e.details.ownerState==='unknown');
    assert.equal(entered,false);assert.equal(calls.some(c=>['rename','remove'].includes(c[0])),false);
  } else if(mode==='acl-failure') {
    await assert.rejects(operation,/fixture-acl-failed/);
    assert.equal(entered,false);assert.equal(files.size,0);
    assert.equal(calls.some(c=>c[0]==='remove'&&c[1]===lock),true);
  } else {
    await operation;assert.equal(entered,true);
    assert.equal(files.size,0);
    assert.ok(acl.some(c=>c.options.label==='desk_browser_lock'&&c.entries[0].kind==='file'&&c.entries[0].created===true));
    assert.ok(acl.some(c=>c.options.label==='desk_browser_state'&&c.entries[0].path===lock&&c.entries[0].created===false));
  }
}
for(const mode of ['inode','device','fingerprint','publish','acl-failure','state-created','state-existing'])await fixture(mode);
console.log('virtual-lock-and-acl-ok');
`;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15_000 });
  t.diagnostic(`owned virtual-fixture process pid=${result.pid}; exit=${result.status}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /virtual-lock-and-acl-ok/);
});
