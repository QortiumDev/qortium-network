import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Database,
  History,
  Maximize2,
  RefreshCw,
  Route,
  Server,
  SlidersHorizontal,
  Wifi,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createGraphModel,
  EDGE_COLORS,
  EDGE_KINDS,
  getConnectedNodeIds,
  getPeerCount,
  parseNetworkSnapshot,
} from './graphModel';
import { applyDisplaySettings, getDisplaySettingsUpdateFromMessage, getInitialDisplaySettings } from './displaySettings';
import networkIconUrl from './assets/brand/qortium-network-icon.png';
import { qdnRequest } from './qdnRequest';
import { sampleSnapshot } from './sampleData';
import { useAnimatedGraph } from './useAnimatedGraph';
import { useGraphViewport } from './useGraphViewport';
import type { EdgeKind, GraphEdge, GraphNode, NetworkSnapshot } from './types';

const QDN_RESOURCE = {
  identifier: 'Network',
  name: 'Network',
  service: 'DATABASE',
} as const;

// Rendered while the first real snapshot is still loading, so the graph is empty
// rather than flashing bundled sample data on startup.
const EMPTY_SNAPSHOT: NetworkSnapshot = {
  errors: {},
  generatedAt: undefined,
  nodes: {},
  topology: { edges: [], graphNodes: {} },
};

const EDGE_LABELS: Record<EdgeKind, string> = {
  I2P_CHAIN: 'I2P chain',
  I2P_DATA: 'I2P QDN/data',
  IP_CHAIN: 'IP chain',
  IP_DATA: 'IP QDN/data',
  unknown: 'Unknown',
};

