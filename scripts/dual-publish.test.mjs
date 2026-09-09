import { describe, expect, it } from 'vitest';
import { TARGET_STATUS } from './dual-publish-state.mjs';
import {
  AmbiguousBroadcastError,
  isPendingComplete,
  PayloadChangedError,
  publishToTargets,
  resolveTargets,
} from './dual-publish.mjs';

const PAYLOAD = { digest: 'sha256:abc', directory: '/tmp/payload' };

function makePending(overrides = {}) {
  return { attempts: 1, payloadDigest: PAYLOAD.digest, recordGeneratedAt: '2026-09-08T11:00:00.000Z', targets: {}, ...overrides };
}

/**
 * Scriptable stand-in for a chain. `fail` maps a step name to the error thrown
 * the first `n` times that step runs, so a run can be replayed to recovery.
 */
function makeAdapter(name, { broadcasts = [], confirms = [], known = new Set(), prepares = [] } = {}) {
  const calls = [];
  const next = (queue) => (queue.length > 0 ? queue.shift() : null);

  return {
    calls,
    known,
    async broadcast(_target, prepared) {
      calls.push(`broadcast:${prepared.signature}`);

      const error = next(broadcasts);

      if (error) {
        throw error;
      }

      known.add(prepared.signature);
    },
    async confirm(_target, receipt) {
      calls.push(`confirm:${receipt.signature}`);

      const error = next(confirms);

      if (error) {
        throw error;
      }
    },
    async lookup(_target, signature) {
      calls.push(`lookup:${signature}`);

      return known.has(signature) ? { signature } : null;
    },
    async prepare() {
      calls.push('prepare');

      const error = next(prepares);

      if (error) {
        throw error;
      }

      return {
        fee: '0.00100000',
        reference: `${name}-ref`,
        signature: `${name}-sig-${calls.filter((call) => call === 'prepare').length}`,
        signedBytes58: `${name}-bytes`,
      };
    },
  };
}

const noop = () => {};

describe('target resolution', () => {
  it('publishes Qortium only until the Qortal target is explicitly opted in', () => {
    expect(resolveTargets({})).toMatchObject([
      { chain: 'qortium', identifier: 'Network', key: 'qortium', name: 'Network', service: 'DATABASE' },
    ]);

    expect(resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: 'false' })).toHaveLength(1);
    expect(resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: '' })).toHaveLength(1);
    expect(resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: undefined })).toHaveLength(1);

    const dual = resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: '1' });

    expect(dual).toHaveLength(2);
    expect(dual[1]).toMatchObject({
      chain: 'qortal',
      identifier: 'Network',
      key: 'qortal',
      name: 'xnetwork',
      service: 'DATABASE',
    });
  });

  it('keeps both targets pointed at the same DATABASE dataset', () => {
    const [qortium, qortal] = resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: '1' });

    expect(qortal.service).toBe(qortium.service);
    expect(qortal.description).toBe(qortium.description);
  });
});

describe('fan-out to independent targets', () => {
  const targets = resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: 'yes' });

  it('publishes both targets from one payload and records a receipt each', async () => {
    const pending = makePending();
    const adapters = { qortal: makeAdapter('qortal'), qortium: makeAdapter('qortium') };
    const persisted = [];

    const failures = await publishToTargets({
      adapters,
      log: noop,
      payload: PAYLOAD,
      pending,
      persist: () => persisted.push(JSON.stringify(pending.targets)),
      targets,
    });

    expect(failures).toEqual([]);
    expect(isPendingComplete(pending, targets)).toBe(true);
    expect(pending.targets.qortium.signature).toBe('qortium-sig-1');
    expect(pending.targets.qortal.signature).toBe('qortal-sig-1');
    // The signature must reach disk before the broadcast leaves the process.
    expect(JSON.parse(persisted[0]).qortium.status).toBe(TARGET_STATUS.UNCERTAIN);
    expect(persisted.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the first target published and retries only the failed one on the same payload', async () => {
    const pending = makePending();
    const qortal = makeAdapter('qortal', { prepares: [new Error('qortal node is not synced')] });
    const qortium = makeAdapter('qortium');

    const first = await publishToTargets({
      adapters: { qortal, qortium },
      log: noop,
      payload: PAYLOAD,
      pending,
      persist: noop,
      targets,
    });

    expect(first).toEqual([{ message: 'qortal node is not synced', target: 'qortal' }]);
    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.PUBLISHED);
    expect(pending.targets.qortal.status).toBe(TARGET_STATUS.FAILED);
    expect(isPendingComplete(pending, targets)).toBe(false);

    const second = await publishToTargets({
      adapters: { qortal, qortium },
      log: noop,
      payload: PAYLOAD,
      pending,
      persist: noop,
      targets,
    });

    expect(second).toEqual([]);
    expect(isPendingComplete(pending, targets)).toBe(true);
    // The already-published target was skipped: no second spend on Qortium.
    expect(qortium.calls.filter((call) => call === 'prepare')).toHaveLength(1);
    expect(pending.targets.qortium.signature).toBe('qortium-sig-1');
    expect(pending.targets.qortal.attempts).toBe(2);
  });

  it('refuses to retry when the built payload no longer matches the pending digest', async () => {
    await expect(
      publishToTargets({
        adapters: { qortium: makeAdapter('qortium') },
        log: noop,
        payload: { digest: 'sha256:changed', directory: '/tmp/payload' },
        pending: makePending(),
        persist: noop,
        targets: targets.slice(0, 1),
      }),
    ).rejects.toBeInstanceOf(PayloadChangedError);
  });
});

