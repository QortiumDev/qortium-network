import type {
  EdgeDirection,
  EdgeKind,
  GraphEdge,
  GraphModel,
  GraphNode,
  NetworkSnapshot,
  NodePosition,
  TopologyData,
  TopologyEdge,
  TopologyNode,
} from './types';

export const EDGE_KINDS: EdgeKind[] = ['IP_CHAIN', 'IP_DATA', 'I2P_CHAIN', 'I2P_DATA'];

export const EDGE_COLORS: Record<EdgeKind, string> = {
  I2P_CHAIN: '#2563eb',
  I2P_DATA: '#f97316',
  IP_CHAIN: '#16a34a',
  IP_DATA: '#dc2626',
  unknown: '#6b7280',
};

const EDGE_ORDER: Record<EdgeKind, number> = {
  IP_CHAIN: 0,
  IP_DATA: 1,
  I2P_CHAIN: 2,
  I2P_DATA: 3,
  unknown: 9,
};

export function getPeerCount(node: Pick<TopologyNode, 'chainCount' | 'dataCount' | 'peerCount'>) {
  if (typeof node.peerCount === 'number') {
    return node.peerCount;
  }

  return (node.chainCount ?? 0) + (node.dataCount ?? 0);
}

export function nodeRadius(node: TopologyNode, maxPeerCount: number) {
  const peerCount = Math.max(1, getPeerCount(node));
  const maxCount = Math.max(1, maxPeerCount);

  return 16 + Math.sqrt(peerCount / maxCount) * 35;
}

function clampNode(
  id: string,
  positions: Map<string, { x: number; y: number }>,
  radii: Map<string, number>,
  width: number,
  height: number,
  summaryHeight: number,
) {
  const coords = positions.get(id);
  const radius = radii.get(id) ?? 20;

  if (!coords) {
    return;
  }

  const left = 70;
  const right = width - 70;
  const top = 60;
  const bottom = height - summaryHeight - 60;
  let x = Math.min(Math.max(coords.x, left + radius), right - radius);
  let y = Math.min(Math.max(coords.y, top + radius), bottom - radius);

  positions.set(id, { x, y });
}

