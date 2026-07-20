/**
 * Export dialog — pick a format and download. Format options depend on
 * whether the current board is 2D, 3D, Audio, or Doc.
 *
 *   2D    → png / jpg / webp / svg / mp4 (canvas animation)
 *   3D    → glb / gltf / obj / stl / ply / fbx / mp4 (animation render)
 *   Audio → wav (offline mixdown) / mp3 (192 kbps MP3, offline encode)
 *   Doc   → md (Markdown) / txt (plain text) — straight off the Yjs
 *           fragment, no editor instance needed.
 *
 * Audio mode previously fell through to the 2D branch and produced blank
 * PNGs — it now renders the mix via OfflineAudioContext (WAV) or encodes
 * an MP3 with lamejs from the same offline-rendered buffer.
 */

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { exportRaster, exportSvg, type RasterFormat } from './export2d';
import { export3D, type ThreeDFormat } from './export3d';
import { export2dVideo } from './export2dVideo';
import { exportAudioWav, exportAudioMp3 } from './exportAudio';
import { readSceneSnapshot } from '../viewport3d/scene';
import { useScene3DStore } from '../viewport3d/store';
import { useCanvasStore } from '../canvas2d/store';
import { readAudioClip } from '../audio/scene';
import { docFragmentToMarkdown, docFragmentToText } from '../docs/exportMarkdown';
import { toast } from '../ui/Toast';
import type { DocMode } from '@slate/sync-protocol';
import {
  layerSchema,
  shapeSchema,
  strokeSchema,
  type Layer,
  type Shape,
  type Stroke,
} from '@slate/sync-protocol';
import { readMeta } from '../sync/doc';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** Per-format descriptions, Photoshop/Blender export-dialog style. */
const FORMAT_INFO: Record<string, string> = {
  png: 'Lossless raster — best for sharing; supports transparency.',
  jpg: 'Small lossy raster — no transparency.',
  webp: 'Modern raster — small files, supports transparency.',
  svg: 'Vector — infinite resolution, editable in Illustrator/Figma.',
  mp4: 'Video — captures the timeline / animation playback.',
  glb: 'Binary glTF — the standard for web/game engines (one file).',
  gltf: 'JSON glTF — human-readable scene + materials.',
  obj: 'Wavefront OBJ — universal mesh interchange (transforms baked).',
  stl: '3D-printing mesh — geometry only.',
  ply: 'Point/mesh research format — geometry only.',
  fbx: 'Autodesk FBX — DCC interchange (Blender, Maya, Unity).',
  wav: 'Audio mixdown — lossless 16-bit PCM, plays anywhere.',
  mp3: 'Audio mixdown — 192 kbps MP3, tiny files, plays everywhere.',
  md: 'Markdown — headings, lists, code blocks; opens in any text editor.',
  txt: 'Plain text — formatting stripped, maximum compatibility.',
};

type ExportFormat = RasterFormat | 'svg' | 'mp4' | 'wav' | 'mp3' | 'md' | 'txt' | ThreeDFormat;

/** Default format per board mode — used when the dialog opens or the mode
 *  changes so a stale format from another mode is never selected. */
