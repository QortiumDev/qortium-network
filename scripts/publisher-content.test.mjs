import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retrySyncGate, verifyPayloadContent } from './publisher-content.mjs';
import { migrateState } from './dual-publish-state.mjs';

describe('retry and content gates', () => {
  it('waits on temporary sync lag, with bounded backoff, without retrying other failures', async () => {
    const delays = []; let checks = 0;
    await retrySyncGate(async () => { if (++checks < 3) throw Error('Qortal node is not synced.'); }, { sleep: async ms => delays.push(ms) });
    expect(delays).toEqual([15000, 30000]);
    expect(checks).toBe(3);
    await expect(retrySyncGate(async () => { throw Error('Wrong owner'); }, { sleep: async () => { throw Error('Should not sleep'); } })).rejects.toThrow('Wrong owner');
    let attempts = 0;
    await expect(retrySyncGate(async () => { attempts++; throw Error('Qortium node is not synced.'); }, { sleep: async () => {} })).rejects.toThrow('not synced');
    expect(attempts).toBe(3);
  });
  it('does not accept a matching manifest when the snapshot differs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'network-content-'));
    try {
      writeFileSync(path.join(dir, 'manifest.json'), '{}');
      writeFileSync(path.join(dir, 'latest.json'), '{"observation":1}');
      await expect(verifyPayloadContent(dir, async file => Buffer.from(file === 'manifest.json' ? '{}' : '{"observation":2}'))).rejects.toThrow('latest.json');
      expect(await verifyPayloadContent(dir, async file => Buffer.from(file === 'manifest.json' ? '{}' : '{"observation":1}'))).toEqual({ verifiedFiles: 2 });
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('rejects null and unrecognized state rather than resetting publication history', () => {
    expect(() => migrateState(null)).toThrow();
    expect(() => migrateState({ typo: 'lost state' })).toThrow();
  });
});

it('drains in-flight file reads before rejecting, with no new reads after failure', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'network-drain-'));
  try {
    for (let i = 0; i < 12; i++) writeFileSync(path.join(dir, `${i}.json`), '{}');
    let active = 0, started = 0;
    await expect(verifyPayloadContent(dir, async () => {
      const first = started++ === 0;
      if (first) throw Error('Read failed');
      active++;
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return Buffer.from('{}');
    })).rejects.toThrow('Read failed');
    expect(active).toBe(0);
    expect(started).toBeLessThanOrEqual(4);
  } finally { rmSync(dir, { recursive: true }); }
});