function positionNodes(nodes: TopologyNode[], edges: TopologyEdge[], width: number, height: number, summaryHeight: number) {
  const ids = [...nodes]
    .sort((left, right) => getPeerCount(right) - getPeerCount(left) || left.label.localeCompare(right.label))
    .map((node) => node.id);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  if (ids.length === 0) {
    return new Map<string, NodePosition>();
  }

  const maxPeerCount = Math.max(...nodes.map(getPeerCount), 1);
  const radii = new Map(ids.map((id) => [id, nodeRadius(nodeById.get(id)!, maxPeerCount)]));
  const left = 70;
  const right = width - 70;
  const top = 60;
  const bottom = height - summaryHeight - 46;
  const centerX = width / 2;
  const centerY = (top + bottom) / 2;
  // Group anchors: chain-only left, data-only right, both-type fan to top/bottom
  // from the center, legacy "operator" nodes near center. High-degree nodes
  // still drift to the middle naturally through the edge springs.
  const VALID_GROUPS = new Set(['operator', 'chain', 'data', 'both']);
  const groupOf = new Map(
    ids.map((id) => {
      const group = nodeById.get(id)!.group;

      return [id, group && VALID_GROUPS.has(group) ? group : 'both'] as const;
    }),
  );
  const chainX = left + (right - left) * 0.15;
  const dataX = right - (right - left) * 0.15;

  // --- Country + I2P-balance shaping for peer ("both"/P) nodes --------------
  // Same-country peers attract into neighborhoods; a peer's I2P chain/data edge
  // balance leans it toward the chain (left) or data (right) side, while IP-only
  // peers with no I2P links stay central. C/D nodes have no IP (no country) and
  // keep their hard left/right anchors. Seeds are ordinary "both" peers here.
  // NOTE: app layout only — mirror this in layout_graph() in
  // tools/network-topology-data.py to match the static preview SVG later.
  const countryOf = new Map<string, string>();
  for (const id of ids) {
    const country = nodeById.get(id)!.country;

    if (country) {
      countryOf.set(id, country.toUpperCase());
    }
  }

  const i2pChainDeg = new Map<string, number>();
  const i2pDataDeg = new Map<string, number>();
  for (const edge of edges) {
    const bucket = edge.kind === 'I2P_CHAIN' ? i2pChainDeg : edge.kind === 'I2P_DATA' ? i2pDataDeg : null;

    if (!bucket) {
      continue;
    }

    for (const endpoint of [edge.source, edge.target]) {
      if (groupOf.has(endpoint)) {
        bucket.set(endpoint, (bucket.get(endpoint) ?? 0) + 1);
      }
    }
  }

  const targetXOf = new Map<string, number>();
  for (const id of ids) {
    if (groupOf.get(id) !== 'both') {
      continue;
    }

    const chainLinks = i2pChainDeg.get(id) ?? 0;
    const dataLinks = i2pDataDeg.get(id) ?? 0;
    const total = chainLinks + dataLinks;
    // lean: -1 = all I2P-chain (left) .. +1 = all I2P-data (right). Conviction
    // ramps in over the first few links so one link can't fling a node to a side.
    const lean = total === 0 ? 0 : (dataLinks - chainLinks) / total;
    const conviction = Math.min(1, total / 3);

    targetXOf.set(id, centerX + lean * conviction * (dataX - centerX));
  }

  const members: Record<string, string[]> = { both: [], chain: [], data: [], operator: [] };
  for (const id of ids) {
    members[groupOf.get(id)!]!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const seedLine = (group: string[], axis: 'x' | 'y', fixed: number, lo: number, hi: number) => {
    const count = Math.max(1, group.length);

    group.forEach((id, index) => {
      const value = lo + (hi - lo) * ((index + 0.5) / count);

      positions.set(id, axis === 'x' ? { x: fixed, y: value } : { x: value, y: fixed });
    });
  };

  members.operator!.forEach((id, index) => {
    if (index === 0) {
      positions.set(id, { x: centerX, y: centerY });
    } else {
      const angle = index * Math.PI * (3 - Math.sqrt(5));

      positions.set(id, { x: centerX + Math.cos(angle) * 90, y: centerY + Math.sin(angle) * 90 });
    }
  });
  seedLine(members.chain!, 'x', chainX, top + 40, bottom - 40);
  seedLine(members.data!, 'x', dataX, top + 40, bottom - 40);

  const both = members.both!;

  // Seed peers at their chain/data lean (x) and spread across the vertical band
  // (y); country attraction and repulsion refine the arrangement during relaxation.
  both.forEach((id, index) => {
    const bandT = both.length <= 1 ? 0.5 : (index + 0.5) / both.length;

    positions.set(id, { x: targetXOf.get(id) ?? centerX, y: top + 40 + (bottom - top - 80) * bandT });
  });

  for (const id of ids) {
    if (!positions.has(id)) {
      positions.set(id, { x: centerX, y: centerY });
    }

    clampNode(id, positions, radii, width, height, summaryHeight);
  }

  const weightedEdges = edges
    .filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    .map((edge) => [edge.source, edge.target, Math.max(1, edge.count || 1)] as const);
  const centrality = new Map(ids.map((id) => [id, getPeerCount(nodeById.get(id)!)]));

  for (const [source, target, weight] of weightedEdges) {
    centrality.set(source, (centrality.get(source) ?? 0) + weight);
    centrality.set(target, (centrality.get(target) ?? 0) + weight);
  }

  const maxCentrality = Math.max(...centrality.values(), 1);

  for (let iteration = 0; iteration < 520; iteration += 1) {
    const forces = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    const centroids = new Map<string, { count: number; x: number; y: number }>();

    for (const [id, country] of countryOf) {
      const pos = positions.get(id)!;
      const centroid = centroids.get(country) ?? { count: 0, x: 0, y: 0 };

      centroid.x += pos.x;
      centroid.y += pos.y;
      centroid.count += 1;
      centroids.set(country, centroid);
    }

    for (const centroid of centroids.values()) {
      centroid.x /= centroid.count;
      centroid.y /= centroid.count;
    }

    ids.forEach((a, index) => {
      const aPos = positions.get(a)!;
      for (const b of ids.slice(index + 1)) {
        const bPos = positions.get(b)!;
        const dx = bPos.x - aPos.x;
        const dy = bPos.y - aPos.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const minDistance = (radii.get(a) ?? 20) + (radii.get(b) ?? 20) + 18;
        let repel = 7200 / (distance * distance);

        if (distance < minDistance) {
          repel += (minDistance - distance) * 0.9;
        }

        const fx = (dx / distance) * repel;
        const fy = (dy / distance) * repel;
        const aForce = forces.get(a)!;
        const bForce = forces.get(b)!;

        aForce.x -= fx;
        aForce.y -= fy;
        bForce.x += fx;
        bForce.y += fy;
      }
    });

    for (const [source, target, weight] of weightedEdges) {
      const sourcePos = positions.get(source)!;
      const targetPos = positions.get(target)!;
      const dx = targetPos.x - sourcePos.x;
      const dy = targetPos.y - sourcePos.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = 175 + (radii.get(source) ?? 20) + (radii.get(target) ?? 20) - Math.min(weight, 4) * 12;
      const pull = (distance - desired) * 0.014 * Math.min(weight, 4);
      const fx = (dx / distance) * pull;
      const fy = (dy / distance) * pull;
      const sourceForce = forces.get(source)!;
      const targetForce = forces.get(target)!;

      sourceForce.x += fx;
      sourceForce.y += fy;
      targetForce.x -= fx;
      targetForce.y -= fy;
    }

    for (const id of ids) {
      const pos = positions.get(id)!;
      const force = forces.get(id)!;
      const group = groupOf.get(id)!;
      let ax = force.x;
      let ay = force.y;

      if (group === 'chain') {
        ax += (chainX - pos.x) * 0.013;
        ay += (centerY - pos.y) * 0.0015;
      } else if (group === 'data') {
        ax += (dataX - pos.x) * 0.013;
        ay += (centerY - pos.y) * 0.0015;
      } else if (group === 'both') {
        // Horizontal = chain/data lean; vertical kept gently contained so
        // repulsion + country attraction own the spread.
        ax += ((targetXOf.get(id) ?? centerX) - pos.x) * 0.02;
        ay += (centerY - pos.y) * 0.0016;
      } else {
        const centralPull = 0.004 + 0.01 * ((centrality.get(id) ?? 0) / maxCentrality);

        ax += (centerX - pos.x) * centralPull;
        ay += (centerY - pos.y) * centralPull;
      }

      const country = countryOf.get(id);

      if (country) {
        const centroid = centroids.get(country)!;

        ax += (centroid.x - pos.x) * 0.014;
        ay += (centroid.y - pos.y) * 0.014;
      }

      positions.set(id, { x: pos.x + ax, y: pos.y + ay });
      clampNode(id, positions, radii, width, height, summaryHeight);
    }
  }

  return new Map(
    ids.map((id) => {
      const position = positions.get(id)!;

      return [
        id,
        {
          id,
          radius: radii.get(id) ?? 20,
          x: position.x,
          y: position.y,
        },
      ];
    }),
  );
}

function focusPositions(
  positions: Map<string, NodePosition>,
  edges: TopologyEdge[],
  focusNodeId: string | undefined,
  width: number,
  height: number,
) {
  if (!focusNodeId || !positions.has(focusNodeId)) {
    return positions;
  }

  const next = new Map(positions);
  const focus = positions.get(focusNodeId)!;
  const center = { x: width / 2, y: height / 2 };
  const focusTarget = {
    x: focus.x + (center.x - focus.x) * 0.55,
    y: focus.y + (center.y - focus.y) * 0.55,
  };
  const neighbors = [...getConnectedTopologyNodeIds(edges, focusNodeId)].filter((nodeId) => positions.has(nodeId));

  next.set(focusNodeId, {
    ...focus,
    x: focusTarget.x,
    y: focusTarget.y,
  });

  if (neighbors.length > 0) {
    const ringRadius = Math.min(340, Math.max(190, 120 + neighbors.length * 18));
    const sortedNeighbors = neighbors.sort((left, right) => {
      const leftPos = positions.get(left)!;
      const rightPos = positions.get(right)!;
      const leftAngle = Math.atan2(leftPos.y - focus.y, leftPos.x - focus.x);
      const rightAngle = Math.atan2(rightPos.y - focus.y, rightPos.x - focus.x);

      return leftAngle - rightAngle || left.localeCompare(right);
    });

    sortedNeighbors.forEach((nodeId, index) => {
      const basePosition = positions.get(nodeId)!;
      const angle = -Math.PI / 2 + (index / Math.max(1, sortedNeighbors.length)) * Math.PI * 2;
      const target = {
        x: focusTarget.x + Math.cos(angle) * ringRadius,
        y: focusTarget.y + Math.sin(angle) * ringRadius,
      };

      next.set(nodeId, {
        ...basePosition,
        x: basePosition.x + (target.x - basePosition.x) * 0.75,
        y: basePosition.y + (target.y - basePosition.y) * 0.75,
      });
    });
  }

  const focusedSet = new Set([focusNodeId, ...neighbors]);

  for (const [nodeId, position] of next) {
    if (focusedSet.has(nodeId)) {
      continue;
    }

    const dx = position.x - focusTarget.x;
    const dy = position.y - focusTarget.y;
    const distance = Math.hypot(dx, dy) || 1;

    if (distance < 230) {
      const push = (230 - distance) * 0.35;
      next.set(nodeId, {
        ...position,
        x: position.x + (dx / distance) * push,
        y: position.y + (dy / distance) * push,
      });
    }
  }

  const focusedIds = [...focusedSet].filter((nodeId) => next.has(nodeId));

  for (let iteration = 0; iteration < 24; iteration += 1) {
    for (let leftIndex = 0; leftIndex < focusedIds.length; leftIndex += 1) {
      const leftId = focusedIds[leftIndex];

      if (!leftId) {
        continue;
      }

      const left = next.get(leftId)!;

      for (const rightId of focusedIds.slice(leftIndex + 1)) {
        const right = next.get(rightId)!;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy) || 1;
        const minDistance = left.radius + right.radius + 46;

        if (distance >= minDistance) {
          continue;
        }

        const push = (minDistance - distance) / 2;
        const ux = dx / distance;
        const uy = dy / distance;

        next.set(leftId, {
          ...left,
          x: left.x - ux * push,
          y: left.y - uy * push,
        });
        next.set(rightId, {
          ...right,
          x: right.x + ux * push,
          y: right.y + uy * push,
        });
      }
    }
  }

  for (const [nodeId, position] of next) {
    const radius = position.radius;

    next.set(nodeId, {
      ...position,
      x: Math.min(Math.max(position.x, 70 + radius), width - 70 - radius),
      y: Math.min(Math.max(position.y, 60 + radius), height - 60 - radius),
    });
  }

  return next;
}