function formatTimestamp(value: string | undefined) {
  if (!value) {
    return 'unknown';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function getLineWidth(edge: GraphEdge) {
  return edge.kind.endsWith('CHAIN') ? 2.2 : 2.8;
}

function NodeGlyph({
  active,
  connected,
  node,
  onSelect,
}: {
  active: boolean;
  connected: boolean;
  node: GraphNode;
  onSelect: (nodeId: string) => void;
}) {
  const seed = node.role === 'seed';
  const fill = seed ? 'var(--qn-color-node-fill-seed)' : 'var(--qn-color-node-fill)';
  const stroke = seed
    ? 'var(--qn-color-accent)'
    : connected
      ? 'var(--qn-color-accent)'
      : 'var(--qn-color-node-stroke)';
  const fontSize = Math.max(10, Math.min(30, node.radius * (node.label.length <= 2 ? 0.72 : 0.5)));

  return (
    <g
      className={`graph-node ${active ? 'is-active' : ''} ${connected ? 'is-connected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${node.name ?? node.label}, ${getPeerCount(node)} peers`}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{ '--node-fill': fill, '--node-stroke': stroke } as React.CSSProperties}
    >
      <circle cx={node.x} cy={node.y} r={node.radius} strokeWidth={active ? 4.2 : 2.8} />
      <text
        x={node.x}
        y={node.y + fontSize * 0.34}
        className="node-label"
        fontSize={`${fontSize}px`}
        pointerEvents="none"
      >
        {node.label}
      </text>
    </g>
  );
}

function ControlContent({
  onToggleKind,
  visibleKinds,
}: {
  onToggleKind: (kind: EdgeKind) => void;
  visibleKinds: Set<EdgeKind>;
}) {
  return (
    <>
      <div className="panel-heading">
        <Route size={16} />
        <h2>Connections</h2>
      </div>
      <div className="toggle-list">
        {EDGE_KINDS.map((kind) => (
          <label key={kind} className="edge-toggle">
            <input type="checkbox" checked={visibleKinds.has(kind)} onChange={() => onToggleKind(kind)} />
            <span className="edge-swatch" style={{ backgroundColor: EDGE_COLORS[kind] }} />
            <span>{EDGE_LABELS[kind]}</span>
          </label>
        ))}
      </div>
    </>
  );
}

type RecordEntry = {
  snapshotId: string;
  generatedAt?: string;
  graphNodeCount?: number;
  edgeCount?: number;
  operatorCount?: number;
  hasErrors?: boolean;
};

function fetchDatabaseJson(path: string) {
  return qdnRequest<unknown>({
    action: 'FETCH_QDN_RESOURCE',
    async: false,
    identifier: QDN_RESOURCE.identifier,
    maxBytes: 8_000_000,
    name: QDN_RESOURCE.name,
    path,
    service: QDN_RESOURCE.service,
  });
}

async function loadNetworkSnapshot() {
  return parseNetworkSnapshot(await fetchDatabaseJson('latest.json'));
}

async function loadSnapshotBySlug(slug: string) {
  return parseNetworkSnapshot(await fetchDatabaseJson(`snapshots/${slug}.json`));
}

// Newest record first. Returns [] when no history index is published yet.
async function loadRecordIndex(): Promise<RecordEntry[]> {
  const data = await fetchDatabaseJson('index.json');
  const records = (data as { records?: unknown } | null)?.records;

  if (!Array.isArray(records)) {
    return [];
  }

  return records
    .filter((record): record is RecordEntry => !!record && typeof (record as RecordEntry).snapshotId === 'string')
    .sort((a, b) => ((a.generatedAt ?? a.snapshotId) < (b.generatedAt ?? b.snapshotId) ? 1 : -1));
}

export function App() {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>();
  const [pinnedNodeId, setPinnedNodeId] = useState<string | undefined>();
  const [controlsOpen, setControlsOpen] = useState(false);
  const [visibleKinds, setVisibleKinds] = useState<Set<EdgeKind>>(() => new Set(EDGE_KINDS));
  const [displaySettings, setDisplaySettings] = useState(getInitialDisplaySettings);

  const activeNodeId = pinnedNodeId;
  const activeSnapshot = snapshot ?? EMPTY_SNAPSHOT;
  const targetGraph = useMemo(
    () => createGraphModel(activeSnapshot, visibleKinds, pinnedNodeId),
    [activeSnapshot, pinnedNodeId, visibleKinds],
  );
  // Identifies the active record; changing it snaps the graph (no slide) because
  // node labels are not stable identities across records. Derived from the
  // snapshot itself (not selectedSlug) so it changes in lockstep with targetGraph
  // — selectedSlug updates a render earlier, before the new snapshot loads.
  const recordKey = activeSnapshot.generatedAt ?? '';
  const graph = useAnimatedGraph(targetGraph, recordKey);
  const connectedNodeIds = useMemo(
    () => (activeNodeId ? getConnectedNodeIds(targetGraph.edges, activeNodeId) : new Set<string>()),
    [activeNodeId, targetGraph.edges],
  );

  const viewport = useGraphViewport({
    width: targetGraph.width,
    height: targetGraph.height,
    onBackgroundTap: () => setPinnedNodeId(undefined),
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      let index: RecordEntry[] = [];

      try {
        index = await loadRecordIndex();
      } catch {
        index = [];
      }

      const newest = index[0];

      if (newest) {
        setRecords(index);
        setSelectedSlug(newest.snapshotId);
        setSnapshot(await loadSnapshotBySlug(newest.snapshotId));
      } else {
        setRecords([]);
        setSelectedSlug(undefined);
        setSnapshot(await loadNetworkSnapshot());
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setSnapshot(sampleSnapshot);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectRecord = useCallback(async (slug: string) => {
    setSelectedSlug(slug);
    setLoading(true);
    setLoadError(null);

    try {
      setSnapshot(await loadSnapshotBySlug(slug));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const selectedIndex = useMemo(() => {
    const index = records.findIndex((record) => record.snapshotId === selectedSlug);

    return index < 0 ? 0 : index;
  }, [records, selectedSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    applyDisplaySettings(displaySettings);
  }, [displaySettings]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      setDisplaySettings((current) => getDisplaySettingsUpdateFromMessage(event.data, current) ?? current);
    }

    window.addEventListener('message', onMessage);

    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  // Arrow keys page through records: Left = older, Right = newer (records[0] is newest).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      const target = event.target as HTMLElement | null;

      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (records.length < 2 || loading) {
        return;
      }

      const nextIndex = event.key === 'ArrowLeft'
        ? Math.min(records.length - 1, selectedIndex + 1)
        : Math.max(0, selectedIndex - 1);

      if (nextIndex !== selectedIndex) {
        event.preventDefault();
        void selectRecord(records[nextIndex]!.snapshotId);
      }
    }

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [records, selectedIndex, loading, selectRecord]);

  function toggleKind(kind: EdgeKind) {
    setVisibleKinds((current) => {
      const next = new Set(current);

      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }

      return next;
    });
  }

  function selectNode(nodeId: string) {
    setPinnedNodeId((current) => (current === nodeId ? undefined : nodeId));
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="top-bar__brand">
          <span className="top-bar__mark">
            <img src={networkIconUrl} alt="" aria-hidden="true" />
          </span>
          <div className="top-bar__heading">
            <h1>Qortium Previewnet live topology</h1>
            <p>
              {snapshot
                ? `Generated ${formatTimestamp(snapshot.generatedAt)} from /admin/status, /peers, and /peers/data.`
                : 'Loading network topology…'}
            </p>
          </div>
        </div>
        <div className="top-actions">
          <button
            className="icon-button secondary controls-button"
            type="button"
            onClick={() => setControlsOpen(true)}
            aria-label="Open connection filters"
          >
            <SlidersHorizontal size={18} />
            <span>Filters</span>
          </button>
          <button
            className="icon-button secondary"
            type="button"
            onClick={viewport.reset}
            aria-label="Reset view"
          >
            <Maximize2 size={18} />
            <span>Reset view</span>
          </button>
          <button className="icon-button" type="button" onClick={refresh} disabled={loading} aria-label="Refresh topology data">
            <RefreshCw size={18} />
            <span>{loading ? 'Loading' : 'Refresh'}</span>
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="Topology summary">
        <div>
          <Server size={16} />
          <span>{graph.nodes.length} nodes</span>
        </div>
        <div>
          <Wifi size={16} />
          <span>{graph.edges.length} visible links</span>
        </div>
        <div>
          <Database size={16} />
          <span>
            {QDN_RESOURCE.service}/{QDN_RESOURCE.name}/{QDN_RESOURCE.identifier}
          </span>
        </div>
        <div>
          <Activity size={16} />
          <span>{Object.keys(snapshot?.errors ?? {}).length} collection errors</span>
        </div>
      </section>

      {records.length > 1 ? (
        <section className="record-bar" aria-label="Snapshot history">
          <History size={16} />
          <button
            className="icon-button secondary record-step"
            type="button"
            onClick={() => selectRecord(records[Math.min(records.length - 1, selectedIndex + 1)]!.snapshotId)}
            disabled={loading || selectedIndex >= records.length - 1}
            aria-label="Older record"
          >
            <ChevronLeft size={18} />
          </button>
          <input
            className="record-slider"
            type="range"
            min={0}
            max={records.length - 1}
            value={records.length - 1 - selectedIndex}
            disabled={loading}
            onChange={(event) => {
              const index = records.length - 1 - Number(event.target.value);
              const record = records[index];

              if (record) {
                void selectRecord(record.snapshotId);
              }
            }}
            aria-label="Select snapshot by time"
          />
          <button
            className="icon-button secondary record-step"
            type="button"
            onClick={() => selectRecord(records[Math.max(0, selectedIndex - 1)]!.snapshotId)}
            disabled={loading || selectedIndex <= 0}
            aria-label="Newer record"
          >
            <ChevronRight size={18} />
          </button>
          <button
            className="icon-button secondary"
            type="button"
            onClick={() => selectRecord(records[0]!.snapshotId)}
            disabled={loading || selectedIndex <= 0}
          >
            Latest
          </button>
          <span className="record-label">
            {selectedIndex === 0 ? 'Latest' : `${selectedIndex + 1} of ${records.length}`} ·{' '}
            {formatTimestamp(records[selectedIndex]?.generatedAt)}
          </span>
        </section>
      ) : null}

      {loadError ? <div className="load-notice">Using bundled sample data. QDN load failed: {loadError}</div> : null}

      <div className="workbench">
        <aside className="control-panel" aria-label="Graph controls">
          <ControlContent onToggleKind={toggleKind} visibleKinds={visibleKinds} />
        </aside>

        <section className="map-surface" aria-label="Network topology graph">
          {!snapshot ? (
            <div className="map-loading" role="status">
              {loadError ? 'Could not load topology.' : 'Loading network topology…'}
            </div>
          ) : null}
          <svg
            viewBox={viewport.viewBox}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-labelledby="graph-title graph-desc"
            style={{ touchAction: 'none' }}
            {...viewport.bind}
          >
            <title id="graph-title">Qortium Previewnet live topology</title>
            <desc id="graph-desc">Interactive topology graph with chain and data connections.</desc>
            <defs>
              {EDGE_KINDS.map((kind) => (
                <marker
                  key={kind}
                  id={`arrow-${kind}`}
                  markerHeight="8"
                  markerWidth="8"
                  orient="auto-start-reverse"
                  refX="7.4"
                  refY="4"
                  viewBox="0 0 8 8"
                >
                  <path d="M0,0 L8,4 L0,8 Z" fill={EDGE_COLORS[kind]} />
                </marker>
              ))}
            </defs>
            <rect className="graph-bg" width="100%" height="100%" />
            <g className="edges">
              {graph.edges.map((edge) => {
                const related = !!activeNodeId && (edge.source === activeNodeId || edge.target === activeNodeId);
                const muted = !!activeNodeId && !related;

                return (
                  <line
                    key={edge.id}
                    className={`edge-line ${related ? 'is-related' : ''} ${muted ? 'is-muted' : ''}`}
                    x1={edge.line.x1}
                    x2={edge.line.x2}
                    y1={edge.line.y1}
                    y2={edge.line.y2}
                    stroke={EDGE_COLORS[edge.kind]}
                    strokeDasharray={edge.kind.startsWith('I2P') ? '8 7' : undefined}
                    strokeLinecap="round"
                    strokeWidth={related ? getLineWidth(edge) + 1.5 : getLineWidth(edge)}
                    markerStart={edge.direction.start ? `url(#arrow-${edge.kind})` : undefined}
                    markerEnd={edge.direction.end ? `url(#arrow-${edge.kind})` : undefined}
                    style={{ pointerEvents: 'none' }}
                  />
                );
              })}
            </g>
            <g className="nodes">
              {graph.nodes.map((node) => (
                <NodeGlyph
                  key={node.id}
                  active={activeNodeId === node.id}
                  connected={connectedNodeIds.has(node.id)}
                  node={node}
                  onSelect={selectNode}
                />
              ))}
            </g>
          </svg>
        </section>
      </div>
      <div
        className={`drawer-backdrop ${controlsOpen ? 'is-open' : ''}`}
        role="presentation"
        onClick={() => setControlsOpen(false)}
      />
      <aside className={`controls-drawer ${controlsOpen ? 'is-open' : ''}`} aria-label="Graph controls drawer">
        <button className="drawer-close" type="button" onClick={() => setControlsOpen(false)} aria-label="Close filters">
          <X size={18} />
        </button>
        <ControlContent onToggleKind={toggleKind} visibleKinds={visibleKinds} />
      </aside>
    </main>
  );
}
