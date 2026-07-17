/**
 * RemotePlayheads — live audio-transport playhead lines for everyone else in
 * the board who's currently in the AudioEditor.
 *
 * Mirrors the RemoteCursors pattern: positions arrive over awareness at ~7 Hz
 * (throttled on the sender side), but rendering is decoupled from React — the
 * peer LIST lives in React state (changes only on join/leave/enter-audio),
 * while the per-peer playhead X is written imperatively (refs + rAF) so the
 * component never re-renders at the 7 Hz publish rate.
 *
 * Zoom is tracked via `pxRef` (the parent's `pxPerSec` ref) so the remote
 * playheads stay aligned with the local playhead + clips through Ctrl+scroll
 * zoom without the parent having to re-render us when zoom changes.
 */

import { memo, useEffect, useRef } from 'react';
import type { AwarenessState } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';

interface PeerMeta {
  id: string;
  name: string;
  color: string;
}

interface Props {
  room: SlateRoom;
  /** Latest awareness snapshot from the parent (re-renders are diffed away by
   *  the `memo` comparator below — only the peer LIST matters, not positions). */
  peerStates: AwarenessState[];
  /** Parent's pxPerSec ref — read inside the rAF loop so zoom changes are
   *  picked up without a React re-render. */
  pxRef: { current: number };
  selfId: string;
}

function RemotePlayheadsBase({ room, peerStates, pxRef, selfId }: Props) {
  // Peers with an active audio state (in the editor), excluding self.
  const audioPeers: PeerMeta[] = [];
  for (const s of peerStates) {
    if (s.id === selfId) continue;
    if (!s.audio) continue;
    audioPeers.push({ id: s.id, name: s.name, color: s.color });
  }

  const elsRef = useRef(new Map<string, HTMLDivElement>());
  /** peerId → latest playhead position (seconds). Written by the awareness
   *  listener, read by the rAF loop. Decouples awareness frequency from the
   *  display refresh rate. */
  const targetsRef = useRef(new Map<string, number>());

  // Internal awareness subscription — writes positions to refs only.
  // React state is NOT touched here (the parent's `peerStates` prop drives the
  // peer list). This keeps the 7 Hz position stream from re-rendering us.
  useEffect(
    () =>
      room.onAwarenessChange((states) => {
        const targets = targetsRef.current;
        const seen = new Set<string>();
        for (const s of states) {
          if (s.id === selfId) continue;
          if (!s.audio) continue;
          seen.add(s.id);
          targets.set(s.id, s.audio.pos);
        }
        // Drop peers who left the audio editor or disconnected.
        for (const id of [...targets.keys()]) {
          if (!seen.has(id)) targets.delete(id);
        }
      }),
    [room, selfId],
  );

  // rAF loop — writes each peer's `translateX` directly to the DOM.
  // Re-reads `pxRef.current` every frame so zoom changes are applied
  // immediately without a React re-render.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const px = pxRef.current;
      const els = elsRef.current;
      const targets = targetsRef.current;
      for (const [id, el] of els) {
        const pos = targets.get(id);
        if (pos === undefined) continue;
        el.style.transform = `translateX(${pos * px}px)`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pxRef]);

  if (audioPeers.length === 0) return null;
  return (
    <>
      {audioPeers.map((p) => (
        <div
          key={p.id}
          ref={(el) => {
            if (el) elsRef.current.set(p.id, el);
            else {
              elsRef.current.delete(p.id);
              targetsRef.current.delete(p.id);
            }
          }}
          className="pointer-events-none absolute top-0 bottom-0 z-20 opacity-60 will-change-transform"
          aria-hidden
        >
          {/* The vertical line — 1px wide, peer's color, full timeline height. */}
          <div
            className="absolute top-0 bottom-0 w-px"
            style={{ backgroundColor: p.color }}
          />
          {/* Name label — below the ruler (top-7 = 28px) so it doesn't fight
           *  with the ruler's tick labels. Colored pill for quick ID. */}
          <span
            className="absolute top-7 left-0 ml-px block max-w-[80px] truncate rounded-sm px-1 text-[9px] font-medium leading-3 whitespace-nowrap text-black/85 shadow-sm"
            style={{ backgroundColor: p.color }}
          >
            {p.name}
          </span>
        </div>
      ))}
    </>
  );
}

/** Skip re-render when only positions changed. The peer LIST (id/name/color/
 *  audio-presence) is what determines our React output; positions are handled
 *  via refs in the rAF loop. Comparator returns `true` (= equal, skip render)
 *  when the peer set and their stable metadata are unchanged. */
export const RemotePlayheads = memo(RemotePlayheadsBase, (prev, next) => {
  if (
    prev.room !== next.room ||
    prev.selfId !== next.selfId ||
    prev.pxRef !== next.pxRef
  ) {
    return false;
  }
  const a = prev.peerStates;
  const b = next.peerStates;
  if (a.length !== b.length) return false;
  const aMap = new Map(a.map((s) => [s.id, s]));
  for (const y of b) {
    const x = aMap.get(y.id);
    if (!x) return false;
    if (
      x.name !== y.name ||
      x.color !== y.color ||
      !!x.audio !== !!y.audio
    ) {
      return false;
    }
  }
  return true;
});
