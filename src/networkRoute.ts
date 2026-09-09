import { NETWORK_SNAPSHOT_ID_PATTERN } from './networkContract';

export type NetworkView = 'network' | 'developers';

export interface NetworkRoute {
  view?: NetworkView;
  snapshotId: string | null;
}

const SNAPSHOT_QUERY_PARAM = 'snapshot';

export function readNetworkRoute(input: string | URL, developersEnabled = true): NetworkRoute {
  const url = input instanceof URL ? input : new URL(input, 'http://localhost');
  const snapshotId = url.searchParams.get(SNAPSHOT_QUERY_PARAM);

  const requestedView = url.searchParams.get('view')?.trim().toLowerCase();

  return {
    ...(developersEnabled && requestedView && ['developers', 'developer', 'reference'].includes(requestedView) ? { view: 'developers' as const } : {}),
    snapshotId: snapshotId && NETWORK_SNAPSHOT_ID_PATTERN.test(snapshotId) ? snapshotId : null,
  };
}

export function getNetworkRouteUrl(input: string | URL, route: NetworkRoute): URL {
  const url = input instanceof URL ? new URL(input.href) : new URL(input, 'http://localhost');

  url.searchParams.delete('view');
  if (route.view === 'developers') url.searchParams.set('view', 'developers');
  url.searchParams.delete(SNAPSHOT_QUERY_PARAM);
  if (route.snapshotId) {
    url.searchParams.set(SNAPSHOT_QUERY_PARAM, route.snapshotId);
  }

  return url;
}

export function resolveNetworkSnapshotId(
  requestedSnapshotId: string | null,
  availableSnapshotIds: readonly string[],
): string | null {
  if (requestedSnapshotId && availableSnapshotIds.includes(requestedSnapshotId)) {
    return requestedSnapshotId;
  }

  return availableSnapshotIds[0] ?? null;
}

export function getCanonicalNetworkRoute(selectedSnapshotId: string, latestSnapshotId: string): NetworkRoute {
  return {
    snapshotId: selectedSnapshotId === latestSnapshotId ? null : selectedSnapshotId,
  };
}
