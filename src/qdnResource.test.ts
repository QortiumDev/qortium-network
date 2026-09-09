import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeQdnError, normalizeQdnJson, qortalReadRequest } from './qdnRequest';
import { RESOURCE_READY_POLL_MS, RESOURCE_READY_TIMEOUT_MS, waitForQdnResource } from './qdnResource';

const resource = { service: 'DATABASE', name: 'xnetwork', identifier: 'Network' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('QDN resource availability', () => {
  it('waits through the actual Hub partial-download response before allowing data reads', async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 'DOWNLOADING', localChunkCount: 4, totalChunkCount: 7 })
      .mockResolvedValueOnce('{"status":"BUILDING","localChunkCount":7,"totalChunkCount":7}')
      .mockResolvedValueOnce({ status: 'READY' });
    const progress: string[] = [];
    let finished = false;
    const result = waitForQdnResource(resource, { signal: new AbortController().signal, request, onProgress: x => progress.push(x) }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(progress).toContain('Downloading network data (4 of 7 chunks)…');
    expect(request).toHaveBeenCalledWith({ action: 'GET_QDN_RESOURCE_STATUS', ...resource, build: true });
    await vi.advanceTimersByTimeAsync(RESOURCE_READY_POLL_MS);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(RESOURCE_READY_POLL_MS);
    await result;
    expect(finished).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each(['BLOCKED', 'BUILD_FAILED', 'UNSUPPORTED'])('does not retry terminal %s', async status => {
    const request = vi.fn().mockResolvedValue({ status });
    await expect(waitForQdnResource(resource, { signal: new AbortController().signal, request, onProgress: vi.fn() })).rejects.toThrow(status.toLowerCase().replaceAll('_', ' '));
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled download and retains useful progress in its timeout', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ status: 'DOWNLOADING', localChunkCount: 4, totalChunkCount: 7 });
    const outcome = waitForQdnResource(resource, { signal: new AbortController().signal, request, onProgress: vi.fn() }).catch(e => e);
    await vi.advanceTimersByTimeAsync(RESOURCE_READY_TIMEOUT_MS);
    expect((await outcome).message).toContain('4 of 7 chunks');
    expect((await outcome).message).toContain('Try Refresh later');
    const calls = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RESOURCE_READY_TIMEOUT_MS);
    expect(request).toHaveBeenCalledTimes(calls);
  });
  it('bounds a host status request that never settles', async () => {
    vi.useFakeTimers();
    const outcome = waitForQdnResource(resource, { signal: new AbortController().signal, request: () => new Promise(() => {}), onProgress: vi.fn() }).catch(e => e);
    await vi.advanceTimersByTimeAsync(RESOURCE_READY_TIMEOUT_MS);
    expect((await outcome).message).toContain('not ready yet');
  });
  it('cancels an outstanding host request without accepting its late result', async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const progress = vi.fn();
    const outcome = waitForQdnResource(resource, { signal: controller.signal, request, onProgress: progress }).catch(e => e);
    controller.abort();
    expect((await outcome).name).toBe('AbortError');
    finish({ status: 'READY' });
    await Promise.resolve();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed status and returned error envelopes', async () => {
    for (const value of [null, [], {}, { status: 1 }, { error: { message: 'Node unavailable' } }]) {
      await expect(waitForQdnResource(resource, { signal: new AbortController().signal, request: async () => value, onProgress: vi.fn() })).rejects.toThrow();
    }
  });
});

describe('Hub and Home error compatibility', () => {
  it.each([
    [new Error('Missing data'), 'Missing data'],
    [{ error: 1401, message: 'Data unavailable. Please try again later.' }, 'Data unavailable. Please try again later.'],
    [{ error: { message: 'Nested node error' } }, 'Nested node error'],
    [{ error: 'Denied' }, 'Denied'],
    [{ unexpected: 'do not dump payloads' }, 'The QDN request failed.'],
    [undefined, 'The QDN request failed.'],
  ])('extracts a readable message without object coercion', (value, expected) => {
    expect(describeQdnError(value)).toBe(expected);
  });
  it('handles cyclic and nested resolved errors', () => {
    const cycle: { error?: unknown } = {}; cycle.error = cycle;
    expect(describeQdnError(cycle)).toBe('The QDN request failed.');
    expect(() => normalizeQdnJson({ error: { message: 'Missing chunks' } })).toThrow('Missing chunks');
  });
  it.each(['qortal', 'qortium'])('normalizes rejected %s bridge objects', async network => {
    vi.stubEnv('VITE_QDN_NETWORK', network);
    const bridge = vi.fn().mockRejectedValue({ error: 1401, message: 'Data unavailable. Please try again later.' });
    vi.stubGlobal('window', { qortalRequest: bridge, qdnRequest: bridge });
    const { qdnRequest } = await import('./qdnRequest');
    await expect(qdnRequest({ action: 'FETCH_QDN_RESOURCE', ...resource, path: 'latest.json' })).rejects.toThrow('Data unavailable. Please try again later.');
  });
  it('preserves the Qortal build request and exposes a local-node status fallback', async () => {
    expect(qortalReadRequest({ action: 'GET_QDN_RESOURCE_STATUS', ...resource, build: true, maxBytes: 10 })).toEqual({ action: 'GET_QDN_RESOURCE_STATUS', ...resource, build: true });
    vi.stubEnv('VITE_QDN_NETWORK', 'qortium');
    vi.stubGlobal('window', {});
    const fetch = vi.fn().mockResolvedValue(new Response('{"status":"READY"}', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const { qdnRequest } = await import('./qdnRequest');
    expect(await qdnRequest({ action: 'GET_QDN_RESOURCE_STATUS', ...resource, build: true })).toEqual({ status: 'READY' });
    expect(fetch.mock.calls[0]?.[0]).toContain('/arbitrary/resource/status/DATABASE/xnetwork/Network?build=true');
  });
});