function defaultFormatForMode(mode: DocMode | undefined): ExportFormat {
  if (mode === '3d') return 'glb';
  if (mode === 'audio') return 'wav';
  if (mode === 'doc') return 'md';
  return 'png';
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const mode = (board?.mode ?? '2d') as DocMode;
  const is3d = mode === '3d';
  const isAudio = mode === 'audio';
  const isDoc = mode === 'doc';
  const [format, setFormat] = useState<ExportFormat>(defaultFormatForMode(mode));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // 2D settings (Photoshop-style).
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [quality, setQuality] = useState(0.92);
  // 3D settings (Blender-style).
  const [selectedOnly, setSelectedOnly] = useState(false);

  // Reset the format whenever the board mode changes — a stale 'glb' from a
  // 3D board would silently produce nothing on an audio board, etc.
  useEffect(() => {
    setFormat(defaultFormatForMode(mode));
  }, [mode]);

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(0);
    try {
      if (isDoc) {
        // Doc mode — serialize the shared rich-text fragment directly.
        const fragment = room.slate.docText();
        if (format === 'md') {
          downloadText(docFragmentToMarkdown(fragment), `${board?.name ?? 'slate'}.md`, 'text/markdown');
        } else if (format === 'txt') {
          downloadText(docFragmentToText(fragment), `${board?.name ?? 'slate'}.txt`, 'text/plain');
        } else {
          throw new Error(`Unsupported document format: ${format}`);
        }
      } else if (isAudio) {
        // Audio mode — WAV mixdown or MP3 (lamejs) encode, both offline.
        const duration = computeAudioDuration(room.slate);
        if (duration <= 0) throw new Error('Nothing to export — add some audio clips first.');
        if (format === 'wav') {
          await exportAudioWav({ slate: room.slate, duration, onProgress: setProgress });
        } else if (format === 'mp3') {
          await exportAudioMp3({ slate: room.slate, duration, onProgress: setProgress });
        } else {
          throw new Error(`Unsupported audio format: ${format}`);
        }
      } else if (is3d) {
        if (format === 'mp4') {
          // The dialog doesn't own the 3D canvas — hand off to the viewport's
          // existing render-animation flow (it captures + downloads itself).
          window.dispatchEvent(new CustomEvent('slate:export-3d-animation'));
          toast({ title: 'Rendering animation', description: 'Capturing the 3D viewport…' });
        } else {
          const snap = readSceneSnapshot(room.slate);
          const selection = new Set(useScene3DStore.getState().selection);
          const objects =
            selectedOnly && selection.size > 0
              ? snap.objects.filter((o) => selection.has(o.id))
              : snap.objects;
          if (objects.length === 0) throw new Error('Nothing selected to export.');
          const blob = await export3D(format as ThreeDFormat, {
            objects,
            meshes: snap.meshes,
            materials: snap.materials,
            boardName: board?.name ?? 'slate',
          });
          downloadBlob(blob, `${board?.name ?? 'slate'}.${format}`);
        }
      } else {
        // 2D mode.
        if (format === 'mp4') {
          // Grab the live 2D canvas (the minimap canvas carries an aria-label,
          // so skip it) and record it while stepping through the timeline.
          const canvas = document.querySelector<HTMLCanvasElement>('canvas:not([aria-label])')
            ?? document.querySelector<HTMLCanvasElement>('canvas');
          if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
            throw new Error('This browser can’t record the canvas.');
          }
          const store = useCanvasStore.getState();
          await export2dVideo({
            canvas,
            fps: store.animFps,
            duration: store.animDuration,
            onProgress: setProgress,
          });
        } else if (format === 'svg') {
          const { layers, shapesByLayer, strokesByLayer } = read2DScene(room);
          const meta = readMeta(room.slate);
          downloadText(
            exportSvg({ layers, shapesByLayer, strokesByLayer, paper: meta.paper ?? '#0c0c0e' }),
            `${board?.name ?? 'slate'}.svg`,
            'image/svg+xml',
          );
        } else {
          const { layers, shapesByLayer, strokesByLayer } = read2DScene(room);
          const meta = readMeta(room.slate);
          const blob = await exportRaster({
            layers,
            shapesByLayer,
            strokesByLayer,
            paper: meta.paper ?? '#0c0c0e',
            format: format as RasterFormat,
            scale,
            transparent,
            quality,
            maxSize: 8192,
          });
          downloadBlob(blob, `${board?.name ?? 'slate'}.${format}`);
        }
      }
      toast({ title: 'Export complete' });
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast({ title: 'Export failed', description: (err as Error).message, variant: 'error' });
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const formats: readonly ExportFormat[] = isDoc
    ? (['md', 'txt'] as const)
    : isAudio
      ? (['wav', 'mp3'] as const)
      : is3d
        ? (['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'mp4'] as const)
        : (['png', 'jpg', 'webp', 'svg', 'mp4'] as const);
  const raster = !is3d && !isAudio && !isDoc && format !== 'svg' && format !== 'mp4';

  const description = isDoc
    ? 'Export the document to a file.'
    : isAudio
      ? 'Export the audio mix to a file.'
      : is3d
        ? 'Export this 3D scene to a file.'
        : 'Export this canvas to a file.';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export"
      description={description}
    >
      <div className="flex flex-col gap-3">
        <div>
          <label className="field-label">Format</label>
          <div className="grid grid-cols-3 gap-1">
            {formats.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                aria-pressed={format === f}
                className={
                  'rounded-sm border px-2 py-1.5 text-xs uppercase font-mono tracking-wider ' +
                  (format === f
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-border text-text-mid hover:bg-bg-3')
                }
              >
                {f}
              </button>
            ))}
          </div>
          <p className="mt-1.5 min-h-8 text-xs text-text-dim">{FORMAT_INFO[format]}</p>
        </div>

        {raster && (
          <div className="flex flex-col gap-2.5 rounded-sm border border-border bg-bg-3 p-2.5">
            <div className="flex items-center gap-2">
              <span className="field-label m-0 w-16">Size</span>
              <div className="flex rounded-sm bg-bg-4 p-0.5">
                {[1, 2, 4].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScale(s)}
                    aria-pressed={scale === s}
                    className={
                      'rounded-sm px-2.5 py-1 text-xs font-mono ' +
                      (scale === s ? 'bg-accent/20 text-accent' : 'text-text-dim hover:text-text')
                    }
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
            {format !== 'jpg' && (
              <label className="flex items-center gap-2 text-xs text-text-mid">
                <input
                  type="checkbox"
                  checked={transparent}
                  onChange={(e) => setTransparent(e.target.checked)}
                  className="accent-accent"
                />
                Transparent background
              </label>
            )}
            {format !== 'png' && (
              <label className="flex items-center gap-2 text-xs text-text-mid">
                <span className="field-label m-0 w-16">Quality</span>
                <input
                  type="range"
                  min={0.4}
                  max={1}
                  step={0.02}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="flex-1 accent-accent"
                />
                <span className="w-8 text-right font-mono">{Math.round(quality * 100)}</span>
              </label>
            )}
          </div>
        )}

        {is3d && format !== 'mp4' && (
          <div className="flex flex-col gap-2 rounded-sm border border-border bg-bg-3 p-2.5">
            <label className="flex items-center gap-2 text-xs text-text-mid">
              <input
                type="checkbox"
                checked={selectedOnly}
                onChange={(e) => setSelectedOnly(e.target.checked)}
                className="accent-accent"
              />
              Selected objects only
            </label>
            <p className="text-[11px] text-text-dim">
              Scale: 1 unit = 1 m. Lights and cameras are not exported.
            </p>
          </div>
        )}

        {is3d && format === 'mp4' && (
          <div className="rounded-sm border border-border bg-bg-3 p-2.5">
            <p className="text-[11px] text-text-dim">
              Renders the 3D animation timeline to a video. MP4 (H.264) is
              preferred; browsers without MP4 encoding fall back to WebM.
              Make sure your scene has keyframes — the render button checks for them.
            </p>
          </div>
        )}

        {isAudio && (
          <div className="rounded-sm border border-border bg-bg-3 p-2.5">
            <p className="text-[11px] text-text-dim">
              {format === 'wav'
                ? 'Renders every clip offline (fast) and encodes a 16-bit stereo WAV — bit-exact, no realtime wait.'
                : 'Renders every clip offline (fast) and encodes a 192 kbps MP3 with lamejs — tiny files, plays everywhere.'}
              {' '}
              Per-track volume/pan/mute/solo and per-clip gain/pan/speed are honoured.
            </p>
          </div>
        )}

        {busy && progress > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-text-dim">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-4">
              <div
                className="h-full bg-accent transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <span className="font-mono">{Math.round(progress * 100)}%</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onExport} disabled={busy}>
            <Download size={13} />
            <span className="ml-1.5">
              {busy
                ? progress > 0
                  ? `Exporting ${Math.round(progress * 100)}%…`
                  : 'Exporting…'
                : 'Export'}
            </span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Compute the audio mixdown duration from the latest clip end (matches the
 *  AudioEditor's timelineDuration math, minus the live playhead padding). */
function computeAudioDuration(slate: ReturnType<typeof useRoom>['slate']): number {
  let max = 0;
  slate.audioClips().forEach((m, id) => {
    const c = readAudioClip(m, id);
    if (!c) return;
    const end = c.start + c.duration;
    if (end > max) max = end;
  });
  // Small tail so reverb/ring-off isn't cut, and never less than a beat.
  return Math.max(1, max + 0.5);
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function downloadText(text: string, name: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), name);
}

interface Read2DResult {
  layers: Layer[];
  shapesByLayer: Map<string, Shape[]>;
  strokesByLayer: Map<string, Stroke[]>;
}

function read2DScene(room: ReturnType<typeof useRoom>): Read2DResult {
  const layers: Layer[] = [];
  room.slate.layers().forEach((m) => {
    const candidate = {
      id: m.get('id'),
      name: m.get('name'),
      visible: m.get('visible'),
      locked: m.get('locked'),
      opacity: m.get('opacity'),
    };
    const parsed = layerSchema.safeParse(candidate);
    if (parsed.success) layers.push(parsed.data);
  });
  const shapesByLayer = new Map<string, Shape[]>();
  const strokesByLayer = new Map<string, Stroke[]>();
  for (const l of layers) {
    shapesByLayer.set(l.id, []);
    strokesByLayer.set(l.id, []);
  }
  room.slate.shapes().forEach((m) => {
    const parsed = shapeSchema.safeParse({
      id: m.get('id'),
      kind: m.get('kind'),
      layerId: m.get('layerId'),
      x: m.get('x'),
      y: m.get('y'),
      w: m.get('w'),
      h: m.get('h'),
      rotation: m.get('rotation'),
      stroke: m.get('stroke'),
      fill: m.get('fill'),
      strokeWidth: m.get('strokeWidth'),
      strokeOpacity: m.get('strokeOpacity'),
      text: m.get('text'),
      fontSize: m.get('fontSize'),
      createdAt: m.get('createdAt'),
      authorId: m.get('authorId'),
    });
    if (!parsed.success) return;
    const lid = shapesByLayer.has(parsed.data.layerId)
      ? parsed.data.layerId
      : layers[layers.length - 1]?.id;
    if (!lid) return;
    shapesByLayer.get(lid)!.push(parsed.data);
  });
  room.slate.strokes().forEach((m) => {
    const parsed = strokeSchema.safeParse({
      id: m.get('id'),
      kind: m.get('kind'),
      layerId: m.get('layerId'),
      color: m.get('color'),
      size: m.get('size'),
      opacity: m.get('opacity'),
      points: m.get('points'),
      createdAt: m.get('createdAt'),
      authorId: m.get('authorId'),
    });
    if (!parsed.success) return;
    const lid = strokesByLayer.has(parsed.data.layerId)
      ? parsed.data.layerId
      : layers[layers.length - 1]?.id;
    if (!lid) return;
    strokesByLayer.get(lid)!.push(parsed.data);
  });
  return { layers, shapesByLayer, strokesByLayer };
}
