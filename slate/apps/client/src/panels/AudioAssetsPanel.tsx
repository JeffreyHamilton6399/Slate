/**
 * AudioAssetsPanel — a dockable panel for audio-mode boards. Provides quick
 * access to imported audio files, a built-in metronome sample, and a place
 * to drag-drop new audio. Clicking an asset creates a new track with the
 * audio placed at the playhead.
 */

import { useEffect, useRef, useState } from 'react';
import { FileAudio, Upload, Music, Trash2, Plus } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import { addAudioClip, addAudioTrack, decodeAudioFile, readAudioClip } from '../audio/scene';
import { loadSamples, float32ToNumberArray } from '../audio/sampleStore';

export function AudioAssetsPanel() {
  const room = useRoom();
  const slate = room.slate;
  const [version, setVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })();

  const handleImport = async (file: File) => {
    try {
      const decoded = await decodeAudioFile(file);
      const trackId = addAudioTrack(slate, { name: file.name.replace(/\.[^.]+$/, '') });
      addAudioClip(slate, trackId, {
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

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">Audio Assets</h5>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
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

      {assets.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-text-dim">
          Import audio files to build your library. They&apos;ll appear here for quick access.
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="group flex items-center gap-2 rounded-sm border border-border bg-bg-3 p-2 hover:border-accent/40"
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
                  const trackId = addAudioTrack(slate, { name: `${asset.name} track` });
                  const samples = await loadSamples(clip.sampleKey);
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

      {/* Quick tips */}
      <div className="mt-auto rounded-md border border-border bg-bg-3 p-2 text-[10px] text-text-dim">
        <p className="mb-1 font-medium text-text-mid">Tips</p>
        <p>• Drag audio files here or onto the timeline</p>
        <p>• Space = Play · R = Record · L = Loop</p>
        <p>• Drag clip edges to trim · Click to select</p>
      </div>
    </div>
  );
}
