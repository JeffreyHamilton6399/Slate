/**
 * Audio scene helpers — create/update/delete tracks and clips in the Yjs doc.
 * Audio samples are stored in IndexedDB (NOT Yjs) — only a sampleKey reference
 * is kept in the Yjs clip. This keeps the Yjs document tiny even with
 * multi-minute songs.
 */

import * as Y from 'yjs';
import { Midi } from '@tonejs/midi';
import type { AudioClip, AudioTrack, NoteEvent } from '@slate/sync-protocol';
import type { SlateDoc } from '../sync/doc';
import { makeId } from '../utils/id';
import { storeSamples, loadSamples } from './sampleStore';

const TRACK_COLORS = ['#7c6aff', '#22d3a5', '#fbbf24', '#f87171', '#60a5fa', '#f472b6', '#34d399', '#fb923c'];

// ── Track helpers ───────────────────────────────────────────────────────────

export function addAudioTrack(slate: SlateDoc, partial?: Partial<AudioTrack>): string {
  const id = makeId('track');
  const count = slate.audioTracks().size;
  const track: AudioTrack = {
    id, name: partial?.name ?? `Track ${count + 1}`,
    color: partial?.color ?? TRACK_COLORS[count % TRACK_COLORS.length]!,
    volume: partial?.volume ?? 0.8, pan: partial?.pan ?? 0,
    muted: partial?.muted ?? false, solo: partial?.solo ?? false,
    kind: partial?.kind ?? 'audio', input: partial?.input ?? 'none',
    armed: partial?.armed ?? false, order: partial?.order ?? count,
  };
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(track)) m.set(k, v);
  slate.audioTracks().set(id, m);
  return id;
}

export function updateAudioTrack(slate: SlateDoc, id: string, patch: Partial<AudioTrack>): void {
  const yo = slate.audioTracks().get(id); if (!yo) return;
  slate.doc.transact(() => { for (const [k, v] of Object.entries(patch)) yo.set(k, v); });
}

export function deleteAudioTrack(slate: SlateDoc, id: string): void {
  slate.doc.transact(() => {
    slate.audioTracks().delete(id);
    const clips = slate.audioClips();
    const toDelete: string[] = [];
    clips.forEach((c, cid) => { if (c.get('trackId') === id) toDelete.push(cid); });
    // Sample blobs deliberately stay in IndexedDB (see deleteAudioClip) so
    // Ctrl+Z can restore the track's clips playable.
    for (const cid of toDelete) clips.delete(cid);
  });
}

export function readAudioTrack(m: Y.Map<unknown>, id: string): AudioTrack | null {
  if (!m.has('id')) return null;
  return {
    id, name: (m.get('name') as string) ?? 'Track', color: (m.get('color') as string) ?? '#7c6aff',
    volume: (m.get('volume') as number) ?? 0.8, pan: (m.get('pan') as number) ?? 0,
    muted: (m.get('muted') as boolean) ?? false, solo: (m.get('solo') as boolean) ?? false,
    kind: (m.get('kind') as 'audio' | 'midi') ?? 'audio', input: (m.get('input') as 'mic' | 'midi' | 'none') ?? 'none',
    armed: (m.get('armed') as boolean) ?? false, order: (m.get('order') as number) ?? 0,
    eqLow: (m.get('eqLow') as number) ?? 0,
    eqMid: (m.get('eqMid') as number) ?? 0,
    eqHigh: (m.get('eqHigh') as number) ?? 0,
    reverbSend: (m.get('reverbSend') as number) ?? 0,
    delaySend: (m.get('delaySend') as number) ?? 0,
    instrumentId: (m.get('instrumentId') as string | undefined) ?? undefined,
  };
}

// ── Clip helpers ────────────────────────────────────────────────────────────

/** Add a clip. Samples are stored in IndexedDB; only a key goes in Yjs.
 *  `samples` may be a `number[]` (from decode/recording) or a `Float32Array`
 *  (from loadSamples/processing) — the latter is passed straight through to
 *  IndexedDB without an intermediate copy. */
