/**
 * Export dialog — pick a format and download. Format options depend on
 * whether the current board is 2D or 3D.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { exportRaster, exportSvg, type RasterFormat } from './export2d';
import { export3D, type ThreeDFormat } from './export3d';
import { readSceneSnapshot } from '../viewport3d/scene';
import { useScene3DStore } from '../viewport3d/store';
import { toast } from '../ui/Toast';
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
  glb: 'Binary glTF — the standard for web/game engines (one file).',
  gltf: 'JSON glTF — human-readable scene + materials.',
  obj: 'Wavefront OBJ — universal mesh interchange (transforms baked).',
  stl: '3D-printing mesh — geometry only.',
  ply: 'Point/mesh research format — geometry only.',
  fbx: 'Autodesk FBX — DCC interchange (Blender, Maya, Unity).',
};

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const is3d = board?.mode === '3d';
  const [format, setFormat] = useState<RasterFormat | 'svg' | ThreeDFormat>(is3d ? 'glb' : 'png');
  const [busy, setBusy] = useState(false);
  // 2D settings (Photoshop-style).
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [quality, setQuality] = useState(0.92);
  // 3D settings (Blender-style).
  const [selectedOnly, setSelectedOnly] = useState(false);

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!is3d) {
        const { layers, shapesByLayer, strokesByLayer } = read2DScene(room);
        const meta = readMeta(room.slate);
        if (format === 'svg') {
          downloadText(exportSvg({ layers, shapesByLayer, strokesByLayer, paper: meta.paper ?? '#0c0c0e' }), `${board?.name ?? 'slate'}.svg`, 'image/svg+xml');
        } else {
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
      toast({ title: 'Export complete' });
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast({ title: 'Export failed', description: (err as Error).message, variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const formats = is3d
    ? (['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'] as const)
    : (['png', 'jpg', 'webp', 'svg'] as const);
  const raster = !is3d && format !== 'svg';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export"
      description={`Export this ${is3d ? '3D scene' : 'canvas'} to a file.`}
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

        {is3d && (
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

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onExport} disabled={busy}>
            <Download size={13} />
            <span className="ml-1.5">{busy ? 'Exporting…' : 'Export'}</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
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
