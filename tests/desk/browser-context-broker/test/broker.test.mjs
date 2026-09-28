import assert from 'node:assert/strict';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { acquireContext, acquireLease } from '../src/broker.mjs';
import { invokeProvider } from '../src/provider.mjs';
import { readRegistry, writeRegistry } from '../src/registry.mjs';

const providerFixture = new URL('./fixtures/json-provider.mjs', import.meta.url);
const scratchRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '.broker-state',
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

const requestedDeclaration = {
  id: 'requested',
  claims: {
    surface: 'work',
    identity: 'requested@example.test',
    persistence: 'persistent',
  },
  launch: {
    executable: '/opt/browser',
    profileRoot: '/profiles/requested',
  },
};

const unrelatedDeclaration = {
  id: 'unrelated',
  claims: {
    surface: 'work',
    identity: 'unrelated@example.test',
    persistence: 'persistent',
  },
  launch: {
    executable: '/opt/browser',
    profileRoot: '/profiles/unrelated',
  },
};

const config = {
  contexts: [requestedDeclaration, unrelatedDeclaration],
  endpoint: { host: '127.0.0.1' },
};

const recoverableConfig = {
  ...config,
  contexts: [
    {
      ...requestedDeclaration,
      recovery: {
        restart: true,
      },
    },
    unrelatedDeclaration,
  ],
};

function processIdentity(declaration, pid = 100) {
  return {
    pid,
    startIdentity: `start-${pid}`,
    owner: 'operator',
    executable: declaration.launch.executable,
    profileRoot: declaration.launch.profileRoot,
  };
}

function healthy(declaration, endpoint, pid = 100) {
  const identity = processIdentity(declaration, pid);
  return {
    healthy: true,
    endpoint,
    processIdentity: identity,
    endpointProcessIdentity: {
      pid: identity.pid,
      startIdentity: identity.startIdentity,
    },
  };
}

test('ignores an unrelated lower-endpoint browser and provisions the absent requested context', async () => {
  const directory = await stateDir();
  await writeRegistry(directory, {
    version: 1,
    contexts: {
      unrelated: {
        contextId: 'unrelated',
        endpoint: 'http://127.0.0.1:40000',
        processIdentity: processIdentity(unrelatedDeclaration, 200),
      },
    },
    leases: {},
  });
  const operations = [];
  const providerInvoker = async (operation, payload) => {
    operations.push({ operation, contextId: payload.declaration.id, endpoint: payload.endpoint });
    assert.equal(payload.declaration.id, 'requested');
    if (operation === 'discover') return { found: false };
    if (operation === 'launch') {
      return {
        observation: {
          contextId: 'requested',
          endpoint: payload.endpoint,
          processIdentity: processIdentity(requestedDeclaration, 300),
        },
      };
    }
    if (operation === 'attest') return healthy(requestedDeclaration, payload.observation.endpoint, 300);
    throw new Error(`unexpected operation ${operation}`);
  };

  const result = await acquireContext({
    config,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    providerInvoker,
    endpointAllocator: async () => 'http://127.0.0.1:45000',
  });

  assert.equal(result.context.id, 'requested');
  assert.equal(result.rawEndpoint, 'http://127.0.0.1:45000');
  assert.equal(result.recovery, 'provisioned');
  assert.deepEqual(
    operations.map(({ operation }) => operation),
    ['discover', 'launch', 'attest'],
  );
  assert.equal((await readRegistry(directory)).contexts.unrelated.endpoint, 'http://127.0.0.1:40000');
});