export async function addAudioClip(
  slate: SlateDoc,
  trackId: string,
  clip: { start: number; samples: number[] | Float32Array; sampleRate: number; channels: number; duration: number; name: string; color?: string },
): Promise<string> {
  const id = makeId('clip');
  const sampleKey = `samples:${id}`;
  // Store samples in IndexedDB (NOT Yjs). Pass as Float32Array for speed.
  // syncInfo lets the multiplayer sync reduce (mono/downsample) big clips
  // instead of skipping them.
  const f32 = clip.samples instanceof Float32Array ? clip.samples : new Float32Array(clip.samples);
  await storeSamples(sampleKey, f32, { sampleRate: clip.sampleRate, channels: clip.channels });
  const track = slate.audioTracks().get(trackId);
  const color = clip.color ?? (track ? (track.get('color') as string) : '#7c6aff');
  const full: AudioClip = {
    id, trackId, start: clip.start, offset: 0, duration: clip.duration,
    sampleKey, sampleRate: clip.sampleRate, channels: clip.channels,
    name: clip.name, color, fadeIn: 0, fadeOut: 0,
  };
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(full)) m.set(k, v);
  slate.audioClips().set(id, m);
  return id;
}

export function updateAudioClip(slate: SlateDoc, id: string, patch: Partial<AudioClip>): void {
  const yo = slate.audioClips().get(id); if (!yo) return;
  slate.doc.transact(() => { for (const [k, v] of Object.entries(patch)) yo.set(k, v); });
}

/** Add a MIDI clip — note events are stored directly in the Yjs clip (no
 *  IndexedDB sample blob). The instrument is taken from the clip's
 *  `instrumentId` field if set, else from the track's `instrumentId` (read
 *  at playback time). `duration` defaults to the latest note end so the
 *  clip box on the timeline just contains its notes. */
export function addMidiClip(
  slate: SlateDoc,
  trackId: string,
  clip: { start: number; notes: AudioClip['notes']; name?: string; color?: string; duration?: number; instrumentId?: string },
): string {
  const id = makeId('clip');
  const notes = clip.notes ?? [];
  // Clip duration = last note end (with a tiny tail so the box reads cleanly),
  // unless the caller supplied an explicit duration.
  const lastEnd = notes.reduce((m, n) => Math.max(m, (n?.start ?? 0) + (n?.duration ?? 0)), 0);
  const duration = clip.duration ?? Math.max(0.25, lastEnd + 0.05);
  const track = slate.audioTracks().get(trackId);
  const color = clip.color ?? (track ? (track.get('color') as string) : '#7c6aff');
  const trackInst = track ? (track.get('instrumentId') as string | undefined) : undefined;
  const full: AudioClip = {
    id,
    trackId,
    start: clip.start,
    offset: 0,
    duration,
    sampleKey: '',
    sampleRate: 44100,
    channels: 1,
    name: clip.name ?? 'MIDI',
    color,
    fadeIn: 0,
    fadeOut: 0,
    kind: 'midi',
    notes,
    instrumentId: clip.instrumentId ?? trackInst,
  };
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(full)) m.set(k, v);
  slate.audioClips().set(id, m);
  return id;
}

export function deleteAudioClip(slate: SlateDoc, id: string): void {
  // The sample blob deliberately STAYS in IndexedDB: the AudioEditor's
  // Y.UndoManager can restore the clip's Yjs entry on Ctrl+Z, and the
  // restored clip must find its samples again. Orphaned blobs cost some
  // local storage but keep undo trustworthy.
  slate.audioClips().delete(id);
}

