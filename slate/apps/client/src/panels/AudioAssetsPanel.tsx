/**
 * AudioAssetsPanel — a dockable panel for audio-mode boards. Provides quick
 * access to imported audio files, a built-in metronome sample, and a place
 * to drag-drop new audio. Clicking an asset creates a new track with the
 * audio placed at the playhead.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileAudio, Upload, Music, Plus } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import { addAudioClip, addAudioTrack, decodeAudioFile, readAudioClip } from '../audio/scene';
import { loadSamples, float32ToNumberArray } from '../audio/sampleStore';
import {
  AUDIO_LIBRARY,
  LIBRARY_CATEGORIES,
  LIBRARY_SAMPLE_RATE,
  librarySamplePcm,
  previewLibrarySample,
  type LibraryCategory,
  type LibrarySample,
} from '../audio/library';

export function AudioAssetsPanel() {
  const room = useRoom();
  const slate = room.slate;
  const [, setVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Which library sections are expanded — Drums open by default.
  const [openCats, setOpenCats] = useState<Set<LibraryCategory>>(() => new Set(['Drums']));
  const toggleCat = (cat: LibraryCategory) =>
    setOpenCats((cur) => {
      const next = new Set(cur);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  useEffect(() => {
    const clips = slate.audioClips();
    const bump = () => setVersion((v) => v + 1);
    clips.observeDeep(bump);
    bump();
    return () => clips.unobserveDeep(bump);
  }, [slate]);

  // Collect unique clip names (by name — each unique audio file appears once).
  const assets = (() => {
    const seen = new Map<string, { id: string; name: string; duration: number }>();
    slate.audioClips().forEach((m, id) => {
      const c = readAudioClip(m, id);
      if (c && !seen.has(c.name)) seen.set(c.name, { id, name: c.name, duration: c.duration });
    });
    return [...seen.values()];
     
  })();

  const handleImport = async (file: File) => {
    try {
      const decoded = await decodeAudioFile(file);
      const trackId = addAudioTrack(slate, { name: file.name.replace(/\.[^.]+$/, '') });
      // Await so the samples are committed to IndexedDB before we toast —
      // pressing Play immediately after otherwise races the sample write.
      await addAudioClip(slate, trackId, {
        start: 0,
        samples: decoded.samples,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        duration: decoded.duration,
        name: file.name,
      });
      toast({ title: 'Imported', description: file.name });
    } catch (err) {
      toast({ title: 'Import failed', description: (err as Error).message, variant: 'error' });
    }
  };

  /** Add a built-in library sample to a new track at t=0. */
  const addLibrary = async (sample: LibrarySample) => {
    try {
      const pcm = await librarySamplePcm(sample);
      const trackId = addAudioTrack(slate, { name: sample.name });
      await addAudioClip(slate, trackId, {
        start: 0,
        samples: pcm,
        sampleRate: LIBRARY_SAMPLE_RATE,
        channels: 1,
        duration: pcm.length / LIBRARY_SAMPLE_RATE,
        name: sample.name,
      });
      toast({ title: 'Added to new track', description: sample.name });
    } catch (err) {
      toast({ title: 'Sample unavailable', description: (err as Error).message, variant: 'error' });
    }
  };

  return (
    <div
      className="flex h-full flex-col gap-2 p-2"
      // The tips below advertise "Drag audio files here" — without these
      // handlers the browser would navigate away to the dropped file instead.
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...(e.dataTransfer?.files ?? [])].filter((f) =>
          /\.(mp3|wav|ogg|m4a|flac|aac|webm)$/i.test(f.name),
        );
        if (files.length === 0) return;
        e.preventDefault();
        for (const f of files) void handleImport(f);
      }}
    >
      <div className="flex items-center justify-between">
        <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">Audio Assets</h5>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Import audio files — or drag & drop them onto this panel or the timeline"
          className="flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-text-mid hover:bg-bg-3"
        >
          <Upload size={10} />
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* Built-in library: synthesized one-shots grouped by kind — click a
          name to preview, + to drop it on a new track. Sections collapse so
          the panel stays scannable. */}
      <div className="max-h-64 overflow-y-auto">
        <p className="mb-1 flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          <Music size={10} />
          Library
        </p>
        {LIBRARY_CATEGORIES.map((cat) => {
          const items = AUDIO_LIBRARY.filter((s) => s.category === cat);
          const isOpen = openCats.has(cat);
          return (
            <div key={cat} className="mb-1">
              <button
                type="button"
                onClick={() => toggleCat(cat)}
                className="flex w-full items-center gap-1 rounded-sm px-0.5 py-0.5 text-[10px] font-medium text-text-mid hover:bg-bg-3 hover:text-text"
                aria-expanded={isOpen}
              >
                {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                {cat}
                <span className="ml-auto font-mono text-[9px] text-text-dim">{items.length}</span>
              </button>
              {isOpen && (
                <div className="mt-0.5 grid grid-cols-2 gap-1">
                  {items.map((s) => (
                    <div
                      key={s.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-slate-audio-library', s.id);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className="group flex items-center gap-1 rounded-sm border border-border bg-bg-3 px-1.5 py-1 hover:border-accent/40 cursor-grab active:cursor-grabbing"
                    >
                      <button
                        type="button"
                        onClick={() => previewLibrarySample(s)}
                        className="min-w-0 flex-1 truncate text-left text-[11px] text-text hover:text-accent"
                        title={`Preview ${s.name} (${s.duration.toFixed(2)}s)`}
                      >
                        {s.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => void addLibrary(s)}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-text-mid hover:bg-bg-4 hover:text-accent"
                        aria-label={`Add ${s.name} to a new track`}
                        title="Add to new track"
                      >
                        <Plus size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">Imported</p>
      {assets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-text-dim">
          Import audio files to build your library. They&apos;ll appear here for quick access.
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {assets.map((asset) => (
            <div
              key={asset.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-slate-audio-asset', asset.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title="Drag onto a timeline track, or + to add to a new track"
              className="group flex items-center gap-2 rounded-sm border border-border bg-bg-3 p-2 hover:border-accent/40 cursor-grab active:cursor-grabbing"
            >
              <FileAudio size={14} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-text">{asset.name}</p>
                <p className="text-[10px] font-mono text-text-dim">{asset.duration.toFixed(1)}s</p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const clip = readAudioClip(slate.audioClips().get(asset.id)!, asset.id);
                  if (!clip) return;
                  const samples = await loadSamples(clip.sampleKey);
                  // Guard BEFORE creating anything: a remote peer's clip whose
                  // sample blob hasn't synced yet would otherwise copy into a
                  // permanently-silent clip (empty samples stored under a new
                  // key that nothing ever refills).
                  if (samples.length === 0) {
                    toast({
                      title: 'Samples still syncing',
                      description: 'This asset’s audio hasn’t arrived yet — try again in a moment.',
                      variant: 'error',
                    });
                    return;
                  }
                  const trackId = addAudioTrack(slate, { name: `${asset.name} track` });
                  await addAudioClip(slate, trackId, {
                    start: 0,
                    samples: float32ToNumberArray(samples),
                    sampleRate: clip.sampleRate,
                    channels: clip.channels,
                    duration: clip.duration,
                    name: clip.name,
                  });
                  toast({ title: 'Added to new track' });
                }}
                className="flex h-5 w-5 items-center justify-center rounded-sm text-text-mid opacity-0 group-hover:opacity-100 hover:bg-bg-4 hover:text-accent"
                aria-label="Add to new track"
              >
                <Plus size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
