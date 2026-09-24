import { createHash } from 'node:crypto';

import { matchContext } from './claims.mjs';
import { BrokerError } from './claims.mjs';
import { reserveEndpoint } from './endpoint.mjs';
import { createLease, summarizeContextLeases } from './leases.mjs';
import { withBrokerLock } from './lock.mjs';
import { readRegistry, reconcileContext, writeRegistry } from './registry.mjs';

const RECOVERABLE_REASONS = new Set([
  'ENDPOINT_UNAVAILABLE',
  'ENDPOINT_UNHEALTHY',
]);

const HUMAN_AUTH_REASONS = new Set([
  'HUMAN_AUTH_REQUIRED',
]);

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isCompleteRecoveryObservation(observation, declaration) {
  const identity = observation?.processIdentity;
  return observation?.contextId === declaration.id &&
    typeof observation.endpoint === 'string' &&
    observation.endpoint.length > 0 &&
    Number.isSafeInteger(identity?.pid) &&
    typeof identity.startIdentity === 'string' &&
    identity.startIdentity.length > 0 &&
    typeof identity.owner === 'string' &&
    identity.owner.length > 0 &&
    typeof identity.executable === 'string' &&
    identity.executable.length > 0 &&
    typeof identity.profileRoot === 'string' &&
    identity.profileRoot.length > 0;
}

function validateNonDestructiveRecovery(recovery, declaration) {
  if (recovery?.recovered === true) {
    return hasExactKeys(recovery, ['mode', 'observation', 'recovered']) &&
      recovery.mode === 'non-destructive' &&
      isCompleteRecoveryObservation(recovery.observation, declaration);
  }
  return recovery?.recovered === false &&
    hasExactKeys(recovery, ['mode', 'reason', 'recovered']) &&
    recovery.mode === 'non-destructive' &&
    typeof recovery.reason === 'string' &&
    recovery.reason.length > 0;
}