export async function splitAudioClip(slate: SlateDoc, id: string, splitTime: number): Promise<void> {
  const yo = slate.audioClips().get(id); if (!yo) return;
  const clip = readAudioClip(yo, id); if (!clip) return;
  const relTime = splitTime - clip.start;
  if (relTime <= 0 || relTime >= clip.duration) return;

  // MIDI clips: split the note list at the boundary. Notes whose start falls
  // before the split keep their full duration on the LEFT half (a held note
  // ringing past the split is fine — it just sustains). Notes whose start
  // falls at-or-after the split move to the RIGHT half with their start times
  // shifted back by relTime. No sample I/O — MIDI clips have no IndexedDB blob.
  if (clip.kind === 'midi') {
    const leftNotes: NonNullable<AudioClip['notes']> = [];
    const rightNotes: NonNullable<AudioClip['notes']> = [];
    for (const n of clip.notes ?? []) {
      if (n.start < relTime) leftNotes.push(n);
      else rightNotes.push({ ...n, start: n.start - relTime });
    }
    slate.doc.transact(() => {
      yo.set('duration', relTime);
      yo.set('notes', leftNotes);
      const newId = makeId('clip');
      const m = new Y.Map<unknown>();
      m.set('id', newId);
      m.set('trackId', clip.trackId);
      m.set('start', clip.start + relTime);
      m.set('offset', 0);
      m.set('duration', clip.duration - relTime);
      m.set('sampleKey', '');
      m.set('sampleRate', clip.sampleRate);
      m.set('channels', clip.channels);
      m.set('name', clip.name);
      m.set('color', clip.color);
      m.set('fadeIn', 0);
      m.set('fadeOut', 0);
      m.set('kind', 'midi');
      m.set('notes', rightNotes);
      if (clip.instrumentId) m.set('instrumentId', clip.instrumentId);
      slate.audioClips().set(newId, m);
    });
    return;
  }

  const channels = clip.channels;
  const splitSample = Math.floor(relTime * clip.sampleRate) * channels;
  const fullSamples = await loadSamples(clip.sampleKey);
  const samplesA = fullSamples.slice(0, splitSample);
  const samplesB = fullSamples.slice(splitSample);

  // Store the two halves in IndexedDB. samplesA/samplesB are already Float32Array
  // (slice() on a Float32Array returns Float32Array) — pass them straight through
  // without converting to number[] (which would double the memory for big clips).
  const newKey = `samples:${makeId('clip')}`;
  const syncInfo = { sampleRate: clip.sampleRate, channels: clip.channels };
  await storeSamples(clip.sampleKey, samplesA, syncInfo);
  await storeSamples(newKey, samplesB, syncInfo);

  slate.doc.transact(() => {
    yo.set('duration', relTime);
    const newId = makeId('clip');
    const m = new Y.Map<unknown>();
    m.set('id', newId);
    m.set('trackId', clip.trackId);
    m.set('start', clip.start + relTime);
    m.set('offset', 0);
    m.set('duration', clip.duration - relTime);
    m.set('sampleKey', newKey);
    m.set('sampleRate', clip.sampleRate);
    m.set('channels', channels);
    m.set('name', clip.name);
    m.set('color', clip.color);
    m.set('fadeIn', 0);
    m.set('fadeOut', 0);
    slate.audioClips().set(newId, m);
  });
}

/** Duplicate a clip on the same track. `startAt` places the copy at that
 *  timeline position (the editor passes the playhead); omitted, it lands
 *  right after the original. Shares the underlying samples by copying the
 *  IndexedDB blob to a new key so the dupe can be normalized/reversed
 *  independently. MIDI clips are duplicated without any sample I/O — the
 *  notes array is copied (deep) to the new clip. Per-clip settings (trim,
 *  gain, pan, fades, speed, pitch, filters) carry over to the copy. */
export async function duplicateAudioClip(slate: SlateDoc, id: string, startAt?: number): Promise<string | null> {
  const yo = slate.audioClips().get(id); if (!yo) return null;
  const clip = readAudioClip(yo, id); if (!clip) return null;
  const start = startAt ?? clip.start + clip.duration;
  let newId: string | null = null;
  if (clip.kind === 'midi') {
    // Deep-copy the notes so the dupe is fully independent (editing one doesn't
    // mutate the other through shared object references inside the Yjs array).
    const notesCopy = (clip.notes ?? []).map((n) => ({ ...n }));
    newId = addMidiClip(slate, clip.trackId, {
      start,
      notes: notesCopy,
      duration: clip.duration,
      name: `${clip.name} copy`,
      color: clip.color,
      instrumentId: clip.instrumentId,
    });
  } else {
    const samples = await loadSamples(clip.sampleKey);
    newId = await addAudioClip(slate, clip.trackId, {
      start,
      samples, // Float32Array passed directly — no number[] copy.
      sampleRate: clip.sampleRate,
      channels: clip.channels,
      duration: clip.duration,
      name: `${clip.name} copy`,
      color: clip.color,
    });
  }
  // Carry over per-clip settings that addAudioClip/addMidiClip default away —
  // a duplicate should sound identical to its source.
  if (newId) {
    updateAudioClip(slate, newId, {
      offset: clip.offset, gain: clip.gain, pan: clip.pan, mute: clip.mute,
      fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, speed: clip.speed,
      pitch: clip.pitch, hpCutoff: clip.hpCutoff, lpCutoff: clip.lpCutoff,
    });
  }
  return newId;
}

