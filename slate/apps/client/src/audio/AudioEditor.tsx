/**
 * AudioEditor — CapCut/BandLab-style DAW.
 * Key optimization: waveforms are pre-computed as PNG data URLs cached per
 * clip id + sample count. The canvas only draws ONCE when a clip is first
 * seen or its samples change — not on every version bump.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  Mic, Pause, Play, Plus, Trash2, Volume2, VolumeX, Headphones,
  Music, Upload, Scissors, Repeat, ZoomIn, ZoomOut, Copy, SkipBack,
  ChevronLeft, ChevronRight, Maximize2, Magnet, ClipboardCopy, ClipboardPaste,
  Piano,
} from 'lucide-react';
import type { AudioClip, AudioTrack, AwarenessState } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { toast } from '../ui/Toast';
import {
  addAudioClip, addAudioTrack, addMidiClip, decodeAudioFile, decodeMidiFile,
  deleteAudioClip, deleteAudioTrack, duplicateAudioClip, readAudioClip,
  readAudioTrack, setAudioBpm, splitAudioClip, updateAudioClip, updateAudioTrack,
} from './scene';
import { AudioEngine, SOUNDFONT_PIANO_ID } from './engine';
import { loadSamples } from './sampleStore';
import { AUDIO_LIBRARY, LIBRARY_SAMPLE_RATE, librarySamplePcm } from './library';
import { instrumentKeyCapture, INSTRUMENT_CAPTURE_KEYS, INSTRUMENT_PRESETS, loadCustomInstruments } from './instruments';
import { float32ToNumberArray } from './sampleStore';
import { RemotePlayheads } from './RemotePlayheads';
import { useIsMobile } from '../workspace/useMediaQuery';

/** True while the pointer is over the audio editor. Written here, read by the
 *  2D animation timeline so its Space handler yields to the audio transport
 *  when both are on screen (docked audio panel on a 2D board). */
export const audioEditorHovered = { current: false };

/** Latest playhead position (seconds) — mirrored from positionRef so panels
 *  outside this component (e.g. InstrumentPanel placing a recorded take)
 *  can read the transport position without a React subscription. */
export const audioPlayheadPos = { current: 0 };

const TRACK_H = 60;
/** px-per-sec zoom limits. The min is intentionally tiny (2) so a long mix
 *  (e.g. a 3-minute song = 180s) still fits in a typical viewport at the
 *  widest zoom-out — 180s * 2px = 360px, well within a timeline pane. The
 *  Fit-to-window button uses this as the floor so the computed fit value is
 *  never silently clamped away. */
const MIN_PX_PER_SEC = 2;
const MAX_PX_PER_SEC = 800;
/** Width of the sticky track-header column (Tailwind w-44 = 11rem = 176px).
 *  Used by the Fit-to-window calculation to subtract the header from the
 *  scroll viewport so we fit clips into the visible TIMELINE area only. */
const TRACK_HEADER_W = 176;
/** Magnet-snap capture distance in SCREEN px (converted to seconds at the
 *  current zoom). 8px matches the feel of CapCut/Ableton edge snapping. */
const SNAP_PX = 8;
/** Pointer must travel this many px before a clip pointerdown becomes a drag —
 *  keeps plain select-clicks from nudging the clip by a pixel. */
const DRAG_DEADZONE_PX = 3;

/** Nearest start position at which a clip of `duration` fits without
 *  overlapping any blocker. Merges blockers into occupied intervals, then
 *  picks the gap position closest to `desired`. This replaces the previous
 *  "slide to the nearest side of the current blocker" iteration, which could
 *  ping-pong between two adjacent blockers (each resolution landing on the
 *  other) and exhaust its iteration budget while STILL overlapping —
 *  committing a clip on top of another one. Scanning gaps directly is
 *  deterministic: the open-ended gap after the last blocker always fits, so a
 *  valid position always exists. */
export function nearestFreeStart(desired: number, duration: number, blockersIn: { start: number; end: number }[]): number {
  const eps = 1e-4;
  desired = Math.max(0, desired);
  if (blockersIn.length === 0) return desired;
  const sorted = [...blockersIn].sort((a, b) => a.start - b.start);
  const occupied: { start: number; end: number }[] = [];
  for (const b of sorted) {
    const last = occupied[occupied.length - 1];
    if (last && b.start <= last.end + eps) last.end = Math.max(last.end, b.end);
    else occupied.push({ start: b.start, end: b.end });
  }
  let best = desired;
  let bestDist = Infinity;
  const consider = (lo: number, hi: number) => {
    if (hi - lo < duration - eps) return; // gap too small
    const cand = Math.min(Math.max(desired, lo), hi - duration);
    const dist = Math.abs(cand - desired);
    if (dist < bestDist) { bestDist = dist; best = cand; }
  };
  let prevEnd = 0;
  for (const o of occupied) {
    consider(prevEnd, o.start);
    prevEnd = Math.max(prevEnd, o.end);
  }
  consider(prevEnd, Infinity); // open-ended tail — always fits
  return Math.max(0, best);
}

/** Clamp a multi-clip drag delta so the WHOLE group stays overlap-free.
 *  Each selected clip moves by the same `dt`; for each clip we collect the
 *  range of `dt` values that keep it off its non-selected neighbours on the
 *  same track, then intersect those ranges across all clips. If the desired
 *  `dt` falls outside the intersection, we clamp to the nearest bound — so a
 *  group dragged into a wall stops flush against it instead of teleporting
 *  past. The origin track per clip is used (multi-drag is horizontal-only —
 *  no cross-track reshuffle, which would be ambiguous for a group). */
function clampGroupDt(
  dt: number,
  origins: Map<string, { os: number; od: number; trackId: string }>,
  byTrack: Map<string, { start: number; end: number }[]>,
): number {
  let minRight = Infinity; // upper bound on dt (blocker to the right of a clip)
  let maxLeft = -Infinity; // lower bound on dt (blocker to the left of a clip)
  for (const o of origins.values()) {
    const blockers = byTrack.get(o.trackId) ?? [];
    for (const b of blockers) {
      // Blocker entirely to the LEFT of the clip's origin → moving LEFT past
      // it would overlap. Constraint: dt >= b.end - o.os.
      if (b.end <= o.os + 1e-4) {
        maxLeft = Math.max(maxLeft, b.end - o.os);
      }
      // Blocker entirely to the RIGHT of the clip's origin → moving RIGHT past
      // it would overlap. Constraint: dt <= b.start - o.os - o.od.
      else if (b.start >= o.os + o.od - 1e-4) {
        minRight = Math.min(minRight, b.start - o.os - o.od);
      }
      // A blocker that straddles the clip's original interval would mean the
      // clip was ALREADY overlapping before the drag — ignore (shouldn't happen).
    }
  }
  if (maxLeft > minRight) return 0; // conflicting constraints — no movement
  return Math.max(maxLeft, Math.min(minRight, dt));
}

// ── Waveform cache: pre-computed PNG data URLs ───────────────────────────────
// Key: `${clipId}:${sampleCount}:${width}` → data URL
const waveformPNGCache = new Map<string, string>();

// Draw only the window [startFrame, endFrame) of the sample across `width`
// pixels. Rendering the *window* (not the whole sample stretched) is what makes
// trimming look like cutting the audio away rather than squashing it.
function computeWaveformPNG(samples: Float32Array, channels: number, width: number, color: string, height: number, startFrame: number, endFrame: number): string {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(2, Math.floor(width));
  canvas.width = w * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, height);
  const totalFrames = samples.length / channels;
  const s = Math.max(0, Math.min(totalFrames, Math.floor(startFrame)));
  const e = Math.max(s, Math.min(totalFrames, Math.floor(endFrame)));
  const span = e - s;
  if (span <= 0) return canvas.toDataURL();
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const f0 = s + Math.floor((x / w) * span);
    const f1 = Math.min(e, s + Math.floor(((x + 1) / w) * span) + 1);
    let peak = 0;
    for (let i = f0; i < f1; i++) { const v = Math.abs(samples[i * channels] ?? 0); if (v > peak) peak = v; }
    const bh = Math.max(1, peak * mid * 0.85);
    ctx.fillRect(x, mid - bh, 1, bh * 2);
  }
  return canvas.toDataURL();
}

/** Waveform image for the buffer window the clip actually plays. With speed s,
 *  a clip of `duration` timeline seconds consumes `duration*s` buffer seconds.
 *
 *  Two robustness fixes:
 *  1. If `loadSamples` returns an EMPTY Float32Array (length 0) — which happens
 *     when a freshly-split/created clip's IndexedDB write hasn't landed yet —
 *     we DON'T cache the resulting blank PNG. Instead we show the `···`
 *     placeholder and retry a few times (500ms apart) so the real waveform
 *     appears once the samples are available.
 *  2. We listen for `slate:audio-clip-changed` (fired by Normalize/Reverse/split)
 *     and invalidate our cache entry for the current clipId, then force a
 *     recompute via a `bust` counter — otherwise the memoised component would
 *     keep showing the stale PNG even after the cache was cleared. */
const WaveformImg = memo(function WaveformImg({ clipId, sampleKey, channels, sampleRate, offset, duration, speed, width, color }: {
  clipId: string; sampleKey: string; channels: number; sampleRate: number;
  offset: number; duration: number; speed: number; width: number; color: string;
}) {
  const height = TRACK_H - 6;
  const [imgUrl, setImgUrl] = useState<string>('');
  const [bust, setBust] = useState(0);
  const retryRef = useRef(0);

  // Invalidate cached PNGs for this clip when its samples change (normalize /
  // reverse / split). The parent AudioEditor also invalidates + bumps version,
  // but the memoised WaveformImg wouldn't otherwise recompute (its primitive
  // props are unchanged) — the `bust` counter forces the load effect to re-run.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      // Match by clipId (normalize/reverse/split events) OR by sampleKey
      // (multiplayer sample-arrival events from registerSampleSyncMap).
      if (detail !== clipId && detail !== sampleKey) return;
      for (const key of waveformPNGCache.keys()) {
        if (key.startsWith(`${clipId}:`)) waveformPNGCache.delete(key);
      }
      retryRef.current = 0;
      setBust((n) => n + 1);
    };
    window.addEventListener('slate:audio-clip-changed', onChanged as EventListener);
    return () => window.removeEventListener('slate:audio-clip-changed', onChanged as EventListener);
  }, [clipId, sampleKey]);

  useEffect(() => {
    const startFrame = Math.round(offset * sampleRate);
    const endFrame = Math.round((offset + duration * speed) * sampleRate);
    const cacheKey = `${clipId}:${sampleKey}:${startFrame}:${endFrame}:${Math.floor(width)}`;
    const cached = waveformPNGCache.get(cacheKey);
    if (cached) { setImgUrl(cached); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled) return;
      void loadSamples(sampleKey).then((samples) => {
        if (cancelled) return;
        // Empty samples = the IndexedDB write for this sampleKey hasn't landed
        // yet (e.g. brand-new clip from a split, OR a remote peer's clip whose
        // sample blob is still in flight via the Yjs sync map). DON'T cache a
        // blank PNG — retry for up to 10s (20 × 500ms) so the real waveform
        // appears once the samples arrive. The previous 5-retry / 2.5s budget
        // was too short for cross-peer sample sync, which can take several
        // seconds for a 5MB blob over a slow link. The `slate:audio-clip-changed`
        // event (dispatched by onClipsAdded when a remote clip is added, and by
        // registerSampleSyncMap when samples arrive) resets `retryRef` to 0 so
        // the WaveformImg re-tries immediately on the signal — this retry
        // budget is the safety net for the case where the event fires before
        // the WaveformImg mounts, or doesn't fire at all.
        if (samples.length === 0) {
          if (retryRef.current < 20) {
            retryRef.current += 1;
            retryTimer = setTimeout(attempt, 500);
          }
          return;
        }
        retryRef.current = 0;
        const url = computeWaveformPNG(samples, channels, width, color, height, startFrame, endFrame);
        waveformPNGCache.set(cacheKey, url);
        setImgUrl(url);
      });
    };
    attempt();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [clipId, sampleKey, channels, sampleRate, offset, duration, speed, width, color, height, bust]);

  if (!imgUrl) return <div className="flex h-full items-center justify-center text-[7px] text-text-dim">···</div>;
  return <img src={imgUrl} alt="" className="pointer-events-none h-full w-full" style={{ objectFit: 'fill' }} />;
});