describe('ambiguous broadcast', () => {
  const targets = resolveTargets({});

  it('never re-signs after an uncertain broadcast, and adopts the transaction if it landed', async () => {
    const pending = makePending();
    const adapter = makeAdapter('qortium', { broadcasts: [new AmbiguousBroadcastError('connection reset')] });

    await publishToTargets({ adapters: { qortium: adapter }, log: noop, payload: PAYLOAD, pending, persist: noop, targets });

    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.UNCERTAIN);
    expect(pending.targets.qortium.signature).toBe('qortium-sig-1');

    // It had in fact reached the network.
    adapter.known.add('qortium-sig-1');

    const failures = await publishToTargets({
      adapters: { qortium: adapter },
      log: noop,
      payload: PAYLOAD,
      pending,
      persist: noop,
      targets,
    });

    expect(failures).toEqual([]);
    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.PUBLISHED);
    expect(pending.targets.qortium.signature).toBe('qortium-sig-1');
    expect(adapter.calls.filter((call) => call === 'prepare')).toHaveLength(1);
    expect(adapter.calls).toContain('lookup:qortium-sig-1');
  });

  it('re-sends the stored bytes rather than signing again when the transaction never landed', async () => {
    const pending = makePending();
    const adapter = makeAdapter('qortium', { broadcasts: [new AmbiguousBroadcastError('gateway timeout')] });

    await publishToTargets({ adapters: { qortium: adapter }, log: noop, payload: PAYLOAD, pending, persist: noop, targets });
    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.UNCERTAIN);

    const failures = await publishToTargets({
      adapters: { qortium: adapter },
      log: noop,
      payload: PAYLOAD,
      pending,
      persist: noop,
      targets,
    });

    expect(failures).toEqual([]);
    expect(adapter.calls.filter((call) => call === 'prepare')).toHaveLength(1);
    expect(adapter.calls.filter((call) => call === 'broadcast:qortium-sig-1')).toHaveLength(2);
    expect(pending.targets.qortium.signature).toBe('qortium-sig-1');
  });

  it('stays uncertain rather than failing when confirmation is still pending', async () => {
    const pending = makePending();
    const adapter = makeAdapter('qortium', { confirms: [new Error('Timed out waiting for transaction')] });

    const failures = await publishToTargets({
      adapters: { qortium: adapter },
      log: noop,
      payload: PAYLOAD,
      pending,
      persist: noop,
      targets,
    });

    expect(failures).toHaveLength(1);
    // Broadcast succeeded, so the next run resumes at confirm without re-signing.
    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.BROADCAST);

    await publishToTargets({ adapters: { qortium: adapter }, log: noop, payload: PAYLOAD, pending, persist: noop, targets });

    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.PUBLISHED);
    expect(adapter.calls.filter((call) => call === 'prepare')).toHaveLength(1);
  });

  it('reports a missing adapter as that target failing, not as a crash', async () => {
    const dual = resolveTargets({ QORTIUM_NETWORK_QORTAL_PUBLISH: 'on' });
    const pending = makePending();
    const adapters = { qortium: makeAdapter('qortium') };

    Object.defineProperty(adapters, 'qortal', {
      enumerable: true,
      get: () => {
        throw new Error('QORTIUM_NETWORK_QORTAL_ACCOUNT_PATH must point at the Qortal signing account file.');
      },
    });

    const failures = await publishToTargets({ adapters, log: noop, payload: PAYLOAD, pending, persist: noop, targets: dual });

    expect(pending.targets.qortium.status).toBe(TARGET_STATUS.PUBLISHED);
    expect(failures).toHaveLength(1);
    expect(failures[0].target).toBe('qortal');
  });
});