test('reuses a freshly discovered requested context regardless of endpoint ordering', async () => {
  const directory = await stateDir();
  const observation = {
    contextId: 'requested',
    endpoint: 'http://127.0.0.1:49999',
    processIdentity: processIdentity(requestedDeclaration, 500),
  };
  const operations = [];

  const result = await acquireContext({
    config,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    providerInvoker: async (operation, payload) => {
      operations.push(operation);
      if (operation === 'discover') return { found: true, observation };
      if (operation === 'attest') return healthy(requestedDeclaration, observation.endpoint, 500);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.rawEndpoint, observation.endpoint);
  assert.equal(result.recovery, 'reused');
  assert.deepEqual(operations, ['discover', 'attest']);
});

test('retries with a new dynamic endpoint after a collision', async () => {
  const directory = await stateDir();
  const endpoints = ['http://127.0.0.1:45001', 'http://127.0.0.1:45002'];
  let launchCount = 0;

  const result = await acquireContext({
    config,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => endpoints.shift(),
    providerInvoker: async (operation, payload) => {
      if (operation === 'discover') return { found: false };
      if (operation === 'launch') {
        launchCount += 1;
        if (launchCount === 1) return { ok: false, code: 'ENDPOINT_COLLISION' };
        return {
          observation: {
            contextId: 'requested',
            endpoint: payload.endpoint,
            processIdentity: processIdentity(requestedDeclaration, 600),
          },
        };
      }
      if (operation === 'attest') return healthy(requestedDeclaration, payload.observation.endpoint, 600);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.rawEndpoint, 'http://127.0.0.1:45002');
  assert.equal(launchCount, 2);
});

test('retries after an ENDPOINT_COLLISION reported through provider IPC', async () => {
  const directory = await stateDir();
  const endpoints = ['http://127.0.0.1:45011', 'http://127.0.0.1:45012'];

  const result = await acquireContext({
    config,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => endpoints.shift(),
    providerInvoker: (operation, payload) =>
      invokeProvider(process.execPath, operation, {
        ...payload,
        fixture: 'broker-retry',
      }, {
        args: [providerFixture.pathname],
      }),
  });

  assert.equal(result.rawEndpoint, 'http://127.0.0.1:45012');
});

test('preserves a precise unsupported recovery diagnostic from provider IPC', async () => {
  const directory = await stateDir();
  const observation = {
    contextId: 'requested',
    endpoint: 'http://127.0.0.1:45100',
    processIdentity: processIdentity(requestedDeclaration, 651),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: observation },
    leases: {},
  });

  await assert.rejects(
    acquireContext({
      config,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: (operation, payload) =>
        invokeProvider(process.execPath, operation, {
          ...payload,
          fixture: 'broker-unsupported-recovery',
        }, {
          args: [providerFixture.pathname],
        }),
    }),
    (error) =>
      error.code === 'UNSUPPORTED_CONTEXT_RECOVERY' &&
      error.message === 'Existing context cannot be recovered by this provider' &&
      error.details.contextId === 'requested' &&
      error.details.reason === 'PROFILE_VERSION_MISMATCH',
  );
});

test('repairs stale registry state only for the requested context', async () => {
  const directory = await stateDir();
  await writeRegistry(directory, {
    version: 1,
    contexts: {
      requested: {
        contextId: 'requested',
        endpoint: 'http://127.0.0.1:41000',
        processIdentity: processIdentity(requestedDeclaration, 700),
      },
      unrelated: {
        contextId: 'unrelated',
        endpoint: 'http://127.0.0.1:41001',
        processIdentity: processIdentity(unrelatedDeclaration, 701),
      },
    },
    leases: {},
  });
  let launched = false;

  const result = await acquireContext({
    config: {
      ...config,
      contexts: config.contexts.map((declaration) =>
        declaration.id === 'requested'
          ? { ...declaration, recovery: { restart: true } }
          : declaration),
    },
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => 'http://127.0.0.1:46000',
    providerInvoker: async (operation, payload) => {
      if (operation === 'discover') return { found: true, observation: payload.observation };
      if (operation === 'attest' && !launched) return { healthy: false, reason: 'PROCESS_ABSENT' };
      if (operation === 'recover' && payload.mode === 'restart') {
        launched = true;
        return {
          observation: {
            contextId: 'requested',
            endpoint: payload.endpoint,
            processIdentity: processIdentity(requestedDeclaration, 702),
          },
        };
      }
      if (operation === 'attest') return healthy(requestedDeclaration, payload.observation.endpoint, 702);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.recovery, 'restarted');
  const registry = await readRegistry(directory);
  assert.equal(registry.contexts.requested.endpoint, 'http://127.0.0.1:46000');
  assert.equal(registry.contexts.unrelated.endpoint, 'http://127.0.0.1:41001');
});

test('does not publish a launch that fails attestation', async () => {
  const directory = await stateDir();
  await assert.rejects(
    acquireContext({
      config,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      endpointAllocator: async () => 'http://127.0.0.1:47000',
      providerInvoker: async (operation, payload) => {
        if (operation === 'discover') return { found: false };
        if (operation === 'launch') {
          return {
            observation: {
              contextId: 'requested',
              endpoint: payload.endpoint,
              processIdentity: processIdentity(requestedDeclaration, 800),
            },
          };
        }
        if (operation === 'attest') return { healthy: false, reason: 'VISIBLE_CLAIM_MISMATCH' };
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) =>
      error.code === 'LAUNCH_ATTESTATION_FAILED' &&
      error.details.reason === 'VISIBLE_CLAIM_MISMATCH',
  );
  assert.equal((await readRegistry(directory)).contexts.requested, undefined);
});

test('context lock paths remain confined when a declaration ID contains path syntax', async () => {
  const directory = await stateDir();
  const unusualDeclaration = {
    ...requestedDeclaration,
    id: '../requested/context',
  };
  const unusualConfig = { contexts: [unusualDeclaration] };

  const result = await acquireContext({
    config: unusualConfig,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => 'http://127.0.0.1:48000',
    providerInvoker: async (operation, payload) => {
      if (operation === 'discover') return { found: false };
      if (operation === 'launch') {
        return {
          observation: {
            contextId: unusualDeclaration.id,
            endpoint: payload.endpoint,
            processIdentity: processIdentity(unusualDeclaration, 901),
          },
        };
      }
      if (operation === 'attest') return healthy(unusualDeclaration, payload.observation.endpoint, 901);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.context.id, unusualDeclaration.id);
});

test('acquireLease keeps the context lock until the lease exists', async () => {
  const directory = await stateDir();
  const observation = {
    contextId: 'requested',
    endpoint: 'http://127.0.0.1:49000',
    processIdentity: processIdentity(requestedDeclaration, 1001),
  };
  let releaseFirstLease;
  let firstLeaseStarted;
  const firstLeaseGate = new Promise((resolve) => { releaseFirstLease = resolve; });
  const firstLeaseEntered = new Promise((resolve) => { firstLeaseStarted = resolve; });
  const operations = [];
  let leaseNumber = 0;
  const options = {
    config,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    providerInvoker: async (operation) => {
      operations.push(operation);
      if (operation === 'discover') return { found: true, observation };
      if (operation === 'attest') return healthy(requestedDeclaration, observation.endpoint, 1001);
      throw new Error(`unexpected operation ${operation}`);
    },
    leaseCreator: async ({ owner }) => {
      leaseNumber += 1;
      if (owner === 'agent-a') {
        firstLeaseStarted();
        await firstLeaseGate;
      }
      return { id: `lease-${leaseNumber}` };
    },
  };

  const first = acquireLease({ ...options, owner: 'agent-a' });
  await firstLeaseEntered;
  let secondSettled = false;
  const second = acquireLease({ ...options, owner: 'agent-b' })
    .finally(() => { secondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(secondSettled, false);
  assert.deepEqual(operations, ['discover', 'attest']);

  releaseFirstLease();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.notEqual(firstResult.lease.id, secondResult.lease.id);
  assert.deepEqual(operations, ['discover', 'attest', 'discover', 'attest']);
});

test('recovers an unhealthy exact context destructively only when no active lease exists', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const oldObservation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49100',
    processIdentity: processIdentity(declaration, 1101),
  };
  const newObservation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49101',
    processIdentity: processIdentity(declaration, 1102),
  };
  const operations = [];

  const result = await acquireContext({
    config: recoverableConfig,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => newObservation.endpoint,
    providerInvoker: async (operation, payload) => {
      operations.push(`${operation}${payload.mode ? `:${payload.mode}` : ''}`);
      if (operation === 'discover') return { found: true, observation: oldObservation };
      if (operation === 'attest' && payload.observation.processIdentity.pid === 1101) {
        return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
      }
      if (operation === 'recover' && payload.mode === 'non-destructive') {
        return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
      }
      if (operation === 'recover' && payload.mode === 'restart') {
        assert.equal(payload.endpoint, newObservation.endpoint);
        return { recovered: true, mode: 'restart', observation: newObservation };
      }
      if (operation === 'attest') return healthy(declaration, newObservation.endpoint, 1102);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.rawEndpoint, newObservation.endpoint);
  assert.equal(result.recovery, 'restarted');
  assert.deepEqual(operations, [
    'discover',
    'attest',
    'recover:non-destructive',
    'recover:restart',
    'attest',
  ]);
});

test('returns active lease owners instead of restarting an unhealthy shared context', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49200',
    processIdentity: processIdentity(declaration, 1201),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: observation },
    leases: {
      'lease-active': {
        id: 'lease-active',
        contextId: declaration.id,
        owner: 'agent-a',
        processIdentity: observation.processIdentity,
        targetIds: ['target-a'],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });
  const operations = [];

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation, payload) => {
        operations.push(`${operation}${payload.mode ? `:${payload.mode}` : ''}`);
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
        if (operation === 'recover') {
          return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => {
      assert.equal(error.code, 'CONTEXT_RECOVERY_CONFLICT');
      assert.equal(error.details.contextId, declaration.id);
      assert.equal(error.details.reason, 'ENDPOINT_UNHEALTHY');
      assert.deepEqual(error.details.leases, [{
        leaseId: 'lease-active',
        owner: 'agent-a',
        heartbeatAt: error.details.leases[0].heartbeatAt,
        expiresAt: error.details.leases[0].expiresAt,
        targetCount: 1,
        releasing: false,
        processGenerationMatch: true,
      }]);
      return true;
    },
  );
  assert.deepEqual(operations, ['discover', 'attest', 'recover:non-destructive']);
});

test('an active lease from a different process generation still blocks destructive recovery', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49210',
    processIdentity: processIdentity(declaration, 1211),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: observation },
    leases: {
      'lease-old-generation': {
        id: 'lease-old-generation',
        contextId: declaration.id,
        owner: 'agent-old',
        processIdentity: processIdentity(declaration, 1210),
        targetIds: [],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
        if (operation === 'recover') {
          return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) =>
      error.code === 'CONTEXT_RECOVERY_CONFLICT' &&
      error.details.leases[0].processGenerationMatch === false,
  );
});

test('expired leases do not block destructive recovery', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const oldObservation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49220',
    processIdentity: processIdentity(declaration, 1221),
  };
  const newObservation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49221',
    processIdentity: processIdentity(declaration, 1222),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: oldObservation },
    leases: {
      expired: {
        id: 'expired',
        contextId: declaration.id,
        owner: 'agent-expired',
        processIdentity: oldObservation.processIdentity,
        targetIds: [],
        heartbeatAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
      },
    },
  });

  const result = await acquireContext({
    config: recoverableConfig,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => newObservation.endpoint,
    providerInvoker: async (operation, payload) => {
      if (operation === 'discover') return { found: true, observation: oldObservation };
      if (operation === 'attest' && payload.observation.processIdentity.pid === 1221) {
        return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
      }
      if (operation === 'recover' && payload.mode === 'non-destructive') {
        return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
      }
      if (operation === 'recover') {
        return { recovered: true, mode: 'restart', observation: newObservation };
      }
      if (operation === 'attest') return healthy(declaration, newObservation.endpoint, 1222);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.recovery, 'restarted');
});

test('a releasing lease blocks destructive recovery until release completes', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49225',
    processIdentity: processIdentity(declaration, 1225),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: observation },
    leases: {
      releasing: {
        id: 'releasing',
        contextId: declaration.id,
        owner: 'agent-releasing',
        processIdentity: observation.processIdentity,
        targetIds: ['target-being-closed'],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        releasing: true,
      },
    },
  });

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
        if (operation === 'recover') {
          return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) =>
      error.code === 'CONTEXT_RECOVERY_CONFLICT' &&
      error.details.leases[0].leaseId === 'releasing' &&
      error.details.leases[0].releasing === true,
  );
});