/** Drop cached waveform PNGs for a clip (call when its samples change). */
function invalidateWaveform(clipId: string): void {
  for (const key of waveformPNGCache.keys()) if (key.startsWith(`${clipId}:`)) waveformPNGCache.delete(key);
}

// ── Main ────────────────────────────────────────────────────────────────────

export function AudioEditor() {
  const room = useRoom();
  const slate = room.slate;
  const isMobile = useIsMobile();
  const [version, setVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpmState] = useState(slate.audioBpm());
  const [metronome, setMetronome] = useState(false);
  const [recording, setRecording] = useState(false);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [masterVol, setMasterVol] = useState(0.85);
  const [looping, setLooping] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(8);
  const [pxPerSec, setPxPerSec] = useState(80);
  /** Magnet snapping (beat grid + clip edges + playhead) for drags/trims.
   *  On by default like every DAW; hold Alt for free movement. */
  const [snapOn, setSnapOn] = useState(true);
  const snapRef = useRef(true);
  snapRef.current = snapOn;
  const engineRef = useRef<AudioEngine | null>(null);
  const stopRecRef = useRef<(() => Promise<{ samples: number[]; sampleRate: number; channels: number; duration: number }>) | null>(null);
  const rafRef = useRef(0);
  const positionRef = useRef(0);
  // Refs mirror the latest `playing` and `slate` so the long-lived Yjs / event
  // listeners (which close over the initial render) can read fresh values
  // without re-subscribing on every state change.
  const playingRef = useRef(false);
  playingRef.current = playing;
  const hoveredRef = audioEditorHovered;
  const slateRef = useRef(slate);
  slateRef.current = slate;
  /** Debounce timer for restartPlayback — coalesces rapid clip/sample changes
   *  so we don't tear down and rebuild the scheduler 5× in a row when a peer
   *  adds several clips at once. */
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const posDisplayRef = useRef<HTMLSpanElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    clipId: string; el: HTMLElement; waveEl: HTMLElement | null;
    os: number; od: number; oo: number; speed: number; sx: number; sy: number;
    leftLimit: number; rightLimit: number; mode: 'drag' | 'trimL' | 'trimR';
    /** Same-track clip bounds per track id (dragged clip excluded) — overlap
     *  resolution consults the CURRENT target track, not just the origin. */
    byTrack: Map<string, { start: number; end: number }[]>;
    /** Track ids in display order + the dragged clip's origin index — used to
     *  map vertical pointer travel to a target track. */
    trackIds: string[]; trackIndex: number;
    /** Current vertical row offset (0 = origin track). Written by applyMove,
     *  committed on pointerup. */
    rowDelta: number;
    /** Magnet candidates: every other clip's start/end + playhead + 0. Beat
     *  grid is handled analytically (round to the nearest beat). */
    snapTimes: number[];
    /** True once the pointer left the dead zone — a plain click never mutates
     *  the clip. */
    moved: boolean;
    /** MULTI-SELECT DRAG: when the user drags a clip that's part of a
     *  multi-selection, every selected clip moves together by the same delta.
     *  `origins` stores the original position + DOM element of EACH selected
     *  clip so applyMove can update them all and onUp can commit them all to
     *  Yjs. Undefined (or empty) for single-clip drags + all trims. */
    origins?: Map<string, {
      el: HTMLElement; waveEl: HTMLElement | null;
      os: number; od: number; oo: number; trackId: string;
    }>;
  } | null>(null);
  /** Latest pointer `clientX` during an active drag — written by every
   *  `pointermove` and read inside a `requestAnimationFrame` callback. Decouples
   *  the high-frequency pointermove stream (~60-120Hz on modern pointers) from
   *  the actual DOM-mutation work, so multiple moves within the same frame
   *  coalesce into a single `style.left`/`style.width` write. Null when no
   *  drag is in progress. */
  const moveXRef = useRef<number | null>(null);
  /** Latest pointer `clientY` (cross-track dragging) + Alt state (snap bypass)
   *  — same rAF-coalescing pattern as moveXRef. */
  const moveYRef = useRef<number>(0);
  const moveAltRef = useRef(false);
  /** Pending rAF id for processing the next drag move. Zero when no frame is
   *  scheduled. Lets `onMove` bail out cheaply (one ref read + one rAF check)
   *  when a frame is already queued. */
  const moveRafRef = useRef(0);
  const marqueeRef = useRef<{ startX: number; startY: number; seekTime: number; origin: Set<string>; additive: boolean; moved: boolean } | null>(null);
  const selectedRef = useRef<Set<string>>(new Set());
  selectedRef.current = selectedClipIds;
  const clipsRef = useRef<AudioClip[]>([]);
  const tracksRef = useRef<AudioTrack[]>([]);
  const pxRef = useRef(pxPerSec);
  pxRef.current = pxPerSec;
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  /** Desired scrollLeft to apply after the next pxPerSec commit (used by
   *  zoomAtPlayhead so the playhead stays at the same screen position when
   *  zooming). Cleared in the layout effect below once applied. */
  const pendingScrollRef = useRef<number | null>(null);
  /** Timestamp (performance.now ms) of the last awareness publish of our audio
   *  playhead position. The tick rAF loop throttles publishes to ~7 Hz (150ms)
   *  so a long play session doesn't saturate the awareness broadcast — peers
   *  render at display rate via their own rAF, so 7 Hz is plenty for smooth
   *  remote-playhead motion. */
  const lastAudioPublishRef = useRef(0);
  /** Snapshot of remote peer awareness states — passed to RemotePlayheads.
   *  The diffing setPeerStates below skips updates that only change high-
   *  frequency fields (audio.pos), so we don't re-render AudioEditor at 7 Hz. */
  const [peerStates, setPeerStates] = useState<AwarenessState[]>([]);

  /** Schedule a debounced restartPlayback (500ms). Called when the clip set
   *  changes mid-playback (remote peer adds a clip) or when a clip's samples
   *  arrive after play started (remote sample blob landed via the sync map).
   *  The debounce coalesces rapid bursts so we don't tear down and rebuild
   *  the scheduler repeatedly. No-op when not playing. Reads only refs, so the
   *  callback identity is stable for the lifetime of the component. */
  const scheduleRestart = useCallback(() => {
    if (!playingRef.current) return;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      const eng = engineRef.current;
      if (eng && playingRef.current) eng.restartPlayback(slateRef.current, positionRef.current);
    }, 500);
  }, []);

  // Subscribe to awareness changes. Diffing skips updates that only change
  // high-frequency fields (audio.pos) so the parent doesn't re-render at the
  // 7 Hz publish rate — RemotePlayheads subscribes itself for live positions.
  useEffect(
    () =>
      room.onAwarenessChange((states) => {
        setPeerStates((prev) => {
          if (prev.length !== states.length) return states;
          // Stable peer-set key — id + name + color + audio-presence.
          // Position/playing/cursor/cam/voiceLevel changes are intentionally
          // excluded so they don't trigger a re-render.
          const key = (s: AwarenessState) =>
            `${s.id}|${s.name}|${s.color}|${s.audio ? 1 : 0}`;
          const prevKey = prev.map(key).sort().join(';');
          const nextKey = states.map(key).sort().join(';');
          return prevKey === nextKey ? prev : states;
        });
      }),
    [room],
  );

  // Publish our audio playhead state whenever transport play/pause changes.
  // Reads positionRef.current at effect-run time so the published position is
  // always the latest. Also resets the throttle stamp so the rAF loop doesn't
  // immediately re-publish.
  useEffect(() => {
    room.setLocalAwareness({ audio: { pos: positionRef.current, playing } });
    lastAudioPublishRef.current = performance.now();
  }, [playing, room]);

  // Clear our audio playhead on unmount so other peers stop seeing us in the
  // audio editor. (audio: null = "not in the audio editor".)
  useEffect(() => {
    return () => {
      room.setLocalAwareness({ audio: null });
    };
  }, [room]);

  // Yjs subscription.
  useEffect(() => {
    // NOTE: registerSampleSyncMap(room) is now called from useSlateRoom's
    // attach() — registering here only on AudioEditor mount meant a peer on
    // a 2D/3D board (audio panel closed) never registered the sync map and
    // never received remote sample blobs. See useSlateRoom.ts.
    const tracks = slate.audioTracks();
    const clips = slate.audioClips();
    const audioMap = slate.doc.getMap('audio');
    let pending = false;
    const bump = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; setVersion((v) => v + 1); }); };
    // Any track edit (volume, pan, EQ, sends, mute/solo — local knob or remote
    // peer) re-applies the Yjs values to the live audio graph, so the settings
    // panel is audible mid-playback without a restart.
    //
    // REMOTE MUTE/SOLO FIX: this subscription is what makes "user A mutes a
    // track → user B hears the mute" work. The mute state IS in Yjs (it's a
    // field on the track Y.Map), so it syncs to every peer. But sync alone
    // doesn't affect the audio graph — the local engine's per-track gain
    // nodes still hold the old value until something re-applies them.
    // `applyTracks` is that "something": it reads the fresh Yjs tracks and
    // calls `setupTrackNodes`, which writes `gain.gain.value = audible ?
    // volume : 0` per track (audible = solo ? track.solo : !track.muted).
    // Without this subscription, remote mute/solo edits would land in Yjs
    // (visible in the TrackHeader) but never reach the audio graph until the
    // user pressed stop/play (which re-runs setupTrackNodes via play()).
    const applyTracks = () => { engineRef.current?.updateTracks(slateRef.current); };
    // Clip edits (position, trim, gain, pan, filters, speed/pitch — ours or a
    // peer's) reschedule playback so they're audible mid-play. Debounced 500ms
    // in scheduleRestart and a no-op while paused, so knob drags coalesce into
    // one restart instead of stuttering. Track edits deliberately DON'T
    // restart — applyTracks adjusts their nodes live.
    const restartOnClipEdit = () => { scheduleRestart(); };
    tracks.observeDeep(bump); clips.observeDeep(bump); audioMap.observe(bump); bump();
    tracks.observeDeep(applyTracks);
    clips.observeDeep(restartOnClipEdit);
    // Detect NEW clips being added while playing and schedule a debounced
    // restartPlayback so the new clip is picked up mid-playback without a
    // manual stop/play. We watch the shallow clips map (not observeDeep) so
    // we only react to key additions, not to every property edit on an
    // existing clip (which would restart playback every time a peer nudged
    // a clip's volume, fighting the user). The restart is debounced 500ms so
    // a burst of additions (e.g. a peer imports 5 files) coalesces into one.
    //
    // LIVE WAVEFORM REFRESH: when a remote peer adds a clip, its metadata
    // arrives via Yjs immediately but the sample blob travels separately via
    // the audioSampleSync Y.Map (see sampleStore.ts). If we don't ping the
    // WaveformImg, it might have already exhausted its empty-samples retry
    // budget (now 10s, but a slow link can still exceed that) and given up
    // showing a blank "···" placeholder until the user refreshes. So for
    // each newly-added clip we:
    //   1. clearCache(clipId) on the engine so the next play re-loads samples
    //      (the cache might hold a null/empty entry from a prior failed getBuffer)
    //   2. dispatch `slate:audio-clip-changed` with the clipId — the
    //      AudioEditor's listener (below) re-invalidates the waveform cache +
    //      clears the engine cache + bumps version, AND the WaveformImg's own
    //      listener resets its retryRef to 0 and bumps `bust` to immediately
    //      re-attempt loadSamples (which will now find the synced blob once
    //      it lands).
    //   3. scheduleRestart() so if we're currently playing, the new clip is
    //      picked up atomically (debounced 500ms to coalesce bursts).
    const onClipsAdded = (event: Y.YMapEvent<Y.Map<unknown>>) => {
      const addedIds: string[] = [];
      for (const key of event.keysChanged) {
        const change = event.changes.keys.get(key);
        if (change?.action === 'add') addedIds.push(key);
      }
      if (addedIds.length === 0) return;
      for (const id of addedIds) {
        engineRef.current?.clearCache(id);
        window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: id }));
      }
      scheduleRestart();
    };
    clips.observe(onClipsAdded);
    const lateRead = setTimeout(bump, 200);
    return () => { clearTimeout(lateRead); tracks.unobserveDeep(bump); tracks.unobserveDeep(applyTracks); clips.unobserveDeep(bump); clips.unobserveDeep(restartOnClipEdit); audioMap.unobserve(bump); clips.unobserve(onClipsAdded); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate]);

  /** Undo/redo for audio edits (move/trim/add/delete of tracks + clips).
   *  Y.UndoManager only captures LOCAL transactions (origin null), so a
   *  peer's edits are never undone from this client. Sample blobs stay in
   *  IndexedDB when a clip is deleted (see scene.ts) so an undone delete
   *  comes back playable. */
  const undoRef = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    const um = new Y.UndoManager([slate.audioTracks(), slate.audioClips()], {
      captureTimeout: 300,
    });
    undoRef.current = um;
    return () => {
      um.destroy();
      undoRef.current = null;
    };
  }, [slate]);

  useEffect(() => {
    engineRef.current = new AudioEngine();
    engineRef.current.setMasterVolume(masterVol);
    return () => {
      // Cancel any pending restart so it doesn't fire after dispose().
      if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
      engineRef.current?.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playhead — direct DOM.
  useEffect(() => {
    if (!playing) {
      // Playback just stopped — cancel any pending mid-playback restart so
      // it doesn't fire and call restartPlayback (which would re-start audio
      // after the user pressed pause).
      if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
      return;
    }
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const eng = engineRef.current; if (!eng) return;
      const pos = eng.getPosition();
      positionRef.current = pos;
      audioPlayheadPos.current = pos;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${pos * pxRef.current}px)`;
      if (posDisplayRef.current) posDisplayRef.current.textContent = `${pos.toFixed(1)}s`;
      // Throttled awareness publish at ~7 Hz (150ms) — peers render at display
      // rate via their own rAF, so 7 Hz is plenty for smooth remote playhead
      // motion while keeping the awareness broadcast off the hot path.
      const now = performance.now();
      if (now - lastAudioPublishRef.current >= 150) {
        lastAudioPublishRef.current = now;
        room.setLocalAwareness({ audio: { pos, playing: true } });
      }
      if (pos > timelineDuration + 2) { eng.stop(); setPlaying(false); }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Ctrl+scroll zoom — centred on the playhead so the screen position under
  // the cursor/playhead stays put instead of zooming toward the left edge.
  /** Zoom while keeping one timeline point at the same screen offset.
   *  The anchor is the time under `anchorClientX` (mouse-wheel zoom: the spot
   *  under the cursor stays put — how every DAW/map zoom feels), or the
   *  playhead when no anchor is given (toolbar buttons, fit-to-window).
   *  Keeping time t fixed on screen means newScroll = oldScroll + t·Δpps,
   *  since screenX(t) = timelineLeft − scrollLeft + t·pps. The `scrollLeft`
   *  write happens in the layout effect below (after React commits the new
   *  `minWidth` on the timeline div — setting it earlier would be clamped by
   *  the stale `scrollWidth`). */
  const zoomAnchored = useCallback((newPxPerSec: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    const oldPxPerSec = pxRef.current;
    if (!el || oldPxPerSec === newPxPerSec) {
      setPxPerSec(newPxPerSec);
      return;
    }
    let t = positionRef.current; // default anchor: the playhead
    if (anchorClientX !== undefined) {
      const tl = el.querySelector('[data-timeline]') as HTMLElement | null;
      if (tl) t = Math.max(0, (anchorClientX - tl.getBoundingClientRect().left) / oldPxPerSec);
    }
    pendingScrollRef.current = Math.max(0, el.scrollLeft + t * (newPxPerSec - oldPxPerSec));
    setPxPerSec(newPxPerSec);
  }, []);

  // Apply any pending scroll correction after pxPerSec commits to the DOM.
  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [pxPerSec]);

  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, pxRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      zoomAnchored(next, e.clientX); // zoom toward the cursor
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAnchored]);

  // Global pointermove/up — pure DOM, zero React state.
  // rAF-throttled: pointermove fires at the hardware's report rate (often
  // 60-120Hz), and the move handler does a neighbours-overlap scan on every
  // event. Coalescing multiple moves into a single rAF callback caps the work
  // at the display refresh rate (~60fps) so a fast pointer drag never stalls
  // the main thread. A no-op skip (cursor hasn't moved since the last
  // processed frame) avoids redundant DOM writes for stationary pointers.
  useEffect(() => {
    /** Last pointer position we actually applied to the DOM. Lets us skip
     *  work when pointermove fires without real movement (e.g. a touchpad
     *  reporting pressure changes, or sub-pixel jitter). */
    let lastProcessedX: number | null = null;
    let lastProcessedY: number | null = null;

    /** Magnet: pull `t` (a clip START time) to the nearest beat line, other
     *  clip edge, or the playhead — considering BOTH the clip's start and end
     *  edges — if one is within SNAP_PX at the current zoom. `dur` null =
     *  only the start edge matters (trims). Returns the adjusted start. */
    const snapStart = (t: number, dur: number | null, snapTimes: number[]): number => {
      const pps = pxRef.current;
      const thr = SNAP_PX / pps;
      const beat = 60 / bpmRef.current;
      let best = t;
      let bestDist = thr;
      const consider = (target: number, edgeOffset: number) => {
        const dist = Math.abs(t + edgeOffset - target);
        if (dist < bestDist) { bestDist = dist; best = target - edgeOffset; }
      };
      consider(Math.round(t / beat) * beat, 0);
      if (dur !== null) consider(Math.round((t + dur) / beat) * beat, dur);
      for (const st of snapTimes) {
        consider(st, 0);
        if (dur !== null) consider(st, dur);
      }
      return best;
    };

    const applyMove = () => {
      moveRafRef.current = 0;
      const d = dragRef.current;
      if (!d) return;
      const clientX = moveXRef.current;
      if (clientX === null) return;
      const clientY = moveYRef.current;
      // Skip no-op moves — cursor hasn't moved to a new pixel since the last
      // frame we processed. Saves an overlap scan + 1-2 style writes.
      if (lastProcessedX === clientX && lastProcessedY === clientY) return;
      lastProcessedX = clientX;
      lastProcessedY = clientY;

      // Dead zone: a plain click (pointer never leaves a 3px box) must not
      // nudge the clip. Once exceeded, the drag is live for good.
      if (!d.moved) {
        if (Math.abs(clientX - d.sx) < DRAG_DEADZONE_PX && Math.abs(clientY - d.sy) < DRAG_DEADZONE_PX) return;
        d.moved = true;
        if (d.mode === 'drag') {
          d.el.style.zIndex = '40'; // ride above other rows while crossing tracks
          // Elevate the whole group too so the user sees the multi-clip
          // selection ride above non-selected neighbours while in transit.
          if (d.origins) for (const o of d.origins.values()) if (o.el !== d.el) o.el.style.zIndex = '40';
        }
      }

      const pps = pxRef.current;
      const dt = (clientX - d.sx) / pps;
      const oldEnd = d.os + d.od;
      const wantSnap = snapRef.current && !moveAltRef.current;
      if (d.mode === 'drag') {
        // MULTI-SELECT DRAG: when `origins` is populated, every selected clip
        // moves by the same horizontal delta. Vertical track-switching is
        // disabled for the group (each clip stays on its origin track) since
        // reshuffling every selected clip onto one target track would be
        // ambiguous and likely overlap-prone. The dragged clip's snap result
        // is applied to the whole group so the magnet still feels right.
        if (d.origins && d.origins.size > 0) {
          const dragged = d.origins.get(d.clipId);
          let snappedDt = dt;
          if (wantSnap && dragged) {
            const snappedStart = snapStart(dragged.os + dt, dragged.od, d.snapTimes);
            snappedDt = snappedStart - dragged.os;
          }
          for (const o of d.origins.values()) {
            const newStart = Math.max(0, o.os + snappedDt);
            o.el.style.left = `${newStart * pps}px`;
          }
          return;
        }
        // The clip follows the mouse 1:1 (snapped to the magnet grid). It's
        // allowed to ride OVER other clips while the drag is live — it's
        // elevated to z-40 so the overlap reads as "in transit", and the
        // no-overlap invariant is enforced once, on drop (see onUp). The
        // previous mid-drag resolution parked the clip flush against a
        // blocker and then teleported it across when the cursor passed the
        // blocker's midpoint, which made dragging feel sticky and jumpy.
        const duration = d.od;
        // Vertical: whole-row steps move the clip across tracks.
        const rowDelta = Math.max(
          -d.trackIndex,
          Math.min(d.trackIds.length - 1 - d.trackIndex, Math.round((clientY - d.sy) / TRACK_H)),
        );
        d.rowDelta = rowDelta;
        d.el.style.transform = rowDelta === 0 ? '' : `translateY(${rowDelta * TRACK_H}px)`;

        const desired = wantSnap ? snapStart(d.os + dt, duration, d.snapTimes) : d.os + dt;
        d.el.style.left = `${Math.max(0, desired) * pps}px`;
      } else if (d.mode === 'trimL') {
        // Cut from the left: never past the left neighbour, the source start
        // (offset ≥ 0 → limited by the trimmed head in timeline seconds), or a
        // minimum width.
        const minStart = Math.max(d.leftLimit, d.os - d.oo / d.speed);
        const desired = wantSnap ? snapStart(d.os + dt, null, d.snapTimes) : d.os + dt;
        const start = Math.min(oldEnd - 0.1, Math.max(minStart, desired));
        d.el.style.left = `${start * pps}px`;
        d.el.style.width = `${(oldEnd - start) * pps}px`;
        // Shift the (fixed-width) waveform the opposite way so the audio stays
        // anchored — the newly-trimmed head is clipped, not squashed.
        if (d.waveEl) d.waveEl.style.left = `${-(start - d.os) * pps}px`;
      } else if (d.mode === 'trimR') {
        // Cut from the right: never past the right neighbour or a min width.
        const desired = wantSnap ? snapStart(oldEnd + dt, null, d.snapTimes) : oldEnd + dt;
        const end = Math.min(d.rightLimit, Math.max(d.os + 0.1, desired));
        d.el.style.width = `${(end - d.os) * pps}px`;
      }
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      // Stash the latest pointer state — the rAF callback reads it. Cheap
      // (ref writes) so even 120Hz pointermove streams don't pile up work.
      moveXRef.current = ev.clientX;
      moveYRef.current = ev.clientY;
      moveAltRef.current = ev.altKey;
      // Schedule a frame if one isn't already pending. The guard is what
      // coalesces multiple moves within the same frame into one DOM write.
      if (!moveRafRef.current) {
        moveRafRef.current = requestAnimationFrame(applyMove);
      }
    };
    const onUp = () => {
      const d = dragRef.current; if (!d) return;
      // Cancel any pending rAF — we'll process the final position
      // SYNCHRONOUSLY here so the committed Yjs value reflects the exact
      // pointer-up location (otherwise the last pointermove before pointerup
      // could be dropped, leaving the committed position ~1 frame behind the
      // cursor). lastProcessed is reset to bypass the no-op skip in case the
      // final pointermove matched the prior processed frame but we still need
      // to read the just-written style to commit to Yjs.
      if (moveRafRef.current) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = 0;
      }
      if (moveXRef.current !== null) {
        lastProcessedX = null; // bypass the no-op skip on the final flush
        lastProcessedY = null;
        applyMove();
      }
      // Undo the drag-only visual state React doesn't manage. For a multi-clip
      // drag, also clear the elevated z-index on every selected clip's element.
      if (d.origins) for (const o of d.origins.values()) { o.el.style.zIndex = ''; o.el.style.transform = ''; }
      d.el.style.zIndex = '';
      d.el.style.transform = '';
      // A click that never left the dead zone selects but must not write —
      // committing a parseFloat round-trip of the style would drift the clip.
      if (d.moved) {
        const pps = pxRef.current;
        const left = parseFloat(d.el.style.left) / pps;
        const width = parseFloat(d.el.style.width) / pps;
        if (d.mode === 'drag') {
          // MULTI-SELECT COMMIT: every selected clip moves by the same delta,
          // clamped so the group stays overlap-free against non-selected
          // neighbours on each clip's origin track. The delta is recomputed
          // from the dragged clip's pointer-up position (so the snapped /
          // clamped value the user sees is what gets committed), then applied
          // to every clip in the group via updateAudioClip inside a single
          // Yjs transaction.
          if (d.origins && d.origins.size > 0) {
            const dragged = d.origins.get(d.clipId);
            const dt = dragged ? left - dragged.os : 0;
            const clampedDt = clampGroupDt(dt, d.origins, d.byTrack);
            // Write the resolved positions to the DOM too so there's no
            // flicker between pointer-up and the Yjs-driven re-render.
            for (const o of d.origins.values()) {
              const newStart = Math.max(0, o.os + clampedDt);
              o.el.style.left = `${newStart * pps}px`;
            }
            // Single transaction so the whole group commits atomically to the
            // Yjs doc — peers see one update, not N interleaved with their
            // own edits.
            slate.doc.transact(() => {
              for (const [cid, o] of d.origins!) {
                updateAudioClip(slate, cid, { start: Math.max(0, o.os + clampedDt) });
              }
            });
          } else {
            const targetTrackId = d.trackIds[d.trackIndex + d.rowDelta] ?? d.trackIds[d.trackIndex]!;
            const originTrackId = d.trackIds[d.trackIndex]!;
            // Enforce the no-overlap invariant HERE (the drag itself follows
            // the mouse freely): place the clip in the free gap nearest to the
            // dropped position.
            const start = nearestFreeStart(left, d.od, d.byTrack.get(targetTrackId) ?? []);
            // Write the resolved position to the DOM too so there's no flicker
            // between pointer-up and the Yjs-driven re-render.
            d.el.style.left = `${start * pps}px`;
            updateAudioClip(slate, d.clipId, {
              start,
              ...(targetTrackId !== originTrackId ? { trackId: targetTrackId } : {}),
            });
          }
        }
        else if (d.mode === 'trimL') updateAudioClip(slate, d.clipId, { start: left, duration: width, offset: Math.max(0, d.oo + (left - d.os) * d.speed) });
        else if (d.mode === 'trimR') updateAudioClip(slate, d.clipId, { duration: width });
      }
      moveXRef.current = null;
      lastProcessedX = null;
      lastProcessedY = null;
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Don't leak a pending rAF if the component unmounts mid-drag.
      if (moveRafRef.current) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = 0;
      }
    };
  }, [slate]);

  // Hotkeys. Gated: on an audio board the editor always owns them; on a 2D/3D
  // board (where the editor is one docked panel among many) they only fire
  // while the pointer is over the editor — otherwise Space fought the 2D
  // animation timeline (both played), and C/D/R fired while drawing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const isAudioBoard = useAppStore.getState().currentBoard?.mode === 'audio';
      if (!isAudioBoard && !hoveredRef.current) return;
      const k = e.key.toLowerCase();
      // The InstrumentPanel owns the note keys while its keyboard capture is
      // on (D/F/G/… play notes, Z/X shift octave) — Space/arrows/Delete still
      // reach the transport, like a real DAW. Modifier chords (Ctrl+Z undo,
      // Ctrl+C copy) pass through: the instrument ignores them too.
      if (instrumentKeyCapture.current && !e.ctrlKey && !e.metaKey && INSTRUMENT_CAPTURE_KEYS.has(k)) return;
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undoRef.current?.undo(); }
      else if ((k === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) || (k === 'y' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); undoRef.current?.redo(); }
      else if (k === 'c' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void copyClips(); }
      else if (k === 'v' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void pasteClips(); }
      else if (k === 'c' && !e.ctrlKey && selectedRef.current.size > 0) { e.preventDefault(); selectedRef.current.forEach(id => void splitAudioClip(slate, id, positionRef.current)); }
      else if ((k === 'delete' || k === 'backspace') && selectedRef.current.size > 0) { e.preventDefault(); selectedRef.current.forEach(id => deleteAudioClip(slate, id)); setSelectedClipIds(new Set()); }
      else if (k === 'd' && !e.ctrlKey && selectedRef.current.size > 0) { e.preventDefault(); void duplicateSelection(); }
      else if (k === 'l') { e.preventDefault(); setLooping((n) => !n); }
      else if (k === 'm') { e.preventDefault(); setMetronome((n) => { engineRef.current?.setMetronome(!n); return !n; }); }
      else if (k === 'r' && !e.ctrlKey) { e.preventDefault(); void toggleRecord(); }
      else if (k === 'arrowleft') { e.preventDefault(); seek(positionRef.current - 2); }
      else if (k === 'arrowright') { e.preventDefault(); seek(positionRef.current + 2); }
      else if (k === 'home') { e.preventDefault(); seek(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, recording]);

  // Read from Yjs — lightweight (no samples copied).
  const tracks: AudioTrack[] = useMemo(() => {
    const list: AudioTrack[] = [];
    slate.audioTracks().forEach((m, id) => { const t = readAudioTrack(m, id); if (t) list.push(t); });
    list.sort((a, b) => a.order - b.order);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate, version]);

  // The currently armed track — the one the transport bar Record button
  // records onto (mic for audio tracks, MIDI capture for instrument tracks).
  // Shown as a small label next to the Record button so the user always
  // knows where the next take will land.
  const armedTrack = tracks.find((t) => t.armed) ?? null;

  const clips: AudioClip[] = useMemo(() => {
    const list: AudioClip[] = [];
    slate.audioClips().forEach((m, id) => { const c = readAudioClip(m, id); if (c) list.push(c); });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate, version]);
  clipsRef.current = clips;
  tracksRef.current = tracks;

  // When a clip's samples change (normalize/reverse from the settings panel,
  // OR a remote peer's sample blob just landed via the Yjs sync map),
  // drop the cached waveform + decoded buffer so both refresh, AND — if we're
  // currently playing — schedule a debounced restartPlayback so the clip is
  // picked up. This covers the case where a clip's metadata arrived but its
  // samples were still in flight: getBuffer returned null on the first pass,
  // and this restart re-schedules once the samples are usable.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      // The event's detail is a CLIP id for local edits, but a SAMPLE KEY for
      // sample-sync arrivals (registerSampleSyncMap only knows the key).
      // The engine's buffer cache and the waveform PNG cache are keyed by
      // clip id — clearing them with a sampleKey was a silent no-op, so a
      // peer whose clip was normalized/reversed/split by someone else got a
      // fresh waveform but kept PLAYING the stale audio. Resolve the detail
      // to every matching clip id (usually exactly one).
      const clipIds: string[] = [];
      const clipsMap = slateRef.current.audioClips();
      if (clipsMap.get(detail)) clipIds.push(detail);
      else clipsMap.forEach((m, cid) => { if (m.get('sampleKey') === detail) clipIds.push(cid); });
      if (clipIds.length === 0) clipIds.push(detail); // unknown — invalidate as-is
      for (const id of clipIds) {
        invalidateWaveform(id);
        engineRef.current?.clearCache(id);
        // Pre-warm the engine's AudioBuffer cache even when not playing —
        // otherwise a remote peer who's paused when samples land goes through
        // the full getBuffer retry loop on their next play(), adding audible
        // latency to the first playback. scheduleRestart() is a no-op when
        // paused, so without this the cache stays cold until play. Safe to
        // call when the engine has no AudioContext yet (preloadBuffer no-ops).
        void engineRef.current?.preloadBuffer(slateRef.current, id);
      }
      // Re-announce under the resolved clip id when the event carried a
      // sampleKey — the engine's in-flight sample-retry loops key their
      // budget reset on clip ids. Terminates: the re-dispatched event's
      // detail IS a clip id, so this branch won't fire again.
      for (const id of clipIds) {
        if (id !== detail) window.dispatchEvent(new CustomEvent('slate:audio-clip-changed', { detail: id }));
      }
      setVersion((v) => v + 1);
      scheduleRestart();
    };
    // A clip that can't be shared live (too long, or the board's shared-audio
    // budget is spent) plays fine locally but is silent for collaborators —
    // say so instead of failing silently.
    const onSkipped = () => {
      toast({
        title: 'Clip won’t sync to collaborators',
        description: 'It plays for you, but this clip is too long or the board’s shared audio space is full. Collaborators won’t hear it.',
        variant: 'error',
      });
    };
    window.addEventListener('slate:audio-clip-changed', onChanged as EventListener);
    window.addEventListener('slate:audio-sync-skipped', onSkipped);
    return () => {
      window.removeEventListener('slate:audio-clip-changed', onChanged as EventListener);
      window.removeEventListener('slate:audio-sync-skipped', onSkipped);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Memoized — `clips.map(...)` builds a fresh array every render and the
  // spread into Math.max is O(n) per render; only `clips` identity changes
  // are worth recomputing for. `positionRef.current` is read fresh on each
  // recomputation (a ref, so it doesn't drive re-renders itself).
  const timelineDuration = useMemo(
    () => Math.max(30, ...clips.map((c) => c.start + c.duration), positionRef.current + 10),
    [clips],
  );

  /** Compute the px-per-sec that fits the ENTIRE timeline duration into the
   *  currently-visible timeline viewport (scroll container minus the sticky
   *  track-header column). Clamped to [MIN, MAX] so absurdly long or short
   *  sessions still produce a sane zoom. Goes through `zoomAnchored` so the
   *  playhead stays on screen when the fit value would still overflow. */
  const fitToWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const viewportW = Math.max(50, el.clientWidth - TRACK_HEADER_W);
    const fit = viewportW / Math.max(1, timelineDuration);
    zoomAnchored(Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, fit)));
  }, [timelineDuration, zoomAnchored]);

  // ── Transport ─────────────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    const eng = engineRef.current; if (!eng) return;
    if (playing) { eng.stop(); setPlaying(false); }
    else {
      if (looping) eng.setLoopRegion(loopStart, loopEnd); else eng.setLoopRegion(null, null);
      // Best-effort: if the AudioContext is suspended (autoplay policy /
      // backgrounded tab), this click IS a user gesture — kick off resume()
      // right now so the next play attempt (this one if resume resolves in
      // time, otherwise the user's next click) sees a running context.
      eng.resumeOnGesture();
      void eng.play(slate, positionRef.current);
      // Only flip the UI to "playing" if the engine actually started. play()
      // bails with a toast when the AudioContext is still suspended, leaving
      // this.playing false — without this guard the Play button would flip
      // to Pause while no audio plays.
      if (eng.isPlaying()) setPlaying(true);
    }
  }, [playing, slate, looping, loopStart, loopEnd]);

  const seek = useCallback((t: number) => {
    const pos = Math.max(0, t);
    positionRef.current = pos;
    audioPlayheadPos.current = pos;
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${pos * pxRef.current}px)`;
    if (posDisplayRef.current) posDisplayRef.current.textContent = `${pos.toFixed(1)}s`;
    // Publish the new playhead position immediately so peers see the seek
    // without waiting for the next throttled tick (which only fires while
    // playing). Resets the throttle stamp so the rAF loop doesn't double-publish.
    room.setLocalAwareness({ audio: { pos, playing: playingRef.current } });
    lastAudioPublishRef.current = performance.now();
  }, [room]);

  const toggleRecord = useCallback(async () => {
    if (recording) {
      const stopFn = stopRecRef.current;
      if (stopFn) {
        const r = await stopFn(); stopRecRef.current = null; setRecording(false);
        let tid = tracks.find((t) => t.armed)?.id;
        if (!tid) tid = addAudioTrack(slate, { name: 'Recording' });
        addAudioClip(slate, tid, { start: positionRef.current, samples: r.samples, sampleRate: r.sampleRate, channels: r.channels, duration: r.duration, name: `Rec ${new Date().toLocaleTimeString()}` });
        toast({ title: 'Recording added' });
      }
    } else {
      try { const sf = await engineRef.current?.startRecording(); stopRecRef.current = sf ?? null; setRecording(true); }
      catch { toast({ title: 'Mic denied', variant: 'error' }); }
    }
  }, [recording, tracks, slate]);

  /** Duplicate the selected clip(s) AT THE PLAYHEAD (not tacked after the
   *  originals): the earliest selected clip lands on the playhead line and
   *  the rest keep their relative spacing (like paste). Each copy resolves
   *  to the nearest free gap on its own track, counting copies already
   *  placed in this batch, and the new copies become the selection so
   *  they're ready to drag. */
  const duplicateSelection = useCallback(async () => {
    const sel = clipsRef.current.filter((c) => selectedRef.current.has(c.id));
    if (sel.length === 0) return;
    const minStart = Math.min(...sel.map((c) => c.start));
    const base = positionRef.current;
    const placedByTrack = new Map<string, { start: number; end: number }[]>();
    for (const c of clipsRef.current) {
      let list = placedByTrack.get(c.trackId);
      if (!list) { list = []; placedByTrack.set(c.trackId, list); }
      list.push({ start: c.start, end: c.start + c.duration });
    }
    const newIds: string[] = [];
    for (const c of sel) {
      const blockers = placedByTrack.get(c.trackId) ?? [];
      const start = nearestFreeStart(base + (c.start - minStart), c.duration, blockers);
      blockers.push({ start, end: start + c.duration });
      placedByTrack.set(c.trackId, blockers);
      const id = await duplicateAudioClip(slate, c.id, start);
      if (id) newIds.push(id);
    }
    if (newIds.length > 0) setSelectedClipIds(new Set(newIds));
  }, [slate]);

  // ── Clipboard (copy / paste) ────────────────────────────────────────────
  /** Copied clips: a snapshot of each selected clip's props + its decoded
   *  samples + start offset relative to the earliest selected clip, so paste
   *  reconstructs the group at the playhead even after the originals are
   *  deleted or edited. Samples are held so paste doesn't depend on the source
   *  clip still existing in the doc. */
  const clipboardRef = useRef<Array<{ src: AudioClip; samples: Float32Array; relStart: number }>>([]);
  const [hasClipboard, setHasClipboard] = useState(false);

  const copyClips = useCallback(async () => {
    const sel = clipsRef.current.filter((c) => selectedRef.current.has(c.id));
    if (sel.length === 0) return;
    const minStart = Math.min(...sel.map((c) => c.start));
    const items: Array<{ src: AudioClip; samples: Float32Array; relStart: number }> = [];
    for (const c of sel) {
      const samples = await loadSamples(c.sampleKey);
      if (samples.length === 0) continue; // samples still syncing — skip
      items.push({ src: c, samples, relStart: c.start - minStart });
    }
    if (items.length === 0) {
      toast({ title: 'Nothing to copy', description: 'Selected clip samples are still syncing.', variant: 'error' });
      return;
    }
    clipboardRef.current = items;
    setHasClipboard(true);
    toast({ title: `Copied ${items.length} clip${items.length > 1 ? 's' : ''}` });
  }, []);

  const pasteClips = useCallback(async () => {
    const items = clipboardRef.current;
    if (items.length === 0) return;
    const base = positionRef.current; // paste the group at the playhead
    const newIds: string[] = [];
    // Blockers per track: existing clips + clips already placed by THIS paste
    // (clipsRef won't include them until React re-renders), so pasted clips
    // never land on top of anything.
    const placedByTrack = new Map<string, { start: number; end: number }[]>();
    for (const c of clipsRef.current) {
      let list = placedByTrack.get(c.trackId);
      if (!list) { list = []; placedByTrack.set(c.trackId, list); }
      list.push({ start: c.start, end: c.start + c.duration });
    }
    for (const it of items) {
      const blockers = placedByTrack.get(it.src.trackId) ?? [];
      const start = nearestFreeStart(base + it.relStart, it.src.duration, blockers);
      blockers.push({ start, end: start + it.src.duration });
      placedByTrack.set(it.src.trackId, blockers);
      const id = await addAudioClip(slate, it.src.trackId, {
        start,
        samples: it.samples, // Float32Array passed straight through
        sampleRate: it.src.sampleRate,
        channels: it.src.channels,
        duration: it.src.duration,
        name: it.src.name,
        color: it.src.color,
      });
      // Carry over trims + per-clip effects that addAudioClip defaults to 0/1.
      updateAudioClip(slate, id, {
        offset: it.src.offset, gain: it.src.gain, pan: it.src.pan,
        fadeIn: it.src.fadeIn, fadeOut: it.src.fadeOut, speed: it.src.speed,
        pitch: it.src.pitch, hpCutoff: it.src.hpCutoff, lpCutoff: it.src.lpCutoff,
      });
      newIds.push(id);
    }
    setSelectedClipIds(new Set(newIds)); // select the paste so it's ready to move
    toast({ title: `Pasted ${newIds.length} clip${newIds.length > 1 ? 's' : ''}` });
  }, [slate]);

  const handleFileImport = useCallback(async (file: File) => {
    try {
      // MIDI files branch: parse with @tonejs/midi and create a MIDI track +
      // clip (no PCM samples — note events live in the Yjs clip directly).
      // Other audio files go through the existing decodeAudioFile → audio
      // track + audio clip path.
      if (/\.midi?$/i.test(file.name)) {
        const d = await decodeMidiFile(file);
        if (d.notes.length === 0) {
          toast({ title: 'MIDI file empty', description: 'No notes found.', variant: 'error' });
          return;
        }
        const tid = addAudioTrack(slate, {
          kind: 'midi',
          instrumentId: SOUNDFONT_PIANO_ID,
          name: file.name.replace(/\.[^.]+$/, ''),
        });
        addMidiClip(slate, tid, {
          start: positionRef.current,
          notes: d.notes,
          duration: d.duration,
          name: file.name,
        });
        // If the doc has no BPM set yet (fresh board) adopt the MIDI file's
        // tempo so the beat grid + metronome line up with the imported notes.
        if (d.tempo && d.tempo >= 20 && d.tempo <= 300) {
          setAudioBpm(slate, d.tempo);
          setBpmState(d.tempo);
          engineRef.current?.setBpm(d.tempo);
        }
        toast({ title: 'MIDI imported', description: `${file.name} (${d.notes.length} notes)` });
        return;
      }
      const d = await decodeAudioFile(file);
      const tid = addAudioTrack(slate, { name: file.name.replace(/\.[^.]+$/, '') });
      addAudioClip(slate, tid, { start: positionRef.current, samples: d.samples, sampleRate: d.sampleRate, channels: d.channels, duration: d.duration, name: file.name });
      toast({ title: 'Imported', description: file.name });
    } catch (err) { toast({ title: 'Import failed', description: (err as Error).message, variant: 'error' }); }
  }, [slate]);

  // ── Drag-drop from AudioAssetsPanel ────────────────────────────────────────

  /** Add an imported asset (by clip id) to a specific track at a specific time. */
  const addAssetToTrack = useCallback(async (assetId: string, trackId: string, start: number) => {
    const yo = slate.audioClips().get(assetId);
    const clip = yo ? readAudioClip(yo, assetId) : null;
    if (!clip) return;
    const samples = await loadSamples(clip.sampleKey);
    if (samples.length === 0) {
      toast({ title: 'Samples still syncing', variant: 'error' });
      return;
    }
    await addAudioClip(slate, trackId, {
      start, samples: float32ToNumberArray(samples),
      sampleRate: clip.sampleRate, channels: clip.channels,
      duration: clip.duration, name: clip.name,
    });
    toast({ title: 'Added to track' });
  }, [slate]);

  /** Add a library sample to a specific track at a specific time. */
  const addLibraryToTrack = useCallback(async (libId: string, trackId: string, start: number) => {
    const sample = AUDIO_LIBRARY.find((s) => s.id === libId);
    if (!sample) return;
    try {
      const pcm = await librarySamplePcm(sample);
      await addAudioClip(slate, trackId, {
        start, samples: pcm, sampleRate: LIBRARY_SAMPLE_RATE,
        channels: 1, duration: pcm.length / LIBRARY_SAMPLE_RATE, name: sample.name,
      });
      toast({ title: 'Added to track', description: sample.name });
    } catch (err) {
      toast({ title: 'Sample unavailable', description: (err as Error).message, variant: 'error' });
    }
  }, [slate]);

  /** Handle a drop on the timeline area — hit-tests the track row and computes the time. */
  const handleTimelineDrop = useCallback((e: React.DragEvent) => {
    const assetId = e.dataTransfer.getData('application/x-slate-audio-asset');
    const libId = e.dataTransfer.getData('application/x-slate-audio-library');
    if (!assetId && !libId) return; // not an asset drag — let file drop bubble
    e.preventDefault();
    // Hit-test track rows by clientY
    const rows = scrollRef.current?.querySelectorAll('[data-track-id]') ?? [];
    let trackId: string | null = null;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        trackId = r.getAttribute('data-track-id');
        break;
      }
    }
    if (!trackId) return;
    // Compute time from clientX relative to the timeline content
    const tlEl = scrollRef.current?.querySelector('[data-timeline]') as HTMLElement | null;
    if (!tlEl) return;
    const tlRect = tlEl.getBoundingClientRect();
    const t = Math.max(0, (e.clientX - tlRect.left) / pxRef.current);
    if (assetId) void addAssetToTrack(assetId, trackId, t);
    else if (libId) void addLibraryToTrack(libId, trackId, t);
  }, [addAssetToTrack, addLibraryToTrack]);

  // ── Drag start ────────────────────────────────────────────────────────────

  // Everything the pointermove handler needs, computed once per drag:
  //  - [leftLimit, rightLimit]: the free interval on the ORIGIN track (trims).
  //  - byTrack: clip bounds per track (dragged clip excluded) for overlap
  //    resolution on whichever track the pointer is over.
  //  - snapTimes: magnet candidates — every other clip's edges + playhead + 0.
  // `excludeIds` is the set of clip ids to skip when building the neighbour
  //  bounds — for a multi-select drag it's EVERY selected clip (so the group
  //  can move freely without its own members blocking it); for a single-clip
  //  drag it's just { clip.id }.
  const dragGeometry = useCallback((clip: AudioClip, excludeIds?: Set<string>): {
    leftLimit: number; rightLimit: number;
    byTrack: Map<string, { start: number; end: number }[]>;
    snapTimes: number[];
  } => {
    const exclude = excludeIds ?? new Set([clip.id]);
    let leftLimit = 0;
    let rightLimit = Infinity;
    const byTrack = new Map<string, { start: number; end: number }[]>();
    const snapTimes: number[] = [0, positionRef.current];
    const clipEnd = clip.start + clip.duration;
    for (const o of clipsRef.current) {
      if (exclude.has(o.id)) continue;
      const oEnd = o.start + o.duration;
      snapTimes.push(o.start, oEnd);
      let list = byTrack.get(o.trackId);
      if (!list) { list = []; byTrack.set(o.trackId, list); }
      list.push({ start: o.start, end: oEnd });
      if (o.trackId !== clip.trackId) continue;
      if (oEnd <= clip.start + 1e-4) leftLimit = Math.max(leftLimit, oEnd);
      else if (o.start >= clipEnd - 1e-4) rightLimit = Math.min(rightLimit, o.start);
    }
    return { leftLimit, rightLimit, byTrack, snapTimes };
  }, []);

  const selectClip = useCallback((id: string, additive: boolean) => {
    setSelectedClipIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      // Plain click: if already in a multi-selection, keep it; else single-select.
      if (prev.has(id) && prev.size > 1) return prev;
      return new Set([id]);
    });
  }, []);

  const startDrag = useCallback((clip: AudioClip, e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => {
    e.stopPropagation();
    // Without this, the browser starts a native text/image selection on the
    // mouse-drag: the waveform <img>s and labels of every clip the pointer
    // sweeps across get painted with the blue ::selection overlay.
    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // MULTI-SELECT DRAG: if this clip is ALREADY part of a multi-selection
    // (and the user is plain-clicking, not additive-shift-clicking to extend
    // the selection), every selected clip moves together by the same delta.
    // We check the CURRENT selection (before the selectClip call below) so a
    // plain click on an already-multi-selected clip preserves the group.
    const multiDrag = !additive && selectedRef.current.has(clip.id) && selectedRef.current.size > 1;
    selectClip(clip.id, additive);
    window.dispatchEvent(new CustomEvent('slate:audio-clip-select', { detail: clip.id }));
    const excludeIds = multiDrag ? new Set(selectedRef.current) : undefined;
    const { leftLimit, rightLimit, byTrack, snapTimes } = dragGeometry(clip, excludeIds);
    const trackIds = tracksRef.current.map((t) => t.id);
    const trackIndex = Math.max(0, trackIds.indexOf(clip.trackId));

    let origins: Map<string, { el: HTMLElement; waveEl: HTMLElement | null; os: number; od: number; oo: number; trackId: string }> | undefined;
    if (multiDrag) {
      origins = new Map();
      // Always include the dragged clip first using the element we were
      // handed (it's already known, no DOM lookup needed).
      origins.set(clip.id, { el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset, trackId: clip.trackId });
      for (const selId of selectedRef.current) {
        if (origins.has(selId)) continue;
        const otherClip = clipsRef.current.find((c) => c.id === selId);
        if (!otherClip) continue;
        // DOM lookup by data-clip-id (added to ClipBlock's root div for this
        // purpose). querySelector with an attribute selector is fine here —
        // it runs ONCE per drag start, not per pointermove.
        const otherEl = document.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(selId)}"]`);
        if (!otherEl) continue;
        // The waveform layer is the first child div of the clip block — grab
        // it so a future drag-then-trim on the same gesture would have it,
        // though multi-drag only ever moves left (no trim path).
        const otherWaveEl = otherEl.querySelector<HTMLElement>(':scope > div');
        origins.set(selId, { el: otherEl, waveEl: otherWaveEl, os: otherClip.start, od: otherClip.duration, oo: otherClip.offset, trackId: otherClip.trackId });
      }
    }

    dragRef.current = {
      clipId: clip.id, el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset,
      speed: clip.speed ?? 1, sx: e.clientX, sy: e.clientY, leftLimit, rightLimit,
      byTrack, snapTimes, trackIds, trackIndex, rowDelta: 0, moved: false, mode: 'drag',
      origins,
    };
  }, [dragGeometry, selectClip]);

  const startTrim = useCallback((clip: AudioClip, side: 'left' | 'right', e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => {
    e.stopPropagation();
    e.preventDefault(); // block native selection (see startDrag)
    selectClip(clip.id, e.shiftKey || e.metaKey || e.ctrlKey);
    window.dispatchEvent(new CustomEvent('slate:audio-clip-select', { detail: clip.id }));
    const { leftLimit, rightLimit, byTrack, snapTimes } = dragGeometry(clip);
    const trackIds = tracksRef.current.map((t) => t.id);
    const trackIndex = Math.max(0, trackIds.indexOf(clip.trackId));
    dragRef.current = {
      clipId: clip.id, el, waveEl, os: clip.start, od: clip.duration, oo: clip.offset,
      speed: clip.speed ?? 1, sx: e.clientX, sy: e.clientY, leftLimit, rightLimit,
      byTrack, snapTimes, trackIds, trackIndex, rowDelta: 0, moved: false,
      mode: side === 'left' ? 'trimL' : 'trimR',
    };
  }, [dragGeometry, selectClip]);

  // ── Loop region drag ──────────────────────────────────────────────────────

  const loopDragRef = useRef<{ mode: 'start' | 'end' | 'move'; sx: number; os: number; oe: number } | null>(null);
  /** Holds the in-flight loop-drag cleanup function (removes the window
   *  pointermove/pointerup listeners) while a drag is active, so the unmount
   *  effect below can tear them down if the component unmounts mid-drag —
   *  otherwise the listeners keep firing on a dead component and leak. */
  const loopDragCleanupRef = useRef<(() => void) | null>(null);
  const startLoopDrag = useCallback((mode: 'start' | 'end' | 'move', e: React.PointerEvent) => {
    e.stopPropagation();
    // If a previous drag somehow didn't finish, tear its listeners down first
    // so we never stack two sets of pointermove/pointerup listeners.
    loopDragCleanupRef.current?.();
    loopDragRef.current = { mode, sx: e.clientX, os: loopStart, oe: loopEnd };
    const onMove = (ev: PointerEvent) => {
      const d = loopDragRef.current; if (!d) return;
      const dt = (ev.clientX - d.sx) / pxRef.current;
      if (d.mode === 'start') { setLoopStart(Math.max(0, Math.min(d.oe - 0.5, d.os + dt))); }
      else if (d.mode === 'end') { setLoopEnd(Math.max(d.os + 0.5, d.oe + dt)); }
      else if (d.mode === 'move') { setLoopStart(Math.max(0, d.os + dt)); setLoopEnd(Math.max(0.5, d.oe + dt)); }
    };
    const onUp = () => {
      loopDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      loopDragCleanupRef.current = null;
    };
    loopDragCleanupRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [loopStart, loopEnd, pxPerSec]);

  // Unmount safety: if the user closes the audio panel (or navigates away)
  // while a loop-handle drag is in flight, the window pointermove/pointerup
  // listeners added by startLoopDrag would otherwise leak and fire on a dead
  // component. Tear them down here.
  useEffect(
    () => () => {
      loopDragCleanupRef.current?.();
      loopDragCleanupRef.current = null;
      loopDragRef.current = null;
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  const beatDur = 60 / bpm; // seconds per beat
  const gridStyle = {
    backgroundImage: `repeating-linear-gradient(to right, rgba(128,128,128,0.08) 0 1px, transparent 1px ${beatDur * pxPerSec}px), repeating-linear-gradient(to right, rgba(128,128,128,0.2) 0 1px, transparent 1px ${beatDur * 4 * pxPerSec}px)`,
  };

  // Adaptive ruler tick interval — picks a "nice" step (in seconds) whose
  // pixel spacing stays readable at the current zoom: tight when zoomed in
  // (so you get millisecond-level ticks), sparse when zoomed out (so a long
  // mix doesn't turn into a solid wall of labels).
  const { tickInterval, formatTick } = useMemo(() => {
    if (pxPerSec >= 400) return { tickInterval: 0.1, formatTick: (t: number) => `${t.toFixed(1)}s` };
    if (pxPerSec >= 100) return { tickInterval: 1, formatTick: (t: number) => `${t}s` };
    if (pxPerSec >= 40) return { tickInterval: 5, formatTick: (t: number) => `${t}s` };
    if (pxPerSec >= 10) return { tickInterval: 10, formatTick: (t: number) => `${t}s` };
    return {
      tickInterval: 60,
      formatTick: (t: number) => {
        const m = Math.floor(t / 60);
        const s = Math.round(t - m * 60);
        return s === 0 ? `${m}m` : `${m}m ${s}s`;
      },
    };
  }, [pxPerSec]);

  return (
    <div className="flex h-full flex-col bg-bg overflow-hidden" onPointerEnter={() => { hoveredRef.current = true; }} onPointerLeave={() => { hoveredRef.current = false; }} onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); for (const f of [...(e.dataTransfer?.files ?? [])].filter((f) => /\.(mp3|wav|ogg|m4a|flac|aac|mid|midi)$/i.test(f.name))) void handleFileImport(f); }}>
      {/* Transport */}
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-bg-2 px-2 py-1.5 [&>*]:shrink-0">
        <button onClick={() => seek(0)} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Start"><SkipBack size={14} /></button>
        <button onClick={togglePlay} className={`flex h-9 w-9 items-center justify-center rounded-full text-white ${playing ? 'bg-warn' : 'bg-accent'} hover:opacity-80`} title="Play (Space)">{playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <button onClick={() => void toggleRecord()} className={`flex h-8 w-8 items-center justify-center rounded-full border ${recording ? 'border-danger bg-danger/20 text-danger animate-pulse' : 'border-border text-text-mid hover:bg-bg-3'}`} title={armedTrack ? `Record (R) → ${armedTrack.name}` : 'Record (R)'}><Mic size={15} /></button>
        {armedTrack ? (
          <span className="flex items-center rounded bg-bg-3 px-1 py-1" title={`Recording onto: ${armedTrack.name}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />
          </span>
        ) : null}
        <span ref={posDisplayRef} className="min-w-[2rem] font-mono text-xs text-text">0.0s</span>
        <div className="mx-1 h-5 w-px bg-border" />
        <button onClick={() => selectedRef.current.forEach(id => void splitAudioClip(slate, id, positionRef.current))} disabled={selectedClipIds.size === 0} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Split (C)"><Scissors size={14} /></button>
        <button onClick={() => void duplicateSelection()} disabled={selectedClipIds.size === 0} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Duplicate at playhead (D)"><Copy size={14} /></button>
        <button onClick={() => void copyClips()} disabled={selectedClipIds.size === 0} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Copy (Ctrl+C)"><ClipboardCopy size={14} /></button>
        <button onClick={() => void pasteClips()} disabled={!hasClipboard} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 disabled:opacity-30" title="Paste at playhead (Ctrl+V)"><ClipboardPaste size={14} /></button>
        <button onClick={() => { selectedRef.current.forEach(id => deleteAudioClip(slate, id)); setSelectedClipIds(new Set()); }} disabled={selectedClipIds.size === 0} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger disabled:opacity-30" title="Delete (Del)"><Trash2 size={14} /></button>
        <div className="mx-1 h-5 w-px bg-border" />
        {!isMobile && (<label className="flex items-center gap-1 text-[11px] text-text-dim">BPM<input type="number" inputMode="decimal" min={20} max={300} value={bpm} onChange={(e) => { setBpmState(Number(e.target.value)); setAudioBpm(slate, Number(e.target.value)); engineRef.current?.setBpm(Number(e.target.value)); }} className="w-14 rounded border border-border bg-bg-3 px-1 py-0.5 text-center font-mono text-xs text-text outline-none focus:border-accent" /></label>)}
        <button onClick={() => { const n = !metronome; setMetronome(n); engineRef.current?.setMetronome(n); }} className={`flex h-7 w-7 items-center justify-center rounded ${metronome ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Metronome (M)"><Music size={13} /></button>
        <button onClick={() => setLooping((n) => !n)} className={`flex h-7 w-7 items-center justify-center rounded ${looping ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Loop (L)"><Repeat size={13} /></button>
        <button onClick={() => setSnapOn((n) => !n)} className={`flex h-7 w-7 items-center justify-center rounded ${snapOn ? 'bg-accent/20 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="Snap to grid & clips (hold Alt to bypass)"><Magnet size={13} /></button>
        <div className="mx-1 h-5 w-px bg-border" />
        {!isMobile && (<div className="flex items-center gap-1"><Volume2 size={12} className="text-text-mid" /><input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={(e) => { setMasterVol(Number(e.target.value)); engineRef.current?.setMasterVolume(Number(e.target.value)); }} className="w-14 accent-accent" /></div>)}
        <button onClick={() => zoomAnchored(Math.max(MIN_PX_PER_SEC, pxRef.current / 1.3))} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom out"><ZoomOut size={12} /></button>
        <button onClick={fitToWindow} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-accent" title="Fit to window"><Maximize2 size={12} /></button>
        <button onClick={() => zoomAnchored(Math.min(MAX_PX_PER_SEC, pxRef.current * 1.3))} className="flex h-7 w-7 items-center justify-center rounded text-text-mid hover:bg-bg-3" title="Zoom in"><ZoomIn size={12} /></button>
        {!isMobile && <div className="flex-1" />}
        <label className="flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-mid hover:bg-bg-3"><Upload size={12} />Import<input type="file" accept="audio/*,.mid,.midi" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFileImport(f); e.target.value = ''; }} /></label>
        <button onClick={() => addAudioTrack(slate)} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20"><Plus size={12} />Track</button>
        <button onClick={() => addAudioTrack(slate, { kind: 'midi', instrumentId: SOUNDFONT_PIANO_ID, name: 'MIDI Track' })} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20" title="Add MIDI track"><Piano size={12} />MIDI</button>
      </div>

      {/* Track area */}
      <div
        ref={scrollRef}
        className="flex flex-1 min-h-0 overflow-auto"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-slate-audio-asset') ||
              e.dataTransfer.types.includes('application/x-slate-audio-library') ||
              e.dataTransfer.types.includes('Files'))
            e.preventDefault();
        }}
        onDrop={handleTimelineDrop}
      >
        {/* Headers. overflow-hidden is load-bearing: the sticky column is z-10
            (above clips), and a track's volume/pan range inputs won't shrink
            below their intrinsic min-width, so without clipping they spill ~20px
            past the column onto the leftmost clips — intercepting the pointer so
            those clips can't be grabbed (you hit the pan slider instead, and the
            previously-selected clip stays highlighted). */}
        <div className="sticky left-0 z-10 w-32 shrink-0 overflow-hidden border-r border-border bg-bg-2 sm:w-44">
          <div className="flex items-center border-b border-border px-2 text-[9px] font-mono uppercase text-text-dim" style={{ height: 28 }}>Tracks</div>
          {tracks.length === 0 && <div className="p-3 text-center text-[11px] text-text-dim">No tracks. Import audio or add a track.</div>}
          {tracks.map((t) => <TrackHeader key={t.id} track={t} hasSolo={tracks.some((x) => x.solo)} slate={slate} engineRef={engineRef} />)}
        </div>

        {/* Timeline */}
        <div data-timeline className="relative flex-1 select-none" style={{ minWidth: timelineDuration * pxPerSec }}>
          {/* Ruler + loop handles */}
          <div className="sticky top-0 z-10 border-b border-border bg-bg-2/95" style={{ height: 28 }}>
            {Array.from({ length: Math.ceil(timelineDuration / tickInterval) + 1 }, (_, i) => {
              const t = i * tickInterval;
              return (
                <span key={i} className="absolute top-1 pl-1 text-[8px] font-mono text-text-dim" style={{ left: t * pxPerSec }}>{formatTick(t)}</span>
              );
            })}
            {looping && (
              <>
                <div onPointerDown={(e) => startLoopDrag('start', e)} className="absolute top-0 z-20 flex h-7 cursor-ew-resize items-center justify-center bg-accent/40 hover:bg-accent/60" style={{ left: loopStart * pxPerSec - 8, width: 8 }} title="Drag loop start"><ChevronLeft size={10} className="text-white" /></div>
                <div onPointerDown={(e) => startLoopDrag('end', e)} className="absolute top-0 z-20 flex h-7 cursor-ew-resize items-center justify-center bg-accent/40 hover:bg-accent/60" style={{ left: loopEnd * pxPerSec, width: 8 }} title="Drag loop end"><ChevronRight size={10} className="text-white" /></div>
              </>
            )}
          </div>
          {/* Seek + marquee layer — background click catcher (behind clips).
           *  Click (pointerdown + pointerup without moving > 3px) = seek to the
           *  pointerdown position. Drag (pointerdown + move > 3px) = marquee
           *  multi-select — no modifier key needed. Shift/Cmd+drag = ADDITIVE
           *  marquee that adds to the existing selection instead of replacing
           *  it. Plain click on an empty area also clears the selection (same
           *  as before) so a click elsewhere dismisses a multi-select. */}
          <div
            className="absolute inset-0 top-7"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const sx = e.clientX - r.left, sy = e.clientY - r.top;
              const additive = e.shiftKey || e.metaKey || e.ctrlKey;
              // ALWAYS start a potential marquee — we won't know whether it's
              // a click (seek) or a drag (marquee) until the pointer moves.
              // The pointerup handler decides: if `moved` is still false, it
              // was a click → seek to `seekTime`; otherwise finalise the
              // marquee selection (already built incrementally in pointermove).
              marqueeRef.current = {
                startX: sx, startY: sy,
                seekTime: sx / pxRef.current,
                origin: new Set(additive ? selectedRef.current : []),
                additive, moved: false,
              };
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const s = marqueeRef.current; if (!s) return;
              const r = e.currentTarget.getBoundingClientRect();
              const ex = e.clientX - r.left, ey = e.clientY - r.top;
              // Dead zone — a click that hasn't left a 3px box is still a
              // click (seek on pointerup), not a marquee.
              if (!s.moved) {
                if (Math.abs(ex - s.startX) < DRAG_DEADZONE_PX && Math.abs(ey - s.startY) < DRAG_DEADZONE_PX) return;
                s.moved = true;
              }
              setMarquee({ x1: s.startX, y1: s.startY, x2: ex, y2: ey });
              // Hit-test clips against the marquee rect
              const x1 = Math.min(s.startX, ex);
              const x2 = Math.max(s.startX, ex);
              const y1 = Math.min(s.startY, ey);
              const y2 = Math.max(s.startY, ey);
              const t1 = x1 / pxRef.current, t2 = x2 / pxRef.current;
              const startRowIdx = Math.floor(y1 / TRACK_H);
              const endRowIdx = Math.floor(y2 / TRACK_H);
              const next = new Set(s.origin);
              clips.forEach((c) => {
                const ti = tracks.findIndex((t) => t.id === c.trackId);
                if (ti < startRowIdx || ti > endRowIdx) return;
                const cEnd = c.start + c.duration;
                if (cEnd >= t1 && c.start <= t2) next.add(c.id);
              });
              setSelectedClipIds(next);
            }}
            onPointerUp={() => {
              const s = marqueeRef.current;
              marqueeRef.current = null;
              setMarquee(null);
              if (!s) return;
              if (!s.moved) {
                // Plain click → seek to the pointerdown position. Non-additive
                // clicks also clear the selection (clicking empty space
                // dismisses a multi-select); additive clicks (shift/cmd on
                // empty space) leave the selection alone.
                seek(s.seekTime);
                if (!s.additive) setSelectedClipIds(new Set());
              }
              // If `s.moved` is true the marquee selection was already
              // finalised incrementally in pointermove — nothing to do here.
            }}
          />
          {/* Marquee rect overlay */}
          {marquee && (
            <div className="pointer-events-none absolute z-30 border border-accent/70 bg-accent/15" style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: 28 + Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }} />
          )}
          {/* Grid background */}
          <div className="pointer-events-none absolute inset-0 top-7" style={gridStyle}>
            {looping && <div onPointerDown={(e) => startLoopDrag('move', e)} className="pointer-events-auto absolute top-0 bottom-0 cursor-grab bg-accent/8 border-x-2 border-accent/40" style={{ left: loopStart * pxPerSec, width: (loopEnd - loopStart) * pxPerSec }} />}
          </div>
          {/* Playhead */}
          <div ref={playheadRef} className="absolute top-0 bottom-0 z-20 w-0.5 bg-warn pointer-events-none" style={{ transform: 'translateX(0px)' }}>
            <div className="absolute top-0 -left-1 h-2 w-2 rounded-full bg-warn" />
          </div>
          {/* Clips */}
          {tracks.map((t) => (
            <div key={t.id} data-track-id={t.id} className="pointer-events-none relative border-b border-border/15" style={{ height: TRACK_H }}>
              {clips.filter((c) => c.trackId === t.id).map((c) => (
                <ClipBlock key={c.id} clip={c} pxPerSec={pxPerSec} selected={selectedClipIds.has(c.id)}
                  onDragStart={startDrag} onTrimStart={startTrim} />
              ))}
            </div>
          ))}
          {/* Remote playheads — overlay on top of clips, mirroring each peer's
           *  audio transport position. Rendered after clips so z-20 wins. */}
          <RemotePlayheads room={room} peerStates={peerStates} pxRef={pxRef} selfId={room.identity.peerId} />
        </div>
      </div>

      {/* Status */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-0.5 text-[8px] font-mono uppercase text-text-dim">
        <span>{tracks.length}T · {clips.length}C</span>
        {recording && <span className="text-danger">● Rec</span>}
        {playing && <span className="text-accent">▶ Play</span>}
        <span className="ml-auto">Space · Ctrl+Z=Undo · C=Split · D=Dup · Ctrl+C/V=Copy/Paste · Del · R=Rec · L=Loop · M=Met · ←→=Seek · Ctrl+Scroll=Zoom</span>
      </div>
    </div>
  );
}

