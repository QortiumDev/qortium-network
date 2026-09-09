import { describe, expect, it, vi, afterEach } from 'vitest';
import { databaseResourceFor, parseHostingNetwork } from './qdnRuntime';
import { normalizeQdnJson, qortalReadRequest } from './qdnRequest';
import { getNetworkRouteUrl, readNetworkRoute } from './networkRoute';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('QDN deployment context', () => {
  it('keeps dataset identity separate from hosting network', () => {
    expect(databaseResourceFor('qortium')).toEqual({ service: 'DATABASE', name: 'Network', identifier: 'Network' });
    expect(databaseResourceFor('qortal')).toEqual({ service: 'DATABASE', name: 'xnetwork', identifier: 'Network' });
    expect(parseHostingNetwork(undefined)).toBe('qortium');
    expect(() => parseHostingNetwork('typo')).toThrow();
  });
  it.each(['developers', 'developer', 'reference'])('removes Qortal %s routes while preserving snapshot, query and hash', alias => {
    const input = `https://node/render/APP/xnetwork/default?view=${alias}&snapshot=20260908T120000Z&host=a&host=b#section`;
    const route = readNetworkRoute(input, false);
    const url = getNetworkRouteUrl(input, route);
    expect(route.view).toBeUndefined();
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.searchParams.get('snapshot')).toBe('20260908T120000Z');
    expect(url.searchParams.getAll('host')).toEqual(['a', 'b']);
    expect(url.hash).toBe('#section');
    expect(readNetworkRoute(input, true).view).toBe('developers');
  });
  it.each(['qortium', 'qortal'])('selects the %s bridge when Home supplies both', async network => {
    vi.stubEnv('VITE_QDN_NETWORK', network);
    const qdn = vi.fn(async (_request: Record<string, unknown>) => ({ from: 'qortium' }));
    const qortal = vi.fn(async (_request: Record<string, unknown>) => '{"from":"qortal"}');
    vi.stubGlobal('window', { qdnRequest: qdn, qortalRequest: qortal });
    const { qdnRequest } = await import('./qdnRequest');
    const value = await qdnRequest({ action: 'FETCH_QDN_RESOURCE', name: network === 'qortal' ? 'xnetwork' : 'Network', service: 'DATABASE', identifier: 'Network', path: 'latest.json', maxBytes: 1000 });
    expect(value).toEqual({ from: network });
    expect(qdn).toHaveBeenCalledTimes(network === 'qortium' ? 1 : 0);
    expect(qortal).toHaveBeenCalledTimes(network === 'qortal' ? 1 : 0);
    if (network === 'qortal') {
      expect(qortal.mock.calls.at(0)?.[0]).toMatchObject({ filepath: 'latest.json' });
      expect(qortal.mock.calls.at(0)?.[0]).not.toHaveProperty('path');
    }
  });
});

describe('Qortal resource response contract', () => {
  it('uses filepath and strips the unsupported byte-limit parameter', () => {
    expect(qortalReadRequest({ action: 'FETCH_QDN_RESOURCE', path: 'snapshots/20260908T120000Z.json', maxBytes: 8 })).toEqual({ action: 'FETCH_QDN_RESOURCE', filepath: 'snapshots/20260908T120000Z.json' });
    expect(() => qortalReadRequest({ action: 'PUBLISH_QDN_RESOURCE' })).toThrow();
  });
  it('normalizes object/text JSON and reports returned node errors', () => {
    expect(normalizeQdnJson('{"records":[]}')).toEqual({ records: [] });
    expect(normalizeQdnJson({ records: [] })).toEqual({ records: [] });
    expect(() => normalizeQdnJson('{"error":401,"message":"missing data"}')).toThrow('missing data');
    expect(() => normalizeQdnJson({ error: 'Denied' })).toThrow('Denied');
  });
  it('enforces limits using UTF-8 bytes on objects and strings', () => {
    expect(() => normalizeQdnJson('"éé"', 5)).toThrow('byte limit');
    expect(() => normalizeQdnJson({ large: 'x'.repeat(100) }, 50)).toThrow('byte limit');
    expect(normalizeQdnJson('"é"', 4)).toBe('é');
  });
});
