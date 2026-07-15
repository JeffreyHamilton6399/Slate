/**
 * Audio scene helpers — create/update/delete tracks and clips in the Yjs doc.
 * Audio samples are stored in IndexedDB (NOT Yjs) — only a sampleKey reference
 * is kept in the Yjs clip. This keeps the Yjs document tiny even with
 * multi-minute songs.
 */

import * as Y from 'yjs';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import type { SlateDoc } from '../sync/doc';
import { makeId } from '../utils/id';
import { storeSamples, loadSamples, deleteSamples } from './sampleStore';

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
    for (const cid of toDelete) { const sk = clips.get(cid)?.get('sampleKey') as string | undefined; if (sk) void deleteSamples(sk); clips.delete(cid); }
  });
}

export function readAudioTrack(m: Y.Map<unknown>, id: string): AudioTrack | null {
  if (!m.has('id')) return null;
  return {
    id, name: (m.get('name') as string) ?? 'Track', color: (m.get('color') as string) ?? '#7c6aff',
    volume: (m.get('volume') as number) ?? 0.8, pan: (m.get('pan') as number) ?? 0,
    muted: (m.get('muted') as boolean) ?? false, solo: (m.get('solo') as boolean) ?? false,
    kind: (m.get('kind') as 'audio' | 'midi') ?? 'audio', input: (m.get('input') as 'mic' | 'none') ?? 'none',
    armed: (m.get('armed') as boolean) ?? false, order: (m.get('order') as number) ?? 0,
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
  const f32 = clip.samples instanceof Float32Array ? clip.samples : new Float32Array(clip.samples);
  await storeSamples(sampleKey, f32);
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

export function deleteAudioClip(slate: SlateDoc, id: string): void {
  const yo = slate.audioClips().get(id);
  const sk = yo?.get('sampleKey') as string | undefined;
  if (sk) void deleteSamples(sk);
  slate.audioClips().delete(id);
}

export async function splitAudioClip(slate: SlateDoc, id: string, splitTime: number): Promise<void> {
  const yo = slate.audioClips().get(id); if (!yo) return;
  const clip = readAudioClip(yo, id); if (!clip) return;
  const relTime = splitTime - clip.start;
  if (relTime <= 0 || relTime >= clip.duration) return;

  const channels = clip.channels;
  const splitSample = Math.floor(relTime * clip.sampleRate) * channels;
  const fullSamples = await loadSamples(clip.sampleKey);
  const samplesA = fullSamples.slice(0, splitSample);
  const samplesB = fullSamples.slice(splitSample);

  // Store the two halves in IndexedDB. samplesA/samplesB are already Float32Array
  // (slice() on a Float32Array returns Float32Array) — pass them straight through
  // without converting to number[] (which would double the memory for big clips).
  const newKey = `samples:${makeId('clip')}`;
  await storeSamples(clip.sampleKey, samplesA);
  await storeSamples(newKey, samplesB);

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

/** Duplicate a clip (same track, placed right after the original). Shares the
 *  underlying samples by copying the IndexedDB blob to a new key so the dupe can
 *  be normalized/reversed independently. */
export async function duplicateAudioClip(slate: SlateDoc, id: string): Promise<string | null> {
  const yo = slate.audioClips().get(id); if (!yo) return null;
  const clip = readAudioClip(yo, id); if (!clip) return null;
  const samples = await loadSamples(clip.sampleKey);
  return addAudioClip(slate, clip.trackId, {
    start: clip.start + clip.duration,
    samples, // Float32Array passed directly — no number[] copy.
    sampleRate: clip.sampleRate,
    channels: clip.channels,
    duration: clip.duration,
    name: `${clip.name} copy`,
    color: clip.color,
  });
}

export function readAudioClip(m: Y.Map<unknown>, id: string): AudioClip | null {
  if (!m.has('id')) return null;
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
