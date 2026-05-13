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

  // Ensure at least one layer exists.
  useEffect(() => {
    if (layers.length === 0) {
      room.slate.doc.transact(() => {
        layers.push([yLayer({ id: makeId('layer'), name: 'Layer 1', visible: true, locked: false, opacity: 1 })]);
      });
    }
  }, [layers, room]);

  // Default active to top layer if unset / stale.
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
      <ul className="flex-1 overflow-y-auto flex flex-col-reverse gap-0.5">
        {items.map((l, i) => (
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
        'group flex items-center gap-1.5 rounded-sm px-2 py-1.5 cursor-pointer border ' +
        (active ? 'bg-bg-4 border-accent/40' : 'bg-bg-3 border-transparent hover:bg-bg-4')
      }
    >
      <button
        type="button"
        aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
        onClick={(e) => {
          e.stopPropagation();
          set('visible', !layer.visible);
        }}
        className="text-text-mid hover:text-text"
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
        className="text-text-mid hover:text-text"
      >
        {layer.locked ? <Lock size={12} /> : <LockOpen size={12} />}
      </button>
      <input
        value={layer.name}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => set('name', e.target.value.slice(0, 80) || 'Untitled')}
        className="flex-1 bg-transparent border-0 outline-none text-sm focus:bg-bg-3 rounded-sm px-1"
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={layer.opacity}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => set('opacity', Number(e.target.value))}
        className="w-12 accent-accent"
        aria-label="Layer opacity"
      />
      <button
        type="button"
        aria-label="Delete layer"
        onClick={(e) => {
          e.stopPropagation();
          remove();
        }}
        className="text-text-dim hover:text-danger opacity-0 group-hover:opacity-100"
      >
        <Trash2 size={12} />
      </button>
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
