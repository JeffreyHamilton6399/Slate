/**
 * ServerWakeGate — free-tier hosting naps when idle, so the first visitor's
 * requests hang for ~30-60s while the server boots. This gate kicks off the
 * shared availability probe and shows a full-screen overlay while the server
 * looks like it's waking. Static-only hosting resolves silently to
 * local-only mode.
 */

import { useEffect, useState } from 'react';
import { ensureServerProbe, useServerStatus } from '../sync/serverStatus';

const OVERLAY_DELAY_MS = 1500;

export function ServerWakeGate({ children }: { children: React.ReactNode }) {
  const availability = useServerStatus((s) => s.availability);
  const [showOverlay, setShowOverlay] = useState(false);
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    void ensureServerProbe();
    const overlayTimer = setTimeout(() => setShowOverlay(true), OVERLAY_DELAY_MS);
    const tick = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => {
      clearTimeout(overlayTimer);
      clearInterval(tick);
    };
  }, [startedAt]);

  const resolving = availability === 'probing' || availability === 'waking';

  return (
    <>
      {children}
      {resolving && showOverlay && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-bg/95 backdrop-blur-sm"
        >
          <div className="relative h-12 w-12">
            <div className="absolute inset-0 rounded-full border-2 border-border" />
            <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-accent" />
          </div>
          <div className="flex flex-col items-center gap-1.5 px-6 text-center">
            <div className="text-sm font-medium text-text">Waking up the server…</div>
            <div className="max-w-sm text-xs leading-relaxed text-text-dim">
              Free hosting takes a nap when nobody&apos;s around. Starting it back up
              usually takes under a minute — your boards are already safe on this device.
            </div>
            {elapsed >= 5 && (
              <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-text-dim">
                {elapsed}s
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
