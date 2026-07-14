/**
 * RemoteCursors — Figma-style live pointers for everyone else in the board.
 *
 * Positions arrive over awareness at ~30 Hz; rendering runs at display rate
 * with exponential smoothing toward the latest point, so cursors glide
 * instead of stuttering. Transforms are written imperatively (refs, not
 * React state) — React only re-renders when the peer list changes.
 */

import { useEffect, useRef, useState } from 'react';
import type { SlateRoom } from '../sync/provider';
import { useCanvasStore } from './store';

interface PeerMeta {
  id: string;
  name: string;
  color: string;
}

export function RemoteCursors({ room }: { room: SlateRoom }) {
  const [peers, setPeers] = useState<PeerMeta[]>([]);
  const targetsRef = useRef(new Map<string, { x: number; y: number }>());
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const elsRef = useRef(new Map<string, HTMLDivElement>());

  useEffect(
    () =>
      room.onAwarenessChange((states) => {
        const remote = states.filter((s) => s.id !== room.identity.peerId && s.cursor);
        const targets = targetsRef.current;
        targets.clear();
        for (const s of remote) targets.set(s.id, { x: s.cursor!.x, y: s.cursor!.y });
        setPeers((prev) => {
          if (
            prev.length === remote.length &&
            prev.every((p, i) => p.id === remote[i]!.id && p.name === remote[i]!.name)
          ) {
            return prev;
          }
          return remote.map((s) => ({ id: s.id, name: s.name, color: s.color }));
        });
      }),
    [room],
  );

  // Display-rate interpolation loop. Damping is time-based so cursors glide
  // identically on 60 Hz and 144 Hz displays; far-away targets teleport so a
  // peer jumping across the board doesn't streak the whole way.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const k = 1 - Math.exp(-dt * 18); // ~55 ms time constant
      const { zoom, panX, panY } = useCanvasStore.getState();
      for (const [id, el] of elsRef.current) {
        const target = targetsRef.current.get(id);
        if (!target) continue;
        let cur = positionsRef.current.get(id);
        if (!cur) {
          cur = { ...target };
          positionsRef.current.set(id, cur);
        }
        const dx = target.x - cur.x;
        const dy = target.y - cur.y;
        if ((dx * dx + dy * dy) * zoom * zoom > 500 * 500) {
          cur.x = target.x;
          cur.y = target.y;
        } else {
          cur.x += dx * k;
          cur.y += dy * k;
        }
        el.style.transform = `translate(${cur.x * zoom + panX}px, ${cur.y * zoom + panY}px)`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (peers.length === 0) return null;
  return (
    <>
      {peers.map((p) => (
        <div
          key={p.id}
          ref={(el) => {
            if (el) elsRef.current.set(p.id, el);
            else {
              elsRef.current.delete(p.id);
              positionsRef.current.delete(p.id);
            }
          }}
          className="pointer-events-none absolute left-0 top-0 z-20 will-change-transform"
          aria-hidden
        >
          <svg width="16" height="18" viewBox="0 0 16 18" className="drop-shadow-md">
            <path
              d="M1.5 1.5 L1.5 13.5 L4.6 10.7 L6.8 15.6 L9.2 14.5 L7 9.8 L11.5 9.4 Z"
              fill={p.color}
              stroke="rgba(0,0,0,0.55)"
              strokeWidth="1"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className="ml-3 -mt-0.5 block w-max max-w-[120px] truncate rounded-full px-1.5 py-px text-[10px] font-medium leading-4 text-black/85 shadow-md"
            style={{ backgroundColor: p.color }}
          >
            {p.name}
          </span>
        </div>
      ))}
    </>
  );
}
