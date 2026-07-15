/**
 * Audio scene helpers — create/update/delete tracks and clips in the Yjs doc.
 * Mirrors the pattern of viewport3d/scene.ts: pure functions that wrap Yjs
 * transactions so callers never touch raw Y.Map directly.
 */

import * as Y from 'yjs';
import type { AudioClip, AudioTrack } from '@slate/sync-protocol';
import type { SlateDoc } from '../sync/doc';
import { makeId } from '../utils/id';

const TRACK_COLORS = ['#7c6aff', '#22d3a5', '#fbbf24', '#f87171', '#60a5fa', '#f472b6', '#34d399', '#fb923c'];

// ── Track helpers ───────────────────────────────────────────────────────────

export function addAudioTrack(slate: SlateDoc, partial?: Partial<AudioTrack>): string {
  const id = makeId('track');
  const count = slate.audioTracks().size;
  const track: AudioTrack = {
    id,
    name: partial?.name ?? `Track ${count + 1}`,
    color: partial?.color ?? TRACK_COLORS[count % TRACK_COLORS.length]!,
    volume: partial?.volume ?? 0.8,
    pan: partial?.pan ?? 0,
    muted: partial?.muted ?? false,
    solo: partial?.solo ?? false,
    kind: partial?.kind ?? 'audio',
    input: partial?.input ?? 'none',
    armed: partial?.armed ?? false,
    order: partial?.order ?? count,
  };
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(track)) m.set(k, v);
  slate.audioTracks().set(id, m);
  return id;
}

export function updateAudioTrack(slate: SlateDoc, id: string, patch: Partial<AudioTrack>): void {
  const yo = slate.audioTracks().get(id);
  if (!yo) return;
  slate.doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) yo.set(k, v);
  });
}

export function deleteAudioTrack(slate: SlateDoc, id: string): void {
  slate.doc.transact(() => {
    slate.audioTracks().delete(id);
    const clips = slate.audioClips();
    const toDelete: string[] = [];
    clips.forEach((c, cid) => {
      if (c.get('trackId') === id) toDelete.push(cid);
    });
    for (const cid of toDelete) clips.delete(cid);
  });
}

export function readAudioTrack(m: Y.Map<unknown>, id: string): AudioTrack | null {
  if (!m.has('id')) return null;
  return {
    id,
    name: (m.get('name') as string) ?? 'Track',
    color: (m.get('color') as string) ?? '#7c6aff',
    volume: (m.get('volume') as number) ?? 0.8,
    pan: (m.get('pan') as number) ?? 0,
    muted: (m.get('muted') as boolean) ?? false,
    solo: (m.get('solo') as boolean) ?? false,
    kind: (m.get('kind') as 'audio' | 'midi') ?? 'audio',
    input: (m.get('input') as 'mic' | 'none') ?? 'none',
    armed: (m.get('armed') as boolean) ?? false,
    order: (m.get('order') as number) ?? 0,
  };
}

// ── Clip helpers ────────────────────────────────────────────────────────────

export function addAudioClip(
  slate: SlateDoc,
  trackId: string,
  clip: {
    start: number;
    samples: number[];
    sampleRate: number;
    channels: number;
    duration: number;
    name: string;
    color?: string;
  },
): string {
  const id = makeId('clip');
  const track = slate.audioTracks().get(trackId);
  const color = clip.color ?? (track ? (track.get('color') as string) : '#7c6aff');
  const full: AudioClip = {
    id,
    trackId,
    start: clip.start,
    offset: 0,
    duration: clip.duration,
    samples: clip.samples,
    sampleRate: clip.sampleRate,
    channels: clip.channels,
    name: clip.name,
    color,
    fadeIn: 0,
    fadeOut: 0,
  };
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(full)) m.set(k, v);
  slate.audioClips().set(id, m);
  return id;
}

export function updateAudioClip(slate: SlateDoc, id: string, patch: Partial<AudioClip>): void {
  const yo = slate.audioClips().get(id);
  if (!yo) return;
  slate.doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) yo.set(k, v);
  });
}

export function deleteAudioClip(slate: SlateDoc, id: string): void {
  slate.audioClips().delete(id);
}

export function splitAudioClip(slate: SlateDoc, id: string, splitTime: number): void {
  const yo = slate.audioClips().get(id);
  if (!yo) return;
  const clip = readAudioClip(yo, id);
  if (!clip) return;
  const relTime = splitTime - clip.start;
  if (relTime <= 0 || relTime >= clip.duration) return;

  const sampleRate = clip.sampleRate;
  const channels = clip.channels;
  const splitSample = Math.floor(relTime * sampleRate) * channels;
  const fullSamples = readAudioClipSamples(yo);
  const samplesA = fullSamples.slice(0, splitSample);
  const samplesB = fullSamples.slice(splitSample);

  slate.doc.transact(() => {
    yo.set('duration', relTime);
    yo.set('samples', samplesA);
    const newId = makeId('clip');
    const newClip: AudioClip = {
      ...clip,
      id: newId,
      start: clip.start + relTime,
      offset: 0,
      duration: clip.duration - relTime,
      samples: samplesB,
      name: clip.name,
    };
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(newClip)) m.set(k, v);
    slate.audioClips().set(newId, m);
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
    // DON'T copy samples here — it's potentially millions of numbers.
    // Use readAudioClipSamples() when you need the actual audio data.
    samples: [],
    sampleRate: (m.get('sampleRate') as number) ?? 44100,
    channels: (m.get('channels') as number) ?? 1,
    name: (m.get('name') as string) ?? 'Clip',
    color: (m.get('color') as string) ?? '#7c6aff',
    fadeIn: (m.get('fadeIn') as number) ?? 0,
    fadeOut: (m.get('fadeOut') as number) ?? 0,
  };
}

/** Read ONLY the samples array from a clip (heavy — don't call in render loops). */
export function readAudioClipSamples(m: Y.Map<unknown>): number[] {
  return (m.get('samples') as number[]) ?? [];
}

export function setAudioBpm(slate: SlateDoc, bpm: number): void {
  const a = slate.doc.getMap('audio');
  a.set('bpm', Math.max(20, Math.min(300, bpm)));
}

// ── Audio decode helpers ────────────────────────────────────────────────────

/** Decode an audio File into PCM samples using the Web Audio API. */
export async function decodeAudioFile(file: File): Promise<{
  samples: number[];
  sampleRate: number;
  channels: number;
  duration: number;
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
    for (let i = 0; i < length; i++) {
      interleaved[i * channels + ch] = data[i]!;
    }
  }
  return {
    samples: Array.from(interleaved),
    sampleRate: audioBuffer.sampleRate,
    channels,
    duration: audioBuffer.duration,
  };
}