function getEdgeDirection(edge: TopologyEdge, topology: TopologyData): EdgeDirection {
  const direction = {
    end: false,
    start: false,
    unknown: false,
  };
  const namedLabels = topology.namedLabels ?? {};

  for (const sample of edge.samples ?? []) {
    const observer = sample.reportedBy ? namedLabels[sample.reportedBy] ?? sample.reportedBy : undefined;

    if (!observer || (observer !== edge.source && observer !== edge.target)) {
      direction.unknown = true;
      continue;
    }

    const observerIsSource = observer === edge.source;
    const normalized = typeof sample.direction === 'string' ? sample.direction.toUpperCase() : '';

    if (normalized === 'OUTBOUND') {
      direction.start ||= !observerIsSource;
      direction.end ||= observerIsSource;
    } else if (normalized === 'INBOUND') {
      direction.start ||= observerIsSource;
      direction.end ||= !observerIsSource;
    } else {
      direction.unknown = true;
    }
  }

  return direction;
}

function createEdgeLine(edge: TopologyEdge, positions: Map<string, NodePosition>, offset: number) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);

  if (!source || !target) {
    return null;
  }

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const ux = dx / length;
  const uy = dy / length;

  return {
    x1: source.x + nx * offset + ux * source.radius,
    y1: source.y + ny * offset + uy * source.radius,
    x2: target.x + nx * offset - ux * target.radius,
    y2: target.y + ny * offset - uy * target.radius,
  };
}