test('a missing previously observed context cannot bypass non-destructive recovery mode', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  await writeRegistry(directory, {
    version: 1,
    contexts: {
      requested: {
        contextId: declaration.id,
        endpoint: 'http://127.0.0.1:49226',
        processIdentity: processIdentity(declaration, 1226),
      },
    },
    leases: {},
  });
  const operations = [];

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      recoveryMode: 'non-destructive',
      providerInvoker: async (operation) => {
        operations.push(operation);
        if (operation === 'discover') return { found: false };
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => error.code === 'DESTRUCTIVE_RECOVERY_DISABLED',
  );
  assert.deepEqual(operations, ['discover']);
});

test('a missing context with an active lease cannot launch a replacement', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const previousIdentity = processIdentity(declaration, 1227);
  await writeRegistry(directory, {
    version: 1,
    contexts: {},
    leases: {
      active: {
        id: 'active',
        contextId: declaration.id,
        owner: 'agent-active',
        processIdentity: previousIdentity,
        targetIds: ['owned-target'],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        if (operation === 'discover') return { found: false };
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) =>
      error.code === 'CONTEXT_RECOVERY_CONFLICT' &&
      error.details.leases[0].leaseId === 'active',
  );
});

test('absent-context recovery sees a lease renewed during discovery', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const previousIdentity = processIdentity(declaration, 1228);
  await writeRegistry(directory, {
    version: 1,
    contexts: {
      requested: {
        contextId: declaration.id,
        endpoint: 'http://127.0.0.1:49228',
        processIdentity: previousIdentity,
      },
    },
    leases: {
      renewing: {
        id: 'renewing',
        contextId: declaration.id,
        owner: 'agent-renewing',
        processIdentity: previousIdentity,
        targetIds: ['renewing-target'],
        heartbeatAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
      },
    },
  });

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        if (operation !== 'discover') throw new Error(`unexpected operation ${operation}`);
        const current = await readRegistry(directory);
        current.leases.renewing.heartbeatAt = new Date().toISOString();
        current.leases.renewing.expiresAt = new Date(Date.now() + 60_000).toISOString();
        await writeRegistry(directory, current);
        return { found: false };
      },
    }),
    (error) =>
      error.code === 'CONTEXT_RECOVERY_CONFLICT' &&
      error.details.leases[0].leaseId === 'renewing',
  );
});