export function readAudioClip(m: Y.Map<unknown>, id: string): AudioClip | null {
  if (!m.has('id')) return null;
  const notesRaw = m.get('notes');
  return {
    id,
    trackId: (m.get('trackId') as string) ?? '',
    start: (m.get('start') as number) ?? 0,
    offset: (m.get('offset') as number) ?? 0,
    duration: (m.get('duration') as number) ?? 0,
    sampleKey: (m.get('sampleKey') as string) ?? '',
    sampleRate: (m.get('sampleRate') as number) ?? 44100,
    channels: (m.get('channels') as number) ?? 1,
    name: (m.get('name') as string) ?? 'Clip',
    color: (m.get('color') as string) ?? '#7c6aff',
    fadeIn: (m.get('fadeIn') as number) ?? 0,
    fadeOut: (m.get('fadeOut') as number) ?? 0,
    gain: (m.get('gain') as number) ?? 1,
    pan: (m.get('pan') as number) ?? 0,
    mute: (m.get('mute') as boolean) ?? false,
    speed: (m.get('speed') as number) ?? 1,
    pitch: (m.get('pitch') as number) ?? 0,
    hpCutoff: (m.get('hpCutoff') as number) ?? 20,
    lpCutoff: (m.get('lpCutoff') as number) ?? 20000,
    kind: (m.get('kind') as 'audio' | 'midi' | undefined) ?? undefined,
    notes: Array.isArray(notesRaw) ? (notesRaw as AudioClip['notes']) : undefined,
    instrumentId: (m.get('instrumentId') as string | undefined) ?? undefined,
  };
}

/** Load samples from IndexedDB by sampleKey (async — don't call in render loops). */
export async function readAudioClipSamples(sampleKey: string): Promise<Float32Array> {
  return loadSamples(sampleKey);
}

export function setAudioBpm(slate: SlateDoc, bpm: number): void {
  const a = slate.doc.getMap('audio');
  a.set('bpm', Math.max(20, Math.min(300, bpm)));
}

// ── Audio decode helpers ────────────────────────────────────────────────────

export async function decodeAudioFile(file: File): Promise<{
  samples: number[]; sampleRate: number; channels: number; duration: number;
}> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const interleaved = new Float32Array(length * channels);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) interleaved[i * channels + ch] = data[i]!;
  }
  // Convert to number[] — but use a plain for loop instead of Array.from
  // for better performance with large arrays.
  const samples: number[] = new Array(interleaved.length);
  for (let i = 0; i < interleaved.length; i++) samples[i] = interleaved[i]!;
  return { samples, sampleRate: audioBuffer.sampleRate, channels, duration: audioBuffer.duration };
}

/** Decode a Standard MIDI File (.mid / .midi) into a flat note list + tempo.
 *  Uses @tonejs/midi which handles the SMPTE-to-seconds conversion (with
 *  tempo changes). Notes from every track are flattened into one list (the
 *  MIDI clip model is a single instrument voice, not multi-track). The
 *  returned notes' `start` times are relative to the start of the file
 *  (which becomes the start of the clip we create). */
export async function decodeMidiFile(file: File): Promise<{
  notes: NoteEvent[];
  duration: number;
  tempo: number;
}> {
  const arrayBuffer = await file.arrayBuffer();
  const midi = new Midi(arrayBuffer);
  // @tonejs/midi keeps notes per Track; flatten into one list, preserving
  // each note's absolute time (seconds from the start of the file).
  const notes: NoteEvent[] = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        velocity: n.velocity,
        start: n.time,
        duration: n.duration,
      });
    }
  }
  return {
    notes,
    duration: midi.duration,
    tempo: midi.header.tempos[0]?.bpm ?? 120,
  };
}