export function createGraphModel(
  snapshot: NetworkSnapshot,
  visibleKinds = new Set<EdgeKind>(EDGE_KINDS),
  focusNodeId?: string,
): GraphModel {
  const topology = snapshot.topology;
  const graphNodes = Object.values(topology.graphNodes ?? {});
  const summaryHeight = 0;
  const width = 1400;
  const height = 1000;
  const visibleEdges = (topology.edges ?? []).filter((edge) => visibleKinds.has(edge.kind));
  const connectedNodeIds = new Set<string>();

  for (const edge of visibleEdges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  const connectedGraphNodes = graphNodes.filter((node) => connectedNodeIds.has(node.id));
  const positions = focusPositions(positionNodes(connectedGraphNodes, visibleEdges, width, height, summaryHeight), visibleEdges, focusNodeId, width, height);
  const nodes: GraphNode[] = connectedGraphNodes.map((node) => ({
    ...node,
    ...(positions.get(node.id) ?? { id: node.id, radius: 20, x: width / 2, y: height / 2 }),
    peerCount: getPeerCount(node),
  }));
  const pairKinds = new Map<string, EdgeKind[]>();

  for (const edge of visibleEdges) {
    const pair = [edge.source, edge.target].sort().join('\0');
    const kinds = pairKinds.get(pair) ?? [];

    kinds.push(edge.kind);
    pairKinds.set(pair, kinds);
  }

  const edges: GraphEdge[] = visibleEdges
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target) ||
        EDGE_ORDER[left.kind] - EDGE_ORDER[right.kind],
    )
    .flatMap((edge) => {
      const pair = [edge.source, edge.target].sort().join('\0');
      const kinds = [...(pairKinds.get(pair) ?? [])].sort((left, right) => EDGE_ORDER[left] - EDGE_ORDER[right]);
      const index = kinds.indexOf(edge.kind);
      const offset = (index - (kinds.length - 1) / 2) * 10;
      const line = createEdgeLine(edge, positions, offset);

      if (!line) {
        return [];
      }

      return [
        {
          ...edge,
          direction: getEdgeDirection(edge, topology),
          id: `${edge.source}-${edge.target}-${edge.kind}`,
          line,
        },
      ];
    });

  return {
    edges,
    height,
    nodes,
    summaryHeight,
    width,
  };
}

export function getConnectedNodeIds(edges: GraphEdge[], nodeId: string) {
  return getConnectedTopologyNodeIds(edges, nodeId);
}

function getConnectedTopologyNodeIds(edges: Pick<TopologyEdge, 'source' | 'target'>[], nodeId: string) {
  const connected = new Set<string>();

  for (const edge of edges) {
    if (edge.source === nodeId) {
      connected.add(edge.target);
    } else if (edge.target === nodeId) {
      connected.add(edge.source);
    }
  }

  return connected;
}

export function parseNetworkSnapshot(value: unknown): NetworkSnapshot {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Network snapshot must be a JSON object.');
  }

  const snapshot = parsed as Partial<NetworkSnapshot>;

  if (!snapshot.topology?.graphNodes || !Array.isArray(snapshot.topology.edges)) {
    throw new Error('Network snapshot is missing topology graph data.');
  }

  return snapshot as NetworkSnapshot;
}
