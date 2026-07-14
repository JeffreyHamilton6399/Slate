/**
 * LayersPanel — Photoshop-style layer list backed by Y.Array.
 *
 * Reorderable via dnd-kit (Phase 4 polish). For now we expose add / rename /
 * visibility / lock / opacity / delete which is enough for the 2D canvas to
 * route strokes to the active layer.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { Plus, Eye, EyeOff, Lock, LockOpen, Trash2 } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { Button } from '../ui/Button';
import { makeId } from '../utils/id';
import { layerSchema, type Layer } from '@slate/sync-protocol';
import { useLayersStore } from '../canvas2d/store';

export function LayersPanel() {
  const room = useRoom();
  const layers = useMemo(() => room.slate.layers(), [room]);
  const [items, setItems] = useState<Layer[]>(() => readLayers(layers));
  const activeLayerId = useLayersStore((s) => s.activeLayerId);
  const setActiveLayer = useLayersStore((s) => s.setActiveLayer);

  useEffect(() => {
    const update = () => setItems(readLayers(layers));
    layers.observeDeep(update);
    update();
    return () => layers.unobserveDeep(update);
  }, [layers]);

  // The canvas itself bootstraps a default "Layer 1" and pins the active
  // layer (see Canvas2D) so drawing works even when this panel is closed.
  // Default active to top layer if unset / stale (harmless duplicate of the
  // canvas's own check — both write the same id).
  useEffect(() => {
    if (items.length === 0) return;
    if (!activeLayerId || !items.find((l) => l.id === activeLayerId)) {
      setActiveLayer(items[items.length - 1]!.id);
    }
  }, [items, activeLayerId, setActiveLayer]);

  const addLayer = () => {
    room.slate.doc.transact(() => {
      const id = makeId('layer');
      layers.push([
        yLayer({
          id,
          name: `Layer ${layers.length + 1}`,
          visible: true,
          locked: false,
          opacity: 1,
        }),
      ]);
      setActiveLayer(id);
    });
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="panel-title">Layers</h4>
        <Button variant="ghost" size="sm" onClick={addLayer}>
          <Plus size={12} />
          <span className="ml-1">Add</span>
        </Button>
      </div>
      {/* Top-down: the topmost (last-drawn) layer sits at the top of the list,
          Photoshop-style, and the list never scrolls sideways. */}
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
        {items
          .map((l, i) => ({ l, i }))
          .reverse()
          .map(({ l, i }) => (
            <LayerRow key={l.id} layer={l} index={i} active={l.id === activeLayerId} />
          ))}
      </ul>
    </div>
  );
}

function LayerRow({ layer, index, active }: { layer: Layer; index: number; active: boolean }) {
  const room = useRoom();
  const setActiveLayer = useLayersStore((s) => s.setActiveLayer);
  const yMap = room.slate.layers().get(index);
  if (!yMap) return null;

  const set = <K extends keyof Layer>(key: K, value: Layer[K]) => {
    yMap.set(key as string, value);
  };

  const remove = () => {
    room.slate.doc.transact(() => room.slate.layers().delete(index, 1));
  };

  return (
    <li
      onClick={() => setActiveLayer(layer.id)}
      className={
        'group flex flex-col gap-1 rounded-sm px-2 py-1.5 cursor-pointer border ' +
        (active ? 'bg-bg-4 border-accent/40' : 'bg-bg-3 border-transparent hover:bg-bg-4')
      }
    >
      {/* Row 1: visibility · lock · name · delete — all fit, no side-scroll. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
          onClick={(e) => {
            e.stopPropagation();
            set('visible', !layer.visible);
          }}
          className="shrink-0 text-text-mid hover:text-text"
        >
          {layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button
          type="button"
          aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'}
          onClick={(e) => {
            e.stopPropagation();
            set('locked', !layer.locked);
          }}
          className="shrink-0 text-text-mid hover:text-text"
        >
          {layer.locked ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
        <input
          value={layer.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => set('name', e.target.value.slice(0, 80) || 'Untitled')}
          className="min-w-0 flex-1 rounded-sm border-0 bg-transparent px-1 text-sm outline-none focus:bg-bg-3"
        />
        <button
          type="button"
          aria-label={`Delete ${layer.name}`}
          onClick={(e) => {
            e.stopPropagation();
            remove();
          }}
          className="shrink-0 rounded-sm p-0.5 text-text-dim hover:bg-bg-2 hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {/* Row 2: opacity, full-width so it's always reachable. */}
      <div className="flex items-center gap-1.5 pl-[1.6rem] pr-1">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={layer.opacity}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => set('opacity', Number(e.target.value))}
          className="min-w-0 flex-1 accent-accent"
          aria-label="Layer opacity"
        />
        <span className="w-7 shrink-0 text-right font-mono text-[10px] text-text-dim">
          {Math.round(layer.opacity * 100)}
        </span>
      </div>
    </li>
  );
}

function yLayer(l: Layer): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  Object.entries(l).forEach(([k, v]) => m.set(k, v));
  return m;
}

function readLayers(layers: Y.Array<Y.Map<unknown>>): Layer[] {
  const out: Layer[] = [];
  layers.forEach((m) => {
    const candidate = {
      id: m.get('id'),
      name: m.get('name'),
      visible: m.get('visible'),
      locked: m.get('locked'),
      opacity: m.get('opacity'),
    };
    const parsed = layerSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  });
  return out;
}
