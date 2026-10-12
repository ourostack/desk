import assert from 'node:assert/strict';
import {
  chmod,
  cp,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { ownIdentityReader, withBrokerLock } from '../../../../plugins/desk/browser-context-broker/src/lock.mjs';
import {
  readRegistry,
  reconcileContext,
  writeRegistry,
} from '../../../../plugins/desk/browser-context-broker/src/registry.mjs';

const scratchRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '.state',
);

async function stateDir() {
  const directory = path.join(scratchRoot, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

test.after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

test('GivenNativeWindowsLock_WhenUsingDefaultReader_PortableStartEvidenceIsUsed', async () => {
  const directory = await stateDir();
  const lockFile = new URL('../../../../plugins/desk/browser-context-broker/src/lock.mjs', import.meta.url).pathname;
  const script = `
    import vm from 'node:vm';
    import fs from 'node:fs/promises';
    const context = vm.createContext({ process: { pid: ${process.pid}, platform: 'win32' }, setTimeout, Date, console });
    const module = new vm.SourceTextModule(await fs.readFile(${JSON.stringify(lockFile)}, 'utf8'), {
      context, importModuleDynamically: async name => {
        const exports = name.endsWith('/process-start.js') ? { readProcessStart: async () => 'windows-start' } : { protectWindowsPaths: async () => {} };
        const dependency = new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
        await dependency.link(() => {}); await dependency.evaluate(); return dependency;
      },
    });
    await module.link(async name => {
      let exports;
      if (name === './registry.mjs') exports = { ensureStateDirectory: async () => {} };
      else if (name.endsWith('/process-start.js')) exports = { readProcessStart: async () => 'windows-start' };
      else if (name.endsWith('/windows-acl.js')) exports = { protectWindowsPaths: async () => {} };
      else if (name === './claims.mjs') exports = { BrokerError: class extends Error { constructor(code, text) { super(text); this.code = code; } } };
      else exports = await import(name);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    });
    await module.evaluate();
    await module.namespace.withBrokerLock(${JSON.stringify(directory)}, () => console.log('WINDOWS_DEFAULT_LOCK_ENTERED'));
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WINDOWS_DEFAULT_LOCK_ENTERED/u);
});

test('GivenWindowsState_WhenPosixBitsAreNotPrivate_NativeAclVerificationIsRequired', async () => {
  const directory = await stateDir();
  await chmod(directory, 0o755);
  const source = new URL('../../../../plugins/desk/browser-context-broker/src/registry.mjs', import.meta.url).pathname;
  const script = `
    import vm from 'node:vm';
    import fs from 'node:fs/promises';
    const context = vm.createContext({ process: { platform: 'win32' }, console });
    const module = new vm.SourceTextModule(await fs.readFile(${JSON.stringify(source)}, 'utf8'), {
      context, importModuleDynamically: async () => {
        const dependency = new vm.SyntheticModule(['protectWindowsPaths'], function () {
          this.setExport('protectWindowsPaths', async entries => {
            if (entries.length !== 1 || entries[0].path !== ${JSON.stringify(directory)} || entries[0].kind !== 'directory') throw Error('Wrong private state path');
            console.log('NATIVE_ACL_VERIFIED');
          });
        }, { context });
        await dependency.link(() => {}); await dependency.evaluate(); return dependency;
      },
    });
    await module.link(async name => {
      let exports;
      if (name.endsWith('/windows-acl.js')) exports = { protectWindowsPaths: async entries => {
        if (entries.length !== 1 || entries[0].path !== ${JSON.stringify(directory)} || entries[0].kind !== 'directory')
          throw Error('Wrong private state path');
        console.log('NATIVE_ACL_VERIFIED');
      } };
      else if (name === './claims.mjs') exports = { BrokerError: class extends Error { constructor(code, text) { super(text); this.code = code; } } };
      else exports = await import(name);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    });
    await module.evaluate();
    await module.namespace.ensureStateDirectory(${JSON.stringify(directory)});
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NATIVE_ACL_VERIFIED/u);
});

test('GivenStandalonePosixBroker_WhenStateModuleLoads_WindowsRuntimeIsNotAnEagerDependency', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await stateDir();
  const source = new URL('../../../../plugins/desk/browser-context-broker/src/', import.meta.url).pathname;
  await mkdir(path.join(directory, 'src'), { mode: 0o700 });
  for (const file of ['registry.mjs', 'claims.mjs']) await cp(path.join(source, file), path.join(directory, 'src', file));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { ensureStateDirectory } from ${JSON.stringify('file://' + path.join(directory, 'src/registry.mjs'))}; await ensureStateDirectory(${JSON.stringify(path.join(directory, 'state'))});`,
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

const declaration = {
  id: 'requested',
  claims: { surface: 'work' },
  launch: {
    executable: '/opt/browser',
    profileRoot: '/profiles/requested',
  },
};

const identity = {
  pid: 123,
  startIdentity: 'start-1',
  owner: 'operator',
  executable: '/opt/browser',
  profileRoot: '/profiles/requested',
};

function provider(attestation) {
  return async (operation, payload) => {
    assert.equal(operation, 'attest');
    assert.equal(payload.declaration.id, 'requested');
    return attestation;
  };
}

test('writeRegistry uses an atomic replacement and leaves no partial files', async () => {
  const directory = await stateDir();
  const registry = {
    version: 1,
    contexts: {
      requested: { contextId: 'requested', processIdentity: identity },
      unrelated: { contextId: 'unrelated', endpoint: 'http://127.0.0.1:41001' },
    },
    leases: {},
  };

  await writeRegistry(directory, registry);

  assert.deepEqual(await readRegistry(directory), registry);
  assert.deepEqual((await readdir(directory)).sort(), ['registry.json']);
  assert.equal((await stat(path.join(directory, 'registry.json'))).mode & 0o077, 0);
});

test('withBrokerLock serializes writers and removes its exact lock', async () => {
  const directory = await stateDir();
  const order = [];
  let releaseFirst;
  let firstEntered;
  const firstHeld = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise((resolve) => {
    firstEntered = resolve;
  });

  const first = withBrokerLock(directory, async () => {
    order.push('first-start');
    firstEntered();
    await firstHeld;
    order.push('first-end');
  });
  await firstStarted;
  const second = withBrokerLock(directory, async () => {
    order.push('second');
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.deepEqual(await readdir(directory), []);
});

test('withBrokerLock removes a just-created lock directory when owner publication fails', async () => {
  const directory = await stateDir();
  let entered = false;

  await assert.rejects(
    withBrokerLock(directory, async () => {
      entered = true;
    }, {
      ownerPublisher: async (lockPath) => {
        await writeFile(path.join(lockPath, '.owner-crash.tmp'), '{', {
          mode: 0o600,
        });
        throw Object.assign(new Error('simulated owner write failure'), {
          code: 'EIO',
        });
      },
    }),
    /simulated owner write failure/u,
  );

  assert.equal(entered, false);
  assert.deepEqual(await readdir(directory), []);
  await withBrokerLock(directory, async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

for (const ownerState of ['missing', 'malformed']) {
  test(`withBrokerLock reclaims a stale ${ownerState} owner after initialization grace`, async () => {
    const directory = await stateDir();
    const lockPath = path.join(directory, 'broker.lock');
    await mkdir(lockPath, { mode: 0o700 });
    if (ownerState === 'malformed') {
      await writeFile(path.join(lockPath, 'owner.json'), '{', { mode: 0o600 });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    let entered = false;

    await withBrokerLock(directory, async () => {
      entered = true;
    }, {
      staleMs: 10,
      processIdentityReader: async () => 'current-generation',
    });

    assert.equal(entered, true);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('withBrokerLock does not reclaim a missing owner during initialization grace', async () => {
  const directory = await stateDir();
  const lockPath = path.join(directory, 'broker.lock');
  await mkdir(lockPath, { mode: 0o700 });

  await assert.rejects(
    withBrokerLock(directory, async () => {}, {
      timeoutMs: 20,
      pollMs: 2,
      staleMs: 60_000,
      processIdentityReader: async () => 'current-generation',
    }),
    (error) => error.code === 'BROKER_LOCK_TIMEOUT',
  );
  assert.deepEqual(await readdir(directory), ['broker.lock']);
});

test('withBrokerLock preserves a stale initializing lock with a live exact temp owner', async () => {
  const directory = await stateDir();
  const lockPath = path.join(directory, 'broker.lock');
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, '.owner-live.tmp'),
    JSON.stringify({
      token: 'live-owner',
      pid: process.pid,
      startIdentity: 'live-generation',
      createdAt: new Date(0).toISOString(),
    }),
    { mode: 0o600 },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  await assert.rejects(
    withBrokerLock(directory, async () => {}, {
      staleMs: 1,
      processIdentityReader: async () => 'live-generation',
    }),
    (error) =>
      error.code === 'STALE_BROKER_LOCK' &&
      error.details.ownerState === 'alive',
  );
  assert.deepEqual(await readdir(lockPath), ['.owner-live.tmp']);
});

test('withBrokerLock reclaims a stale lock after proving its PID is a different generation', async () => {
  const directory = await stateDir();
  const lockPath = path.join(directory, 'broker.lock');
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      token: 'stale-owner',
      pid: process.pid,
      startIdentity: 'prior-generation',
      createdAt: new Date(0).toISOString(),
    }),
    { mode: 0o600 },
  );
  let entered = false;

  await withBrokerLock(
    directory,
    async () => {
      entered = true;
    },
    {
      staleMs: 0,
      processIdentityReader: async (pid) => {
        assert.equal(pid, process.pid);
        return 'current-generation';
      },
    },
  );

  assert.equal(entered, true);
  assert.deepEqual(await readdir(directory), []);
});

for (const [ownerState, createProcessIdentityReader] of [
  ['alive', () => async () => 'exact-generation'],
  ['unknown', () => {
    let calls = 0;
    return async () => {
      calls += 1;
      if (calls === 1) return 'exact-generation';
      throw new Error('process inspection unavailable');
    };
  }],
]) {
  test(`withBrokerLock fails closed when a stale owner generation is ${ownerState}`, async () => {
    const directory = await stateDir();
    const lockPath = path.join(directory, 'broker.lock');
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({
        token: 'stale-owner',
        pid: process.pid,
        startIdentity: 'exact-generation',
        createdAt: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );

    await assert.rejects(
      withBrokerLock(directory, async () => {}, {
        staleMs: 0,
        processIdentityReader: createProcessIdentityReader(),
      }),
      (error) =>
        error.code === 'STALE_BROKER_LOCK' &&
        error.details.ownerState === ownerState,
    );
  });
}

test('the own start identity is read again once after a failed read, then kept', async () => {
  const reads = [];
  const answers = [new Error('powershell timed out'), 'win32:2026-10-12T04:07:45.000Z'];
  const readOwn = ownIdentityReader(async (pid) => {
    reads.push(pid);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }, { pid: 4242 });

  assert.equal(await readOwn(), 'win32:2026-10-12T04:07:45.000Z');
  assert.equal(await readOwn(), 'win32:2026-10-12T04:07:45.000Z');
  assert.deepEqual(reads, [4242, 4242]);
});

test('an own start identity that cannot be read twice is reported, and not kept', async () => {
  let reads = 0;
  const readOwn = ownIdentityReader(async () => {
    reads += 1;
    if (reads <= 2) return undefined;
    return 'darwin:2026-10-12T04:07:45.000Z';
  });

  assert.equal(await readOwn(), undefined);
  assert.equal(await readOwn(), 'darwin:2026-10-12T04:07:45.000Z');
  assert.equal(reads, 3);
});

test('concurrent first lock acquisitions share one own identity read', async () => {
  const directory = await stateDir();
  let reads = 0;
  const readOwnIdentity = ownIdentityReader(async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'shared-generation';
  });
  const entered = [];
  await Promise.all(['first', 'second', 'third'].map((label) => withBrokerLock(directory, async () => {
    entered.push(label);
  }, { name: label, readOwnIdentity })));
  await withBrokerLock(directory, async () => entered.push('later'), { readOwnIdentity });

  assert.equal(reads, 1);
  assert.deepEqual(entered.sort(), ['first', 'later', 'second', 'third']);
});

test('the lock wait starts after a slow own identity read', async () => {
  const directory = await stateDir();
  const lockPath = path.join(directory, 'broker.lock');
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({
      token: 'held',
      pid: process.pid,
      startIdentity: 'holder-generation',
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const started = Date.now();

  await assert.rejects(
    withBrokerLock(directory, async () => {}, {
      timeoutMs: 150,
      pollMs: 5,
      readOwnIdentity: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'waiting-generation';
      },
    }),
    (error) => error.code === 'BROKER_LOCK_TIMEOUT',
  );
  // 200 ms reading, then the whole 150 ms wait. Counting the read against the wait would give up after about 200 ms.
  assert.ok(Date.now() - started >= 340, `gave up after ${Date.now() - started} ms`);
});

test('readRegistry rejects a state directory accessible by other users', async () => {
  const directory = await stateDir();
  await chmod(directory, 0o755);
  await assert.rejects(
    readRegistry(directory),
    (error) => error.code === 'INSECURE_STATE_DIRECTORY',
  );
});

test('reconcileContext removes a stale observation when the process is absent', async () => {
  const result = await reconcileContext(
    declaration,
    { contextId: 'requested', processIdentity: identity },
    provider({ healthy: false, reason: 'PROCESS_ABSENT' }),
  );

  assert.deepEqual(result, {
    status: 'absent',
    reason: 'PROCESS_ABSENT',
    discardObservation: true,
  });
});

test('reconcileContext rejects PID reuse through start identity mismatch', async () => {
  const result = await reconcileContext(
    declaration,
    { contextId: 'requested', processIdentity: identity },
    provider({
      healthy: true,
      endpoint: 'http://127.0.0.1:41000',
      processIdentity: { ...identity, startIdentity: 'start-2' },
    }),
  );

  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'PROCESS_IDENTITY_MISMATCH');
  assert.equal(result.discardObservation, true);
});

for (const [name, replacement] of [
  ['profile root', { profileRoot: '/profiles/other' }],
  ['owner', { owner: 'someone-else' }],
  ['executable', { executable: '/opt/other-browser' }],
]) {
  test(`reconcileContext rejects mismatched ${name}`, async () => {
    const result = await reconcileContext(
      declaration,
      { contextId: 'requested', processIdentity: identity },
      provider({
        healthy: true,
        endpoint: 'http://127.0.0.1:41000',
        processIdentity: { ...identity, ...replacement },
      }),
    );

    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'PROCESS_IDENTITY_MISMATCH');
  });
}

test('reconcileContext rejects an endpoint not correlated to the attested process', async () => {
  const result = await reconcileContext(
    declaration,
    { contextId: 'requested', processIdentity: identity },
    provider({
      healthy: true,
      endpoint: 'http://127.0.0.1:41000',
      endpointProcessIdentity: { pid: 999, startIdentity: 'other' },
      processIdentity: identity,
    }),
  );

  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'ENDPOINT_PROCESS_MISMATCH');
});

test('reconcileContext accepts only fresh complete attestation', async () => {
  const result = await reconcileContext(
    declaration,
    { contextId: 'requested', processIdentity: identity },
    provider({
      healthy: true,
      endpoint: 'http://127.0.0.1:41000',
      endpointProcessIdentity: {
        pid: identity.pid,
        startIdentity: identity.startIdentity,
      },
      processIdentity: identity,
    }),
  );

  assert.equal(result.status, 'healthy');
  assert.equal(result.endpoint, 'http://127.0.0.1:41000');
  assert.deepEqual(result.processIdentity, identity);
});

test('updating one context preserves unrelated registry records', async () => {
  const directory = await stateDir();
  const registry = {
    version: 1,
    contexts: {
      requested: { contextId: 'requested', endpoint: 'old' },
      unrelated: { contextId: 'unrelated', endpoint: 'keep' },
    },
    leases: {},
  };
  await writeRegistry(directory, registry);

  await withBrokerLock(directory, async () => {
    const current = await readRegistry(directory);
    current.contexts.requested = { contextId: 'requested', endpoint: 'new' };
    await writeRegistry(directory, current);
  });

  assert.equal((await readRegistry(directory)).contexts.unrelated.endpoint, 'keep');
});

const entryIdentity = {
  pid: 124,
  startIdentity: 'entry-1',
  owner: identity.owner,
  executable: '/opt/desk-native',
  profileRoot: '/runtime/desk',
  parentPid: identity.pid,
};
const runtimeIdentity = {
  pid: 125,
  startIdentity: 'runtime-1',
  owner: identity.owner,
  executable: '/opt/node',
  profileRoot: '/runtime/desk',
  parentPid: entryIdentity.pid,
};
const mediatedDeclaration = {
  ...declaration,
  mediation: {
    entryExecutable: entryIdentity.executable,
    runtimeExecutable: runtimeIdentity.executable,
  },
};
const mediatedObservation = {
  contextId: declaration.id,
  processIdentity: identity,
  mediationChain: [entryIdentity, runtimeIdentity],
};
const mediatedAttestation = {
  healthy: true,
  endpoint: 'http://127.0.0.1:41000',
  processIdentity: identity,
  endpointProcessIdentity: runtimeIdentity,
  mediationChain: [entryIdentity, runtimeIdentity],
};

test('GivenExactMediatedChain_WhenAttested_ReconcileAcceptsBrowserAndRuntime', async () => {
  const result = await reconcileContext(
    mediatedDeclaration,
    mediatedObservation,
    provider(mediatedAttestation),
  );
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.processIdentity, identity);
  assert.deepEqual(result.mediationChain, mediatedObservation.mediationChain);
});

for (const field of ['pid', 'startIdentity', 'owner', 'executable', 'profileRoot', 'parentPid']) {
  for (const hop of [0, 1]) {
    test(`GivenMediatedChain_WhenHop${hop}${field}Changes_ReconcileRejects`, async () => {
      const chain = structuredClone(mediatedAttestation.mediationChain);
      chain[hop][field] = typeof chain[hop][field] === 'number' ? 999 : 'changed';
      const result = await reconcileContext(
        mediatedDeclaration,
        mediatedObservation,
        provider({ ...mediatedAttestation, mediationChain: chain }),
      );
      assert.equal(result.status, 'invalid');
      assert.equal(result.reason, 'MEDIATION_IDENTITY_MISMATCH');
      assert.equal(result.discardObservation, false);
    });
  }
}

for (const chain of [undefined, [], [entryIdentity], [runtimeIdentity, entryIdentity]]) {
  test(`GivenMediatedChain_WhenChain${chain?.length ?? 'Missing'}IsIncomplete_ReconcileRejects`, async () => {
    const result = await reconcileContext(
      mediatedDeclaration,
      mediatedObservation,
      provider({ ...mediatedAttestation, mediationChain: chain }),
    );
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'MEDIATION_IDENTITY_MISMATCH');
  });
}

test('GivenMediatedChain_WhenListenerIsNotRuntime_ReconcileRejects', async () => {
  const result = await reconcileContext(
    mediatedDeclaration,
    mediatedObservation,
    provider({ ...mediatedAttestation, endpointProcessIdentity: entryIdentity }),
  );
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'ENDPOINT_PROCESS_MISMATCH');
  assert.equal(result.discardObservation, false);
});

for (const reason of ['MEDIATOR_UNAVAILABLE', 'ENDPOINT_UNAVAILABLE', 'PROCESS_ABSENT']) {
  test(`GivenLiveBrowser_When${reason}LacksAbsenceProof_ReconcileRetainsOwnership`, async () => {
    const result = await reconcileContext(
      mediatedDeclaration,
      mediatedObservation,
      provider({ healthy: false, reason }),
    );
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, reason);
    assert.equal(result.discardObservation, false);
  });
}

test('GivenMediatedContext_WhenExactBrowserGenerationAbsent_ReconcileAllowsStaleRemoval', async () => {
  const result = await reconcileContext(
    mediatedDeclaration,
    mediatedObservation,
    provider({
      healthy: false,
      reason: 'PROCESS_ABSENT',
      browserAbsence: { expectedProcessIdentity: identity, confirmed: true },
    }),
  );
  assert.equal(result.status, 'absent');
  assert.equal(result.discardObservation, true);
});

for (const absence of [
  { expectedProcessIdentity: { ...identity, startIdentity: 'other' }, confirmed: true },
  { expectedProcessIdentity: identity, confirmed: false },
  { confirmed: true },
]) {
  test('GivenMediatedContext_WhenAbsenceProofIsNotExact_ReconcileRetainsOwnership', async () => {
    const result = await reconcileContext(
      mediatedDeclaration,
      mediatedObservation,
      provider({ healthy: false, reason: 'PROCESS_ABSENT', browserAbsence: absence }),
    );
    assert.equal(result.status, 'invalid');
    assert.equal(result.discardObservation, false);
  });
}
