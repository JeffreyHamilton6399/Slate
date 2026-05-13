/**
 * PropertiesPanel — the real N-panel that v1 left as a placeholder.
 *
 * Shows transform editors, dimensions, smooth/flat shading, color, PBR
 * material editor (metalness/roughness/opacity), mirror toggle. Bound to
 * the single primary selected object; multi-select edits the first.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { useRoom } from '../sync/RoomContext';
import { useScene3DStore } from '../viewport3d/store';
import { FieldLabel, Input } from '../ui/Input';
import { Button } from '../ui/Button';
import {
  type Material,
  type Object3D,
  type Transform,
  type Vec3,
  materialSchema,
  object3DSchema,
} from '@slate/sync-protocol';

export function PropertiesPanel() {
  const room = useRoom();
  const selection = useScene3DStore((s) => s.selection);
  const objects = useMemo(() => room.slate.scene3dObjects(), [room]);
  const materials = useMemo(() => room.slate.scene3dMaterials(), [room]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    objects.observeDeep(bump);
    materials.observeDeep(bump);
    return () => {
      objects.unobserveDeep(bump);
      materials.unobserveDeep(bump);
    };
  }, [objects, materials]);

  void version;

  if (selection.length === 0) {
    return (
      <div className="grid h-full place-items-center text-xs text-text-dim text-center">
        <span>Select an object to edit its properties.</span>
      </div>
    );
  }

  const primaryId = selection[0]!;
  const yObj = objects.get(primaryId);
  if (!yObj) return null;

  const obj = readObject(yObj, primaryId);
  if (!obj) return null;

  const yMat = obj.materialId ? materials.get(obj.materialId) : undefined;
  const mat = yMat ? readMaterial(yMat, obj.materialId!) : undefined;

  const setName = (v: string) => yObj.set('name', v.slice(0, 80) || 'Object');
  const setVisible = (v: boolean) => yObj.set('visible', v);
  const setSmooth = (v: boolean) => yObj.set('smooth', v);

  const setTransform = (path: 'position' | 'rotation' | 'scale', axis: keyof Vec3, value: number) => {
    const t: Transform = {
      ...obj.transform,
      [path]: { ...obj.transform[path], [axis]: value },
    };
    yObj.set('transform', t);
  };

  const ensureMaterial = (): Y.Map<unknown> => {
    if (yMat) return yMat;
    const id = `mat_${obj.id}`;
    const nm = new Y.Map<unknown>();
    nm.set('id', id);
    nm.set('kind', 'pbr');
    nm.set('color', '#7c6aff');
    nm.set('metalness', 0);
    nm.set('roughness', 0.5);
    nm.set('emissive', '#000000');
    nm.set('emissiveIntensity', 0);
    nm.set('opacity', 1);
    materials.set(id, nm);
    yObj.set('materialId', id);
    return nm;
  };

  const setMatField = <K extends keyof Material>(key: K, value: Material[K]) => {
    const m = ensureMaterial();
    m.set(key as string, value);
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <Section title="Object">
        <Row label="Name">
          <Input value={obj.name} onChange={(e) => setName(e.target.value)} />
        </Row>
        <Row label="Visible">
          <input
            type="checkbox"
            checked={obj.visible}
            onChange={(e) => setVisible(e.target.checked)}
            className="accent-accent"
          />
        </Row>
        <Row label="Smooth shading">
          <input
            type="checkbox"
            checked={Boolean(obj.smooth)}
            onChange={(e) => setSmooth(e.target.checked)}
            className="accent-accent"
          />
        </Row>
      </Section>

      <Section title="Transform">
        <Vec3Row label="Location" v={obj.transform.position} onChange={(a, x) => setTransform('position', a, x)} />
        <Vec3Row
          label="Rotation"
          v={{
            x: rad2deg(obj.transform.rotation.x),
            y: rad2deg(obj.transform.rotation.y),
            z: rad2deg(obj.transform.rotation.z),
          }}
          onChange={(a, x) => setTransform('rotation', a, deg2rad(x))}
        />
        <Vec3Row label="Scale" v={obj.transform.scale} onChange={(a, x) => setTransform('scale', a, x)} />
      </Section>

      {obj.type !== 'folder' && obj.type !== 'empty' && (
        <Section title="Material">
          <Row label="Color">
            <input
              type="color"
              value={mat?.color ?? '#7c6aff'}
              onChange={(e) => setMatField('color', e.target.value)}
              className="h-7 w-full rounded-sm bg-transparent border border-border"
            />
          </Row>
          <Row label="Metalness">
            <SliderNumber
              value={mat?.metalness ?? 0}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => setMatField('metalness', v)}
            />
          </Row>
          <Row label="Roughness">
            <SliderNumber
              value={mat?.roughness ?? 0.5}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => setMatField('roughness', v)}
            />
          </Row>
          <Row label="Opacity">
            <SliderNumber
              value={mat?.opacity ?? 1}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => setMatField('opacity', v)}
            />
          </Row>
        </Section>
      )}

      {selection.length > 1 && (
        <p className="text-xs text-text-dim">
          {selection.length} objects selected. Edits apply to first; multi-edit lands in a later phase.
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-sm bg-bg-3 p-2 border border-border">
      <h5 className="panel-title mb-2">{title}</h5>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-center gap-2">
      <FieldLabel>{label}</FieldLabel>
      <div>{children}</div>
    </div>
  );
}

function Vec3Row({
  label,
  v,
  onChange,
}: {
  label: string;
  v: Vec3;
  onChange: (axis: keyof Vec3, value: number) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((a) => (
          <NumberInput key={a} value={v[a]} onChange={(x) => onChange(a, x)} label={a.toUpperCase()} />
        ))}
      </div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState(value.toFixed(3));
  useEffect(() => {
    setDraft(value.toFixed(3));
  }, [value]);
  return (
    <div className="relative">
      {label && (
        <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-mono uppercase text-text-dim">
          {label}
        </span>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n)) onChange(n);
          else setDraft(value.toFixed(3));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={'text-right pr-1.5 ' + (label ? 'pl-5' : '')}
      />
    </div>
  );
}

function SliderNumber({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-accent"
      />
      <span className="w-10 text-right text-xs font-mono text-text-mid">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function rad2deg(r: number): number {
  return r * (180 / Math.PI);
}
function deg2rad(d: number): number {
  return d * (Math.PI / 180);
}

function readObject(yMap: Y.Map<unknown>, id: string): Object3D | null {
  const candidate = {
    id: yMap.get('id') ?? id,
    parentId: yMap.get('parentId') ?? null,
    type: yMap.get('type'),
    name: yMap.get('name'),
    visible: yMap.get('visible'),
    transform: yMap.get('transform'),
    meshId: yMap.get('meshId') ?? null,
    materialId: yMap.get('materialId') ?? null,
    collapsed: yMap.get('collapsed'),
    smooth: yMap.get('smooth'),
  };
  const parsed = object3DSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function readMaterial(yMap: Y.Map<unknown>, id: string): Material | null {
  const candidate = {
    id: yMap.get('id') ?? id,
    kind: yMap.get('kind') ?? 'pbr',
    color: yMap.get('color'),
    metalness: yMap.get('metalness'),
    roughness: yMap.get('roughness'),
    emissive: yMap.get('emissive') ?? '#000000',
    emissiveIntensity: yMap.get('emissiveIntensity') ?? 0,
    opacity: yMap.get('opacity'),
  };
  const parsed = materialSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

void Button;
