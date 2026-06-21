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
  const usableRadius = Math.max(170, Math.min(right - left, bottom - top) * 0.38);
  const positions = new Map<string, { x: number; y: number }>();

  ids.forEach((id, index) => {
    if (index === 0) {
      positions.set(id, { x: centerX, y: centerY });
      return;
    }

    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const radius = usableRadius * Math.sqrt(index / Math.max(1, ids.length - 1));
    positions.set(id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  });

  for (const id of ids) {
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

  for (let iteration = 0; iteration < 260; iteration += 1) {
    const forces = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));

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
      const centralPull = 0.002 + 0.008 * ((centrality.get(id) ?? 0) / maxCentrality);

      positions.set(id, {
        x: pos.x + force.x + (centerX - pos.x) * centralPull,
        y: pos.y + force.y + (centerY - pos.y) * centralPull,
      });
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