async function updateContext(stateDir, contextId, observation, metadata = {}) {
  await withBrokerLock(stateDir, async () => {
    const registry = await readRegistry(stateDir);
    if (observation) {
      Object.defineProperty(registry.contexts, contextId, {
        value: {
          ...observation,
          ...metadata,
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    else delete registry.contexts[contextId];
    await writeRegistry(stateDir, registry);
  });
}

function publicResult(declaration, reconciled, recovery) {
  return {
    context: declaration,
    rawEndpoint: reconciled.endpoint,
    processIdentity: reconciled.processIdentity,
    recovery,
  };
}

function contextLockName(contextId) {
  return `context-${createHash('sha256').update(contextId).digest('hex')}`;
}

function observationRecord(declaration, reconciled) {
  return {
    contextId: declaration.id,
    claims: declaration.claims,
    endpoint: reconciled.endpoint,
    processIdentity: reconciled.processIdentity,
    lastAttestedAt: new Date().toISOString(),
    attestation: reconciled.evidence
      ? {
          visible: reconciled.evidence.visibleClaims,
        }
      : undefined,
  };
}

function failClosedAttestation(declaration, reconciled) {
  const reason = reconciled.reason ?? 'ATTESTATION_UNHEALTHY';
  if (HUMAN_AUTH_REASONS.has(reason)) {
    throw new BrokerError(
      reason,
      'The requested browser context requires interactive authentication',
      { contextId: declaration.id, reason },
    );
  }
  if (
    reason === 'VISIBLE_CLAIM_MISMATCH' ||
    reason === 'VISIBLE_ATTESTATION_INDETERMINATE' ||
    reason === 'VISIBLE_ATTESTATION_CLEANUP_FAILED'
  ) {
    throw new BrokerError(
      reason,
      'The requested browser context did not prove its configured visible claims',
      { contextId: declaration.id, reason },
    );
  }
}

function sameProcessIdentity(left, right) {
  return (
    left?.pid === right?.pid &&
    left?.startIdentity === right?.startIdentity &&
    left?.owner === right?.owner &&
    left?.executable === right?.executable &&
    left?.profileRoot === right?.profileRoot
  );
}

async function attestRecoveryObservation({
  declaration,
  recovery,
  providerInvoker,
  expectedProcessIdentity,
}) {
  if (!recovery?.recovered || !recovery.observation) return undefined;
  const reconciled = await reconcileContext(
    declaration,
    recovery.observation,
    providerInvoker,
  );
  if (reconciled.status !== 'healthy') {
    failClosedAttestation(declaration, reconciled);
    return undefined;
  }
  if (
    expectedProcessIdentity &&
    !sameProcessIdentity(reconciled.processIdentity, expectedProcessIdentity)
  ) {
    throw new BrokerError(
      'RECOVERY_PROCESS_CHANGED',
      'Non-destructive recovery changed the browser process generation',
      {
        contextId: declaration.id,
        expected: expectedProcessIdentity,
        actual: reconciled.processIdentity,
      },
    );
  }
  return reconciled;
}

async function provisionContext({
  config,
  declaration,
  stateDir,
  providerInvoker,
  endpointAllocator,
  operation = 'launch',
  observation,
  reason,
  recovery,
}) {
  const maxAttempts = config?.endpoint?.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const endpoint = await endpointAllocator();
    let result;
    try {
      result = await providerInvoker(operation, {
        declaration,
        endpoint,
        attempt,
        ...(operation === 'recover'
          ? { mode: 'restart', observation, reason }
          : {}),
      });
    } catch (error) {
      if (error.code === 'ENDPOINT_COLLISION' && attempt < maxAttempts) continue;
      throw error;
    }
    if (result?.code === 'ENDPOINT_COLLISION') {
      if (attempt < maxAttempts) continue;
      throw new BrokerError('ENDPOINT_COLLISION', 'No collision-free endpoint could be allocated', {
        attempts: maxAttempts,
      });
    }
    const launchedObservation = result?.observation;
    if (!launchedObservation) {
      throw new BrokerError(
        operation === 'recover' ? 'CONTEXT_RECOVERY_FAILED' : 'PROVIDER_LAUNCH_FAILED',
        `Provider did not return a ${operation} observation`,
      );
    }
    const reconciled = await reconcileContext(
      declaration,
      launchedObservation,
      providerInvoker,
    );
    if (reconciled.status !== 'healthy') {
      if (HUMAN_AUTH_REASONS.has(reconciled.reason)) {
        failClosedAttestation(declaration, reconciled);
      }
      throw new BrokerError(
        operation === 'recover' ? 'RECOVERY_ATTESTATION_FAILED' : 'LAUNCH_ATTESTATION_FAILED',
        `${operation === 'recover' ? 'Recovered' : 'Launched'} context failed fresh attestation`,
        { contextId: declaration.id, reason: reconciled.reason },
      );
    }
    await updateContext(
      stateDir,
      declaration.id,
      observationRecord(declaration, reconciled),
      recovery
        ? {
            recovery: {
              mode: recovery,
              result: 'healthy',
              reason,
              at: new Date().toISOString(),
            },
          }
        : {},
    );
    return publicResult(declaration, reconciled, recovery ?? 'provisioned');
  }
  throw new BrokerError('PROVIDER_LAUNCH_FAILED', 'Provider launch attempts were exhausted');
}

async function acquireContextLocked({
  config,
  request,
  stateDir,
  providerInvoker,
  endpointAllocator = () => reserveEndpoint(config?.endpoint),
  recoveryMode = 'full',
}) {
  const declaration = matchContext(config, request);
  const registry = await readRegistry(stateDir);
  const registryObservation = registry.contexts[declaration.id];
  const discovery = await providerInvoker('discover', {
    declaration,
    observation: registryObservation,
  });
  const observation = discovery?.found ? discovery.observation : undefined;
  let recovery = registryObservation ? 'recovered' : 'provisioned';

  if (observation) {
    const reconciled = await reconcileContext(
      declaration,
      observation,
      providerInvoker,
    );
    if (reconciled.status === 'healthy') {
      const freshObservation = observationRecord(declaration, reconciled);
      await updateContext(stateDir, declaration.id, freshObservation);
      return publicResult(declaration, reconciled, 'reused');
    }
    failClosedAttestation(declaration, reconciled);
    if (RECOVERABLE_REASONS.has(reconciled.reason)) {
      const nonDestructive = await providerInvoker('recover', {
        mode: 'non-destructive',
        declaration,
        observation,
        reason: reconciled.reason,
      });
      if (!validateNonDestructiveRecovery(nonDestructive, declaration)) {
        throw new BrokerError(
          'CONTEXT_RECOVERY_FAILED',
          'Provider returned an invalid non-destructive recovery result',
          { contextId: declaration.id },
        );
      }
      const restored = await attestRecoveryObservation({
        declaration,
        recovery: nonDestructive,
        providerInvoker,
        expectedProcessIdentity: observation.processIdentity,
      });
      if (restored) {
        await updateContext(
          stateDir,
          declaration.id,
          observationRecord(declaration, restored),
          {
            recovery: {
              mode: 'non-destructive',
              result: 'healthy',
              reason: reconciled.reason,
              at: new Date().toISOString(),
            },
          },
        );
        return publicResult(declaration, restored, 'reconnected');
      }
      if (nonDestructive.recovered === true) {
        throw new BrokerError(
          'CONTEXT_RECOVERY_FAILED',
          'Provider reported successful non-destructive recovery without healthy fresh attestation',
          { contextId: declaration.id },
        );
      }
      const recoveryReason = nonDestructive?.reason;
      if (recoveryReason && !RECOVERABLE_REASONS.has(recoveryReason)) {
        const recoveryFailure = { reason: recoveryReason };
        failClosedAttestation(declaration, recoveryFailure);
        const recognizedUnsafeReason = recoveryReason === 'ENDPOINT_PROCESS_MISMATCH';
        throw new BrokerError(
          recognizedUnsafeReason ? 'LAUNCH_ATTESTATION_FAILED' : 'CONTEXT_RECOVERY_FAILED',
          'Non-destructive recovery produced an unsafe attestation state',
          { contextId: declaration.id, reason: recoveryReason },
        );
      }

      const currentRegistry = await readRegistry(stateDir);
      const leases = summarizeContextLeases(
        currentRegistry,
        declaration.id,
        observation.processIdentity,
      );
      if (leases.length > 0) {
        throw new BrokerError(
          'CONTEXT_RECOVERY_CONFLICT',
          'The requested browser context is unhealthy and has active leases',
          {
            contextId: declaration.id,
            reason: reconciled.reason,
            leases,
          },
        );
      }
      if (recoveryMode === 'non-destructive') {
        throw new BrokerError(
          'DESTRUCTIVE_RECOVERY_DISABLED',
          'The requested browser context requires restart but destructive recovery is disabled',
          { contextId: declaration.id, reason: reconciled.reason },
        );
      }
      if (declaration.recovery?.restart !== true) {
        throw new BrokerError(
          'UNSUPPORTED_CONTEXT_RECOVERY',
          'The requested browser context does not authorize restart',
          { contextId: declaration.id, reason: reconciled.reason },
        );
      }
      await updateContext(stateDir, declaration.id, undefined);
      return provisionContext({
        config,
        declaration,
        stateDir,
        providerInvoker,
        endpointAllocator,
        operation: 'recover',
        observation,
        reason: reconciled.reason,
        recovery: 'restarted',
      });
    }
    if (reconciled.reason !== 'PROCESS_ABSENT') {
      throw new BrokerError(
        'LAUNCH_ATTESTATION_FAILED',
        'The requested browser context failed attestation and cannot be reprovisioned safely',
        { contextId: declaration.id, reason: reconciled.reason },
      );
    }
    recovery = 'recovered';
  }

  const replacementObservation = observation ?? registryObservation;
  const currentRegistry = await readRegistry(stateDir);
  const blockingLeases = summarizeContextLeases(
    currentRegistry,
    declaration.id,
    replacementObservation?.processIdentity,
  );
  if (replacementObservation || blockingLeases.length > 0) {
    if (blockingLeases.length > 0) {
      throw new BrokerError(
        'CONTEXT_RECOVERY_CONFLICT',
        'The requested browser context is absent and has active leases',
        {
          contextId: declaration.id,
          reason: 'PROCESS_ABSENT',
          leases: blockingLeases,
        },
      );
    }
    if (recoveryMode === 'non-destructive') {
      throw new BrokerError(
        'DESTRUCTIVE_RECOVERY_DISABLED',
        'The requested browser context is absent and replacement is disabled',
        { contextId: declaration.id, reason: 'PROCESS_ABSENT' },
      );
    }
    if (declaration.recovery?.restart !== true) {
      throw new BrokerError(
        'UNSUPPORTED_CONTEXT_RECOVERY',
        'The requested browser context does not authorize replacement',
        { contextId: declaration.id, reason: 'PROCESS_ABSENT' },
      );
    }
    await updateContext(stateDir, declaration.id, undefined);
    return provisionContext({
      config,
      declaration,
      stateDir,
      providerInvoker,
      endpointAllocator,
      operation: 'recover',
      observation: replacementObservation,
      reason: 'PROCESS_ABSENT',
      recovery: 'restarted',
    });
  }

  return provisionContext({
    config,
    declaration,
    stateDir,
    providerInvoker,
    endpointAllocator,
    recovery,
  });
}

export async function acquireContext(options) {
  const declaration = matchContext(options.config, options.request);
  return withBrokerLock(
    options.stateDir,
    () => acquireContextLocked(options),
    { name: contextLockName(declaration.id) },
  );
}

export async function acquireLease({
  leaseCreator = createLease,
  owner,
  cdpClientOptions,
  ...options
}) {
  const declaration = matchContext(options.config, options.request);
  return withBrokerLock(
    options.stateDir,
    async () => {
      const acquired = await acquireContextLocked(options);
      const lease = await leaseCreator({
        stateDir: options.stateDir,
        context: acquired.context,
        owner,
        rawEndpoint: acquired.rawEndpoint,
        processIdentity: acquired.processIdentity,
        cdpClientOptions,
      });
      return { acquired, lease };
    },
    { name: contextLockName(declaration.id) },
  );
}