test('retries destructive recovery on a provider-reported endpoint collision', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const oldObservation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49230',
    processIdentity: processIdentity(declaration, 1231),
  };
  const endpoints = ['http://127.0.0.1:49231', 'http://127.0.0.1:49232'];
  let restartAttempt = 0;

  const result = await acquireContext({
    config: recoverableConfig,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    endpointAllocator: async () => endpoints.shift(),
    providerInvoker: async (operation, payload) => {
      if (operation === 'discover') return { found: true, observation: oldObservation };
      if (operation === 'attest' && payload.observation.processIdentity.pid === 1231) {
        return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
      }
      if (operation === 'recover' && payload.mode === 'non-destructive') {
        return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
      }
      if (operation === 'recover') {
        restartAttempt += 1;
        if (restartAttempt === 1) {
          const error = new Error('collision');
          error.code = 'ENDPOINT_COLLISION';
          throw error;
        }
        const observation = {
          contextId: declaration.id,
          endpoint: payload.endpoint,
          processIdentity: processIdentity(declaration, 1232),
        };
        return { recovered: true, mode: 'restart', observation };
      }
      if (operation === 'attest') return healthy(declaration, payload.observation.endpoint, 1232);
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(restartAttempt, 2);
  assert.equal(result.rawEndpoint, 'http://127.0.0.1:49232');
  assert.equal((await readRegistry(directory)).contexts.requested.endpoint, result.rawEndpoint);
});

test('reuses a context restored by non-destructive recovery with active leases', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49300',
    processIdentity: processIdentity(declaration, 1301),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: observation },
    leases: {
      'lease-active': {
        id: 'lease-active',
        contextId: declaration.id,
        owner: 'agent-a',
        processIdentity: observation.processIdentity,
        targetIds: [],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });
  let attestationCount = 0;

  const result = await acquireContext({
    config: recoverableConfig,
    request: { surface: 'work', identity: 'requested@example.test' },
    stateDir: directory,
    providerInvoker: async (operation, payload) => {
      if (operation === 'discover') return { found: true, observation };
      if (operation === 'attest') {
        attestationCount += 1;
        return attestationCount === 1
          ? { healthy: false, reason: 'ENDPOINT_UNHEALTHY' }
          : healthy(declaration, observation.endpoint, 1301);
      }
      if (operation === 'recover') {
        assert.equal(payload.mode, 'non-destructive');
        return { recovered: true, mode: 'non-destructive', observation };
      }
      throw new Error(`unexpected operation ${operation}`);
    },
  });

  assert.equal(result.recovery, 'reconnected');
  assert.equal(result.rawEndpoint, observation.endpoint);
});

