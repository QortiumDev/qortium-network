import { describe, expect, it } from 'vitest';
import {
  getCanonicalNetworkRoute,
  getNetworkRouteUrl,
  readNetworkRoute,
  resolveNetworkSnapshotId,
} from './networkRoute';

describe('Network routes', () => {
  const newest = '20260718T120000Z';
  const older = '20260718T040000Z';

  it('reads only durable timestamp snapshot identifiers', () => {
    expect(readNetworkRoute(`https://example.test/app?snapshot=${older}`)).toEqual({ snapshotId: older });
    expect(readNetworkRoute('https://example.test/app?snapshot=latest')).toEqual({ snapshotId: null });
    expect(readNetworkRoute('https://example.test/app?snapshot=../../secret')).toEqual({ snapshotId: null });
  });

  it('rewrites only the Network-owned key while preserving host parameters and fragments', () => {
    const url = getNetworkRouteUrl(
      `https://example.test/render/APP/Network/Network?snapshot=${newest}&qdnHomeBridge=1&theme=dark&future=value#detail`,
      { snapshotId: older },
    );

    expect(url.pathname).toBe('/render/APP/Network/Network');
    expect(url.searchParams.get('snapshot')).toBe(older);
    expect(url.searchParams.get('qdnHomeBridge')).toBe('1');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(url.searchParams.get('future')).toBe('value');
    expect(url.hash).toBe('#detail');
  });

  it('uses the newest snapshot when a route is absent, invalid, or no longer retained', () => {
    const available = [newest, older];

    expect(resolveNetworkSnapshotId(older, available)).toBe(older);
    expect(resolveNetworkSnapshotId(null, available)).toBe(newest);
    expect(resolveNetworkSnapshotId('20200101T000000Z', available)).toBe(newest);
    expect(resolveNetworkSnapshotId(null, [])).toBeNull();
  });

  it('keeps historical selections in the URL and canonicalizes latest to the base route', () => {
    expect(getCanonicalNetworkRoute(older, newest)).toEqual({ snapshotId: older });
    expect(getCanonicalNetworkRoute(newest, newest)).toEqual({ snapshotId: null });

    const url = getNetworkRouteUrl(`https://example.test/app?snapshot=${older}#graph`, { snapshotId: null });
    expect(url.searchParams.has('snapshot')).toBe(false);
    expect(url.hash).toBe('#graph');
  });
});

describe('Developers workspace routes', () => {
  it('accepts aliases and gives Developers precedence without losing the selected snapshot', () => {
    for (const alias of ['developers', 'developer', 'reference', ' Developers ']) {
      const route = readNetworkRoute(`https://example.test/app?view=${encodeURIComponent(alias)}&snapshot=20260718T040000Z`);
      expect(route).toEqual({ view: 'developers', snapshotId: '20260718T040000Z' });
      expect(getNetworkRouteUrl('https://example.test/app', route).searchParams.get('view')).toBe('developers');
    }
    expect(readNetworkRoute('https://example.test/app?view=unknown')).toEqual({ snapshotId: null });
  });

  it('preserves repeated host keys and fragments, and removes duplicate owned keys', () => {
    const input = 'https://example.test/app?view=reference&view=other&snapshot=old&snapshot=older&homeV2Bridge=1&qdnHomeBridge=token&theme=dark&future=a&future=b#schema';
    const url = getNetworkRouteUrl(input, { view: 'developers', snapshotId: null });
    expect(url.searchParams.getAll('view')).toEqual(['developers']);
    expect(url.searchParams.has('snapshot')).toBe(false);
    expect(url.searchParams.getAll('future')).toEqual(['a', 'b']);
    expect(url.searchParams.get('qdnHomeBridge')).toBe('token');
    expect(url.searchParams.get('homeV2Bridge')).toBe('1');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(url.hash).toBe('#schema');
    const returned = getNetworkRouteUrl(url, { view: 'network', snapshotId: '20260718T040000Z' });
    expect(returned.searchParams.has('view')).toBe(false);
    expect(readNetworkRoute(returned)).toEqual({ snapshotId: '20260718T040000Z' });
  });

  it('uses the first repeated view value consistently', () => {
    expect(readNetworkRoute('https://example.test/?view=network&view=developers').view).toBeUndefined();
    expect(readNetworkRoute('https://example.test/?view=developers&view=network').view).toBe('developers');
  });
});
