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
