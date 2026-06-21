import { useCallback, useEffect, useRef, useState } from 'react';

type ViewBox = { x: number; y: number; w: number; h: number };

type ClientPoint = { x: number; y: number };

export type GraphViewport = {
  viewBox: string;
  bind: {
    onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: (event: React.PointerEvent<SVGSVGElement>) => void;
    onWheel: (event: React.WheelEvent<SVGSVGElement>) => void;
  };
  reset: () => void;
};

const TAP_THRESHOLD_PX = 4;
const WHEEL_FACTOR = 1.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: ClientPoint, b: ClientPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;

  return Math.hypot(dx, dy);
}

export function useGraphViewport(options: {
  width: number;
  height: number;
  onBackgroundTap?: () => void;
}): GraphViewport {
  const { width, height, onBackgroundTap } = options;

  const [viewBox, setViewBox] = useState<ViewBox>({ x: 0, y: 0, w: width, h: height });

  // Latest view box, mirrored into a ref so pointer handlers stay stable and
  // always read fresh values without re-subscribing.
  const viewBoxRef = useRef<ViewBox>(viewBox);
  viewBoxRef.current = viewBox;

  // Active pointers in client coordinates, keyed by pointerId.
  const pointersRef = useRef<Map<number, ClientPoint>>(new Map());

  // Single-pointer gesture bookkeeping.
  const lastSingleRef = useRef<ClientPoint | null>(null);
  const movedRef = useRef(false);

  // Two-pointer (pinch) gesture baseline distance, recomputed each move.
  const pinchDistanceRef = useRef<number | null>(null);

  const applyViewBox = useCallback((next: ViewBox) => {
    viewBoxRef.current = next;
    setViewBox(next);
  }, []);

  const reset = useCallback(() => {
    applyViewBox({ x: 0, y: 0, w: width, h: height });
  }, [applyViewBox, height, width]);

  useEffect(() => {
    applyViewBox({ x: 0, y: 0, w: width, h: height });
  }, [applyViewBox, height, width]);

  // Zoom around a fixed client point, keeping the model coordinate under that
  // point stationary.
  const zoomAt = useCallback(
    (rect: DOMRect, clientX: number, clientY: number, factor: number) => {
      const view = viewBoxRef.current;

      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      const fracX = (clientX - rect.left) / rect.width;
      const fracY = (clientY - rect.top) / rect.height;

      const pointX = view.x + fracX * view.w;
      const pointY = view.y + fracY * view.h;

      const newW = clamp(view.w * factor, width / 6, width * 2.2);
      const newH = view.h * (newW / view.w);

      applyViewBox({
        x: pointX - fracX * newW,
        y: pointY - fracY * newH,
        w: newW,
        h: newH,
      });
    },
    [applyViewBox, width],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      event.preventDefault();

      const factor = event.deltaY > 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
      const rect = event.currentTarget.getBoundingClientRect();

      zoomAt(rect, event.clientX, event.clientY, factor);
    },
    [zoomAt],
  );

  const onPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already gone; ignore.
    }

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 1) {
      // Fresh single-pointer gesture: reset tap/drag tracking.
      lastSingleRef.current = { x: event.clientX, y: event.clientY };
      movedRef.current = false;
    } else if (pointersRef.current.size === 2) {
      // Entering a pinch; (re)establish the distance baseline.
      const points = [...pointersRef.current.values()];
      const a = points[0];
      const b = points[1];

      pinchDistanceRef.current = a && b ? distance(a, b) : null;
    }
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const pointers = pointersRef.current;

      if (!pointers.has(event.pointerId)) {
        return;
      }

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      const rect = event.currentTarget.getBoundingClientRect();

      if (pointers.size === 2) {
        const points = [...pointers.values()];
        const a = points[0];
        const b = points[1];

        if (!a || !b) {
          return;
        }

        const currentDistance = distance(a, b);
        const baseline = pinchDistanceRef.current;

        if (baseline !== null && baseline > 0 && currentDistance > 0) {
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          // Pinching apart (currentDistance > baseline) should zoom in => factor < 1.
          const factor = baseline / currentDistance;

          zoomAt(rect, midX, midY, factor);
        }

        // Recompute baseline incrementally for stability.
        pinchDistanceRef.current = currentDistance;

        return;
      }

      if (pointers.size === 1 && lastSingleRef.current) {
        const view = viewBoxRef.current;

        if (rect.width === 0 || rect.height === 0) {
          return;
        }

        const last = lastSingleRef.current;
        const dxPx = event.clientX - last.x;
        const dyPx = event.clientY - last.y;

        const dxModel = dxPx * (view.w / rect.width);
        const dyModel = dyPx * (view.h / rect.height);

        applyViewBox({
          x: view.x - dxModel,
          y: view.y - dyModel,
          w: view.w,
          h: view.h,
        });

        lastSingleRef.current = { x: event.clientX, y: event.clientY };

        if (Math.hypot(dxPx, dyPx) > 0 && !movedRef.current) {
          const totalDx = event.clientX - last.x;
          const totalDy = event.clientY - last.y;

          if (Math.hypot(totalDx, totalDy) > TAP_THRESHOLD_PX) {
            movedRef.current = true;
          }
        }
      }
    },
    [applyViewBox, zoomAt],
  );

  const endPointer = useCallback(
    (event: React.PointerEvent<SVGSVGElement>, fireTap: boolean) => {
      const pointers = pointersRef.current;
      const wasSingle = pointers.size === 1;

      pointers.delete(event.pointerId);

      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // releasePointerCapture can throw if capture was already lost; ignore.
      }

      if (fireTap && wasSingle && !movedRef.current) {
        onBackgroundTap?.();
      }

      if (pointers.size === 1) {
        // Dropped from a pinch back to a single pointer: reset the pan baseline
        // to the surviving pointer so panning resumes without a jump.
        const remaining = [...pointers.entries()][0];

        lastSingleRef.current = remaining ? { x: remaining[1].x, y: remaining[1].y } : null;
        movedRef.current = true;
        pinchDistanceRef.current = null;
      } else if (pointers.size === 0) {
        lastSingleRef.current = null;
        pinchDistanceRef.current = null;
      }
    },
    [onBackgroundTap],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      endPointer(event, true);
    },
    [endPointer],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      endPointer(event, false);
    },
    [endPointer],
  );

  const onPointerLeave = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // Clean up the pointer if it is still tracked, but never treat leaving as a tap.
      if (pointersRef.current.has(event.pointerId)) {
        endPointer(event, false);
      }
    },
    [endPointer],
  );

  return {
    viewBox: `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      onWheel,
    },
    reset,
  };
}
