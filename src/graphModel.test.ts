import { describe, expect, it } from 'vitest';
import { createGraphModel, EDGE_KINDS, getConnectedNodeIds, parseNetworkSnapshot } from './graphModel';
import { sampleSnapshot } from './sampleData';

describe('network graph model', () => {
  it('creates nodes and filtered edges from a topology snapshot', () => {
    const graph = createGraphModel(sampleSnapshot, new Set(['IP_CHAIN']));

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['L', 'N', 'R']);
    expect(graph.edges.map((edge) => edge.kind)).toEqual(['IP_CHAIN', 'IP_CHAIN']);
  });

  it('derives bidirectional arrowheads from observed inbound and outbound samples', () => {
    const graph = createGraphModel(sampleSnapshot, new Set(EDGE_KINDS));
    const localRegxaChain = graph.edges.find((edge) => edge.source === 'L' && edge.target === 'R' && edge.kind === 'IP_CHAIN');

    expect(localRegxaChain?.direction).toEqual({
      end: true,
      start: true,
      unknown: false,
    });
  });

  it('reports connected nodes for table and graph highlighting', () => {
    const graph = createGraphModel(sampleSnapshot, new Set(EDGE_KINDS));

    expect([...getConnectedNodeIds(graph.edges, 'L')].sort()).toEqual(['N', 'R']);
  });

  it('nudges the focused node closer to the visual center without changing graph membership', () => {
    const base = createGraphModel(sampleSnapshot, new Set(EDGE_KINDS));
    const focused = createGraphModel(sampleSnapshot, new Set(EDGE_KINDS), 'L');
    const baseNode = base.nodes.find((node) => node.id === 'L');
    const focusedNode = focused.nodes.find((node) => node.id === 'L');
    const center = { x: focused.width / 2, y: focused.height / 2 };

    expect(focused.nodes.map((node) => node.id).sort()).toEqual(base.nodes.map((node) => node.id).sort());
    expect(focusedNode).toBeDefined();
    expect(baseNode).toBeDefined();
    expect(Math.hypot(focusedNode!.x - center.x, focusedNode!.y - center.y)).toBeLessThan(
      Math.hypot(baseNode!.x - center.x, baseNode!.y - center.y),
    );
  });

  it('validates loaded snapshot shape', () => {
    expect(parseNetworkSnapshot(JSON.stringify(sampleSnapshot)).generatedAt).toBe(sampleSnapshot.generatedAt);
    expect(() => parseNetworkSnapshot({ nodes: {} })).toThrow(/topology graph data/);
  });
});
