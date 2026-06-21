import { Activity, Database, Maximize2, RefreshCw, Route, Server, SlidersHorizontal, Wifi, X } from 'lucide-react';
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

async function loadNetworkSnapshot() {
  const latest = await qdnRequest<unknown>({
    action: 'FETCH_QDN_RESOURCE',
    async: false,
    identifier: QDN_RESOURCE.identifier,
    maxBytes: 8_000_000,
    name: QDN_RESOURCE.name,
    path: 'latest.json',
    service: QDN_RESOURCE.service,
  });

  return parseNetworkSnapshot(latest);
}

export function App() {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot>(sampleSnapshot);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinnedNodeId, setPinnedNodeId] = useState<string | undefined>();
  const [controlsOpen, setControlsOpen] = useState(false);
  const [visibleKinds, setVisibleKinds] = useState<Set<EdgeKind>>(() => new Set(EDGE_KINDS));
  const [displaySettings, setDisplaySettings] = useState(getInitialDisplaySettings);

  const activeNodeId = pinnedNodeId;
  const targetGraph = useMemo(
    () => createGraphModel(snapshot, visibleKinds, pinnedNodeId),
    [pinnedNodeId, snapshot, visibleKinds],
  );
  const graph = useAnimatedGraph(targetGraph);
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
      setSnapshot(await loadNetworkSnapshot());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

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
        <div>
          <h1>Qortium Previewnet live topology</h1>
          <p>Generated {formatTimestamp(snapshot.generatedAt)} from /admin/status, /peers, and /peers/data.</p>
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
          <span>{Object.keys(snapshot.errors ?? {}).length} collection errors</span>
        </div>
      </section>

      {loadError ? <div className="load-notice">Using bundled sample data. QDN load failed: {loadError}</div> : null}

      <div className="workbench">
        <aside className="control-panel" aria-label="Graph controls">
          <ControlContent onToggleKind={toggleKind} visibleKinds={visibleKinds} />
        </aside>

        <section className="map-surface" aria-label="Network topology graph">
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