test('rejects non-destructive recovery that changes the process generation', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49310',
    processIdentity: processIdentity(declaration, 1311),
  };
  let attestationCount = 0;

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation, payload) => {
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') {
          attestationCount += 1;
          return attestationCount === 1
            ? { healthy: false, reason: 'ENDPOINT_UNHEALTHY' }
            : healthy(declaration, payload.observation.endpoint, 1312);
        }
        if (operation === 'recover') {
          return {
            recovered: true,
            mode: 'non-destructive',
            observation: {
              ...observation,
              processIdentity: processIdentity(declaration, 1312),
            },
          };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => error.code === 'RECOVERY_PROCESS_CHANGED',
  );
});

test('fails closed on endpoint-process mismatch instead of launching beside an active lease', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49320',
    processIdentity: processIdentity(declaration, 1321),
  };
  await writeRegistry(directory, {
    version: 1,
    contexts: { requested: observation },
    leases: {
      'lease-active': {
        id: 'lease-active',
        contextId: declaration.id,
        owner: 'agent-a',
        processIdentity: observation.processIdentity,
        targetIds: [],
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });
  const operations = [];

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        operations.push(operation);
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') {
          return { healthy: false, reason: 'ENDPOINT_PROCESS_MISMATCH' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) =>
      error.code === 'LAUNCH_ATTESTATION_FAILED' &&
      error.details.reason === 'ENDPOINT_PROCESS_MISMATCH',
  );
  assert.deepEqual(operations, ['discover', 'attest']);
});

