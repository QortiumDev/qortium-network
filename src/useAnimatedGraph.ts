import { useEffect, useRef, useState } from 'react';
import type { GraphEdge, GraphModel, GraphNode } from './types';

const ANIMATION_DURATION_MS = 420;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Interpolate a single frame of the graph at progress `t` (0..1, already eased),
 * pulling all non-positional fields from `target` and tweening positions from `previous`.
 */
function interpolateGraph(previous: GraphModel, target: GraphModel, t: number): GraphModel {
  const previousNodes = new Map<string, GraphNode>(previous.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map<string, GraphEdge>(previous.edges.map((edge) => [edge.id, edge]));

  const nodes: GraphNode[] = target.nodes.map((node) => {
    const from = previousNodes.get(node.id);

    if (!from) {
      // Newly appearing node: snap in at its target position.
      return node;
    }

    return {
      ...node,
      radius: lerp(from.radius, node.radius, t),
      x: lerp(from.x, node.x, t),
      y: lerp(from.y, node.y, t),
    };
  });

  const edges: GraphEdge[] = target.edges.map((edge) => {
    const from = previousEdges.get(edge.id);

    if (!from) {
      // Newly appearing edge: snap in at its target line.
      return edge;
    }

    return {
      ...edge,
      line: {
        x1: lerp(from.line.x1, edge.line.x1, t),
        x2: lerp(from.line.x2, edge.line.x2, t),
        y1: lerp(from.line.y1, edge.line.y1, t),
        y2: lerp(from.line.y2, edge.line.y2, t),
      },
    };
  });

  return {
    edges,
    height: target.height,
    nodes,
    summaryHeight: target.summaryHeight,
    width: target.width,
  };
}

/**
 * Smoothly tweens graph node/edge positions toward `target` whenever it changes.
 * Non-positional fields always reflect the latest target; only x/y/radius and edge
 * line coordinates are interpolated over ~420ms with an ease-in-out curve.
 */
export function useAnimatedGraph(target: GraphModel): GraphModel {
  const [displayed, setDisplayed] = useState<GraphModel>(target);
  // Holds the currently-visible model so an interrupted animation resumes from
  // where it is on screen rather than from the stale previous target.
  const displayedRef = useRef<GraphModel>(target);
  const frameRef = useRef<number | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      displayedRef.current = target;

      return;
    }

    if (prefersReducedMotion() || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      displayedRef.current = target;
      setDisplayed(target);

      return;
    }

    const from = displayedRef.current;
    const start = performance.now();

    const step = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / ANIMATION_DURATION_MS);
      const next = interpolateGraph(from, target, easeInOut(progress));

      displayedRef.current = next;
      setDisplayed(next);

      if (progress < 1) {
        frameRef.current = window.requestAnimationFrame(step);
      } else {
        frameRef.current = null;
      }
    };

    frameRef.current = window.requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [target]);

  return displayed;
}