// ── Track header ────────────────────────────────────────────────────────────

const TrackHeader = memo(function TrackHeader({ track, hasSolo, slate, engineRef }: {
  track: AudioTrack; hasSolo: boolean;
  slate: ReturnType<typeof useRoom>['slate'];
  engineRef: React.RefObject<AudioEngine | null>;
}) {
  const [vol, setVol] = useState(track.volume);
  const [pan, setPan] = useState(track.pan);
  // Separate drag flags per slider — the previous single shared `isDraggingRef`
  // meant starting a volume drag also blocked the pan prop-sync effect (and
  // vice versa), which could cause one slider's committed Yjs value to be
  // momentarily ignored by the other's gating. Per-slider flags keep each
  // slider's prop-sync independent.
  const isDraggingVolRef = useRef(false);
  const isDraggingPanRef = useRef(false);
  useEffect(() => { if (!isDraggingVolRef.current) setVol(track.volume); }, [track.volume]);
  useEffect(() => { if (!isDraggingPanRef.current) setPan(track.pan); }, [track.pan]);

  // Audibility — mirrors engine.setupTrackNodes so the live gain we write
  // during a volume drag respects mute/solo (don't briefly un-mute a muted
  // track just because the user is dragging its volume slider).
  const audible = hasSolo ? track.solo : !track.muted;

  // `update` is for non-slider track edits (name/mute/solo/arm) — these DO
  // need a full updateTracks so the audio graph reflects the new state
  // (e.g. toggling solo rebalances every track's gain).
  const update = (patch: Partial<AudioTrack>) => { updateAudioTrack(slate, track.id, patch); engineRef.current?.updateTracks(slate); };

  // Volume slider: update local state + the engine's gain node DIRECTLY for
  // immediate audio feedback. Do NOT call updateTracks (which re-reads every
  // track from Yjs and rebuilds the audio graph — far too expensive per
  // onChange event, and the source of the reported lag). Commit to Yjs once
  // on pointerup.
  const onVolDown = () => { isDraggingVolRef.current = true; };
  const onVol = (v: number) => { setVol(v); engineRef.current?.setTrackVolume(track.id, v, audible); };
  const onVolEnd = () => { isDraggingVolRef.current = false; updateAudioTrack(slate, track.id, { volume: vol }); };

  // Pan slider: same pattern — set the panner node directly, commit on
  // pointerup. The pan slider is smaller than the volume slider (secondary
  // control) but still usable, with L/R labels so its function is obvious
  // (the user complaint was "two sliders, only one works" — partly because
  // neither slider was labelled, so it wasn't clear what each did).
  const onPanDown = () => { isDraggingPanRef.current = true; };
  const onPan = (p: number) => { setPan(p); engineRef.current?.setTrackPan(track.id, p); };
  const onPanEnd = () => { isDraggingPanRef.current = false; updateAudioTrack(slate, track.id, { pan: pan }); };

  // ── Track kind: Audio ↔ MIDI ─────────────────────────────────────────────
  // A single icon button toggles the kind. On a MIDI track, an instrument
  // picker (compact <select>) sits next to the name so the user can choose
  // which synth preset or soundfont the track's MIDI clips play through.
  // Toggling kind to 'midi' defaults the instrument to the soundfont piano
  // (a sensible starting point for a fresh MIDI track); toggling back to
  // 'audio' leaves the instrumentId in place (harmless — it's only consulted
  // for MIDI clips).
  const isMidi = track.kind === 'midi';
  const toggleKind = () => {
    const nextKind: AudioTrack['kind'] = isMidi ? 'audio' : 'midi';
    // Switching to MIDI defaults the instrument to the soundfont piano if the
    // track doesn't already have one set; switching to audio clears the input
    // back to 'none' (a MIDI-armed audio track makes no sense).
    const patch: Partial<AudioTrack> = { kind: nextKind };
    if (nextKind === 'midi') {
      if (!track.instrumentId) patch.instrumentId = SOUNDFONT_PIANO_ID;
      // If the track was armed for mic, drop the arm — MIDI tracks arm for
      // instrument-take recording, not mic input.
      if (track.armed) { patch.armed = false; patch.input = 'none'; }
    } else if (track.input === 'midi') {
      patch.input = 'none';
      patch.armed = false;
    }
    update(patch);
  };

  // Arm button: on an audio track → 'mic' input; on a MIDI track → 'midi'
  // input. The arm state still toggles; only the input source differs.
  const toggleArm = () => {
    if (track.armed) update({ armed: false, input: 'none' });
    else update({ armed: true, input: isMidi ? 'midi' : 'mic' });
  };

  return (
    <div className="border-b border-border/15 px-2 py-1" style={{ height: TRACK_H }}>
      <div className="flex items-center gap-0.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: track.color }} />
        <input type="text" value={track.name} onChange={(e) => update({ name: e.target.value })} className="min-w-0 flex-1 bg-transparent text-[11px] font-medium text-text outline-none" />
        {/* Kind toggle: Audio (Volume2 icon) ↔ MIDI (Piano icon). Highlighted
            when MIDI so the kind is visually distinct at a glance. */}
        <button onClick={toggleKind} className={`flex h-4 w-4 items-center justify-center rounded ${isMidi ? 'bg-accent/30 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title={isMidi ? 'MIDI track (click for Audio)' : 'Audio track (click for MIDI)'}>{isMidi ? <Piano size={9} /> : <Volume2 size={9} />}</button>
        <button onClick={() => update({ muted: !track.muted })} className={`flex h-4 w-4 items-center justify-center rounded ${track.muted && !hasSolo ? 'bg-warn/30 text-warn' : 'text-text-mid hover:bg-bg-3'}`} title="M">{track.muted ? <VolumeX size={9} /> : <Volume2 size={9} />}</button>
        <button onClick={() => update({ solo: !track.solo })} className={`flex h-4 w-4 items-center justify-center rounded ${track.solo ? 'bg-accent/30 text-accent' : 'text-text-mid hover:bg-bg-3'}`} title="S"><Headphones size={9} /></button>
        <button onClick={toggleArm} className={`flex h-4 w-4 items-center justify-center rounded ${track.armed ? 'bg-danger/30 text-danger' : 'text-text-mid hover:bg-bg-3'}`} title={isMidi ? 'Arm for MIDI take' : 'Arm'}><div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: track.armed ? 'currentColor' : 'transparent', border: '1px solid currentColor' }} /></button>
        <button onClick={() => deleteAudioTrack(slate, track.id)} className="flex h-4 w-4 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger" title="Del"><Trash2 size={9} /></button>
      </div>
      {/* MIDI tracks: instrument picker row replaces the pan slider row.
          Audio tracks keep the original volume + pan slider row. */}
      {isMidi ? (
        <div className="mt-0.5 flex items-center gap-1">
          <Piano size={9} className="shrink-0 text-accent" aria-hidden />
          <select
            value={track.instrumentId ?? SOUNDFONT_PIANO_ID}
            onChange={(e) => update({ instrumentId: e.target.value })}
            className="min-w-0 flex-1 rounded-sm border border-border bg-bg-3 px-1 py-0.5 text-[9px] text-text outline-none focus:border-accent"
            aria-label="Instrument"
            title="Which instrument plays this track's MIDI clips"
          >
            <option value={SOUNDFONT_PIANO_ID}>Soundfont Piano</option>
            <optgroup label="Synth presets">
              {INSTRUMENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            {(() => {
              const customs = loadCustomInstruments();
              return customs.length > 0 ? (
                <optgroup label="My instruments">
                  {customs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </optgroup>
              ) : null;
            })()}
          </select>
        </div>
      ) : (
        <div className="mt-0.5 flex items-center gap-1">
          <Volume2 size={9} className="shrink-0 text-text-dim" aria-hidden />
          <input type="range" min={0} max={1} step={0.01} value={vol} aria-label="Volume" title="Volume" onPointerDown={onVolDown} onChange={(e) => onVol(Number(e.target.value))} onPointerUp={onVolEnd} className="h-1 min-w-0 flex-1 accent-accent" />
          <span className="shrink-0 text-[8px] font-medium leading-none text-text-dim" aria-hidden>L</span>
          <input type="range" min={-1} max={1} step={0.01} value={pan} aria-label="Pan" title="Pan" onPointerDown={onPanDown} onChange={(e) => onPan(Number(e.target.value))} onPointerUp={onPanEnd} className="h-1 w-10 accent-accent" />
          <span className="shrink-0 text-[8px] font-medium leading-none text-text-dim" aria-hidden>R</span>
        </div>
      )}
    </div>
  );
});

// ── Clip block ──────────────────────────────────────────────────────────────

const ClipBlock = memo(function ClipBlock({ clip, pxPerSec, selected, onDragStart, onTrimStart }: {
  clip: AudioClip; pxPerSec: number; selected: boolean;
  onDragStart: (clip: AudioClip, e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => void;
  onTrimStart: (clip: AudioClip, side: 'left' | 'right', e: React.PointerEvent, el: HTMLElement, waveEl: HTMLElement | null) => void;
}) {
  const left = clip.start * pxPerSec;
  const width = Math.max(4, clip.duration * pxPerSec);
  const elRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const w = Math.max(2, Math.floor(width));
  // Fade overlay widths (clamped to the clip box so a too-long fade doesn't
  // spill past the opposite edge).
  const fadeInW = clip.fadeIn > 0 ? Math.min(width, clip.fadeIn * pxPerSec) : 0;
  const fadeOutW = clip.fadeOut > 0 ? Math.min(width, clip.fadeOut * pxPerSec) : 0;

  // onDragStart handles selection (incl. Shift/Cmd additive) + the
  // clip-select event — selecting here too would clobber multi-select.
  // `data-clip-id` is set so the multi-drag startDrag can look up every
  // selected clip's DOM element via document.querySelector when assembling
  // the `origins` map (see startDrag's multiDrag branch).
  return (
    <div ref={elRef} data-clip-id={clip.id} onPointerDown={(e) => { if (elRef.current) onDragStart(clip, e, elRef.current, waveRef.current); }}
      className={`group pointer-events-auto absolute top-0.5 bottom-0.5 cursor-grab overflow-hidden rounded border ${selected ? 'border-warn' : 'border-black/30'} active:cursor-grabbing`} style={{ left, width, backgroundColor: `${clip.color}20` }}>
      {/* Fixed-width waveform layer — clipped by the box so trimming cuts the
          audio rather than squashing the whole wave into a smaller space. */}
      <div ref={waveRef} className="pointer-events-none absolute top-0 bottom-0 left-0" style={{ width }}>
        {clip.sampleKey && <WaveformImg clipId={clip.id} sampleKey={clip.sampleKey} channels={clip.channels} sampleRate={clip.sampleRate} offset={clip.offset} duration={clip.duration} speed={clip.speed ?? 1} width={w} color={clip.color} />}
      </div>
      {/* Fade-in overlay: triangle from full height at the outer (left) edge
          tapering to 0 at the inner edge — the dark wedge represents the
          portion of the clip still under the fade. */}
      {fadeInW > 0 && (
        <div className="pointer-events-none absolute top-0 bottom-0 left-0 bg-black/30" style={{ width: fadeInW, clipPath: 'polygon(0% 0%, 0% 100%, 100% 50%)' }} />
      )}
      {/* Fade-out overlay: mirrored on the right side. */}
      {fadeOutW > 0 && (
        <div className="pointer-events-none absolute top-0 bottom-0 right-0 bg-black/30" style={{ width: fadeOutW, clipPath: 'polygon(100% 0%, 100% 100%, 0% 50%)' }} />
      )}
      <span className="absolute left-1 top-0 truncate text-[7px] font-medium text-text-mid/70 pointer-events-none">{clip.name}{clip.mute ? ' (muted)' : ''}</span>
      <div onPointerDown={(e) => { if (elRef.current) onTrimStart(clip, 'left', e, elRef.current, waveRef.current); }} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 opacity-0 group-hover:opacity-100" />
      <div onPointerDown={(e) => { if (elRef.current) onTrimStart(clip, 'right', e, elRef.current, waveRef.current); }} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/40 opacity-0 group-hover:opacity-100" />
    </div>
  );
});