test('never restarts a context when browser-visible claims require human auth', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49400',
    processIdentity: processIdentity(declaration, 1401),
  };
  const operations = [];

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        operations.push(operation);
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') return { healthy: false, reason: 'HUMAN_AUTH_REQUIRED' };
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => error.code === 'HUMAN_AUTH_REQUIRED',
  );
  assert.deepEqual(operations, ['discover', 'attest']);
});

test('never restarts a context when browser-visible attestation is indeterminate', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49410',
    processIdentity: processIdentity(declaration, 1411),
  };
  const operations = [];

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation) => {
        operations.push(operation);
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') {
          return { healthy: false, reason: 'VISIBLE_ATTESTATION_INDETERMINATE' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => error.code === 'VISIBLE_ATTESTATION_INDETERMINATE',
  );
  assert.deepEqual(operations, ['discover', 'attest']);
});

test('non-destructive acquisition override cannot restart the protected context', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49500',
    processIdentity: processIdentity(declaration, 1501),
  };

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      recoveryMode: 'non-destructive',
      providerInvoker: async (operation) => {
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
        if (operation === 'recover') {
          return { recovered: false, mode: 'non-destructive', reason: 'ENDPOINT_UNHEALTHY' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => error.code === 'DESTRUCTIVE_RECOVERY_DISABLED',
  );
});

