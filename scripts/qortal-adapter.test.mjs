import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQortalAdapter } from './qortal-adapter.mjs';
import { decodeBase58, encodeBase58 } from './qortal-publish-lib.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/qortal-arbitrary.json', import.meta.url), 'utf8'));
afterEach(() => vi.unstubAllGlobals());

it('builds a fee-paying upload, validates local key identity and serializes the account', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qortal-adapter-'));
  let adapter, other;
  try {
    const accountPath = path.join(dir, 'account.json');
    writeFileSync(accountPath, JSON.stringify({ accountAddress: fixture.testAddress, accountPublicKey: fixture.testPublicKey, accountPrivateKey: fixture.testSeed }));
    const payloadDir = path.join(dir, 'payload'); mkdirSync(payloadDir);
    writeFileSync(path.join(payloadDir, 'manifest.json'), '{}');
    const raw = decodeBase58(fixture.unsigned);
    raw.writeBigInt64BE(BigInt(Date.now()), 4);
    decodeBase58(fixture.testPublicKey).copy(raw, 80);
    const reference = encodeBase58(raw.subarray(16, 80));
    const calls = [];
    vi.stubGlobal('fetch', async (url, options) => {
      calls.push({ url, options });
      const u = new URL(url); let body;
      if (u.pathname === '/admin/status') body = { syncPercent: 100, isSynchronizing: false };
      else if (u.pathname === '/names/xnetwork') body = { owner: fixture.testAddress };
      else if (u.pathname.startsWith('/addresses/balance/')) body = '6.34000000';
      else if (u.pathname === '/transactions/unitfee') body = '1000000';
      else if (u.pathname === '/transactions/unconfirmed') body = [];
      else if (u.pathname.startsWith('/addresses/lastreference/')) body = reference;
      else if (u.pathname === '/arbitrary/DATABASE/xnetwork/Network/zip') { expect(u.searchParams.get('fee')).toBe('1000000'); body = encodeBase58(raw); }
      else throw Error('Unexpected API path ' + u.pathname);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body));
    });
    const env = { QORTIUM_NETWORK_QORTAL_ACCOUNT_PATH: accountPath, QORTIUM_NETWORK_QORTAL_ADDRESS: fixture.testAddress };
    adapter = createQortalAdapter({ env, log: () => {} });
    const target = { service: 'DATABASE', name: 'xnetwork', identifier: 'Network' };
    const result = await adapter.prepare(target, { directory: payloadDir });
    expect(result.fee).toBe('0.01000000');
    expect(decodeBase58(result.signedBytes58).subarray(0, -64)).toEqual(raw);
    expect(calls.every(call => !call.url.includes('/transactions/sign'))).toBe(true);
    expect(calls.some(call => call.url.includes('/transactions/process'))).toBe(false);
    other = createQortalAdapter({ env, log: () => {} });
    await expect(other.prepare(target, { directory: payloadDir })).rejects.toThrow('Another publish run');
    adapter.release();
    expect(existsSync(path.join(dir, 'qdn-account-' + fixture.testAddress + '.lock'))).toBe(false);
  } finally { adapter?.release(); other?.release(); rmSync(dir, { recursive: true, force: true }); }
});
