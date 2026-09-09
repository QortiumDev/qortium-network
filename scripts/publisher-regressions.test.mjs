import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { decodeBase58, parseQortalArbitraryTransaction, signQortalTransaction } from './qortal-publish-lib.mjs';
import { qortalServiceId } from './qortal-adapter.mjs';
import { publishToTargets } from './dual-publish.mjs';
const wire = JSON.parse(readFileSync(new URL('./fixtures/qortal-arbitrary.json', import.meta.url), 'utf8'));

describe('independent Qortal wire fixture', () => {
  it('matches the live builder and the established Python local signer', () => {
    const parsed = parseQortalArbitraryTransaction(decodeBase58(wire.unsigned));
    expect(parsed.service).toBe(qortalServiceId('DATABASE'));
    expect(parsed.service).toBe(1700);
    expect(qortalServiceId('APP')).toBe(1000);
    expect(qortalServiceId('SNAPSHOT')).toBe(1710);
    expect(parsed.name).toBe('xnetwork');
    expect(parsed.fee).toBe(1_000_000n);
    expect(signQortalTransaction(wire.unsigned, wire.testSeed).signature58).toBe(wire.expectedSignature);
  });
  it('rejects truncated or trailing transaction material', () => {
    const raw = decodeBase58(wire.unsigned);
    expect(() => parseQortalArbitraryTransaction(raw.subarray(0, 100))).toThrow();
    expect(() => parseQortalArbitraryTransaction(Buffer.concat([raw, Buffer.alloc(7)]))).toThrow();
  });
});

it('rechecks a broadcast transaction after confirmation timeout without signing or broadcasting again', async () => {
  const target = { key: 'qortal', chain: 'qortal', service: 'DATABASE', name: 'xnetwork', identifier: 'Network' };
  const pending = { payloadDigest: 'sha256:a', targets: {} };
  let signs = 0, sends = 0, confirmations = 0;
  const adapter = {
    prepare: async () => { signs++; return { signature: 'public-signature', signedBytes58: 'public-bytes' }; },
    broadcast: async () => { sends++; },
    lookup: async () => ({ blockHeight: 1 }),
    confirm: async () => { if (++confirmations === 1) throw Error('Content not ready yet'); },
  };
  const args = { adapters: { qortal: adapter }, payload: { digest: 'sha256:a', directory: 'unused' }, pending, targets: [target], persist: async () => {}, log: () => {} };
  expect(await publishToTargets(args)).toHaveLength(1);
  expect(await publishToTargets(args)).toHaveLength(0);
  expect({ signs, sends, confirmations }).toEqual({ signs: 1, sends: 1, confirmations: 2 });
});

it('never signs again after confirmation succeeds but saving the success receipt fails once', async () => {
  const target = { key: 'qortal', chain: 'qortal', service: 'DATABASE', name: 'xnetwork', identifier: 'Network' };
  const pending = { payloadDigest: 'sha256:a', targets: {} };
  let signs = 0, failSave = true;
  const adapter = {
    prepare: async () => ({ signature: 'sig-' + ++signs, signedBytes58: 'public-bytes' }),
    broadcast: async () => {}, lookup: async () => ({ blockHeight: 1 }), confirm: async () => {},
  };
  const args = { adapters: { qortal: adapter }, payload: { digest: 'sha256:a' }, pending, targets: [target], log: () => {}, persist: async () => {
    if (pending.targets.qortal.status === 'published' && failSave) { failSave = false; throw Error('Transient disk failure'); }
  } };
  await publishToTargets(args);
  await publishToTargets(args);
  expect(signs).toBe(1);
  expect(pending.targets.qortal.status).toBe('published');
});