for (const reason of [
  'HUMAN_AUTH_REQUIRED',
  'VISIBLE_CLAIM_MISMATCH',
  'VISIBLE_ATTESTATION_INDETERMINATE',
  'VISIBLE_ATTESTATION_CLEANUP_FAILED',
  'ENDPOINT_PROCESS_MISMATCH',
]) {
  test(`failed non-destructive recovery does not restart after escalating to ${reason}`, async () => {
    const directory = await stateDir();
    const declaration = recoverableConfig.contexts[0];
    const observation = {
      contextId: declaration.id,
      endpoint: 'http://127.0.0.1:49430',
      processIdentity: processIdentity(declaration, 1431),
    };
    const operations = [];

    await assert.rejects(
      acquireContext({
        config: recoverableConfig,
        request: { surface: 'work', identity: 'requested@example.test' },
        stateDir: directory,
        providerInvoker: async (operation, payload) => {
          operations.push(operation);
          if (operation === 'discover') return { found: true, observation };
          if (operation === 'attest') {
            return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
          }

          if (operation === 'recover' && payload.mode === 'non-destructive') {
            return { recovered: false, mode: 'non-destructive', reason };
          }
          throw new Error(`unexpected operation ${operation}`);
        },
      }),
      (error) => error.code === (
        reason === 'ENDPOINT_PROCESS_MISMATCH'
          ? 'LAUNCH_ATTESTATION_FAILED'
          : reason
      ),
    );
    assert.deepEqual(operations, ['discover', 'attest', 'recover']);
  });
}

for (const response of [
  {},
  { recovered: false },
  { recovered: true },
  { recovered: false, reason: 'UNKNOWN_RECOVERY_STATE' },
  {
    recovered: false,
    mode: 'non-destructive',
    reason: 'ENDPOINT_UNAVAILABLE',
    code: 'HUMAN_AUTH_REQUIRED',
  },
  {
    recovered: false,
    mode: 'non-destructive',
    reason: 'ENDPOINT_UNAVAILABLE',
    observation: { endpoint: 'http://127.0.0.1:49999' },
  },
]) {
  test(`malformed non-destructive response cannot authorize restart: ${JSON.stringify(response)}`, async () => {
    const directory = await stateDir();
    const declaration = recoverableConfig.contexts[0];
    const observation = {
      contextId: declaration.id,
      endpoint: 'http://127.0.0.1:49440',
      processIdentity: processIdentity(declaration, 1441),
    };
    const operations = [];

    await assert.rejects(
      acquireContext({
        config: recoverableConfig,
        request: { surface: 'work', identity: 'requested@example.test' },
        stateDir: directory,
        providerInvoker: async (operation) => {
          operations.push(operation);
          if (operation === 'discover') return { found: true, observation };
          if (operation === 'attest') {
            return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
          }
          if (operation === 'recover') return response;
          throw new Error(`unexpected operation ${operation}`);
        },
      }),
      (error) => error.code === 'CONTEXT_RECOVERY_FAILED',
    );
    assert.deepEqual(operations, ['discover', 'attest', 'recover']);
  });
}

test('successful non-destructive recovery with unhealthy observation never restarts', async () => {
  const directory = await stateDir();
  const declaration = recoverableConfig.contexts[0];
  const observation = {
    contextId: declaration.id,
    endpoint: 'http://127.0.0.1:49450',
    processIdentity: processIdentity(declaration, 1451),
  };
  const operations = [];

  await assert.rejects(
    acquireContext({
      config: recoverableConfig,
      request: { surface: 'work', identity: 'requested@example.test' },
      stateDir: directory,
      providerInvoker: async (operation, payload) => {
        operations.push(`${operation}:${payload?.mode ?? 'default'}`);
        if (operation === 'discover') return { found: true, observation };
        if (operation === 'attest') {
          return { healthy: false, reason: 'ENDPOINT_UNHEALTHY' };
        }
        if (operation === 'recover' && payload.mode === 'non-destructive') {
          return {
            recovered: true,
            mode: 'non-destructive',
            observation: {},
          };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    }),
    (error) => error.code === 'CONTEXT_RECOVERY_FAILED',
  );
  assert.equal(operations.some((operation) => operation === 'recover:restart'), false);
});
