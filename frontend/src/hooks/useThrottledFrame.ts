import { useEffect, useRef } from 'react';

/**
 * Runs `tick` on animation frames, at most every `intervalMs`, while `active`.
 * Intended for writing progress/meter values straight to DOM refs so that
 * fast-changing media time never triggers React renders.
 */
export function useThrottledFrame(tick: () => void, active: boolean, intervalMs = 250): void {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });

  useEffect(() => {
    tickRef.current();
    if (!active) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= intervalMs) {
        last = t;
        tickRef.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, intervalMs]);
}
