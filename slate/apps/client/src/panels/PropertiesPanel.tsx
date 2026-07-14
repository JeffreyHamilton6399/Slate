/**
 * PropertiesPanel — the real N-panel that v1 left as a placeholder.
 *
 * Shows transform editors, dimensions, smooth/flat shading, color, PBR
 * material editor (metalness/roughness/opacity), mirror toggle. Bound to
 * the single primary selected object; multi-select edits the first.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { Diamond } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { makeId } from '../utils/id';
import { useBoardUnits } from '../sync/useBoardSettings';
import { autoKeyframe, editObjectLight, editObjectMaterial, resetTransform } from '../viewport3d/scene';
import { useScene3DStore } from '../viewport3d/store';
import { sampleAnim } from '../viewport3d/animation';
import { metersToUnit, unitToMeters, unitDecimals, formatLength, type LengthUnit } from '../viewport3d/units';
import { FieldLabel, Input } from '../ui/Input';
import { Button } from '../ui/Button';
import {
  type LightData,
  type Material,
  type MaterialTexture,
  type Object3D,
  type Transform,
  type Vec3,
  materialSchema,
  object3DSchema,
} from '@slate/sync-protocol';

export function PropertiesPanel() {
  const room = useRoom();
  const selection = useScene3DStore((s) => s.selection);
  const [units] = useBoardUnits(room);
  const objects = useMemo(() => room.slate.scene3dObjects(), [room]);
  const meshes = useMemo(() => room.slate.scene3dMeshes(), [room]);
  const materials = useMemo(() => room.slate.scene3dMaterials(), [room]);
  const assets = useMemo(() => room.slate.assets(), [room]);
  const selectedAssetId = useScene3DStore((s) => s.selectedAssetId);
  const animTime = useScene3DStore((s) => s.animTime);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    objects.observeDeep(bump);
    meshes.observeDeep(bump);
    materials.observeDeep(bump);
    assets.observeDeep(bump);
    return () => {
      objects.unobserveDeep(bump);
      meshes.unobserveDeep(bump);
      materials.unobserveDeep(bump);
      assets.unobserveDeep(bump);
    };
  }, [objects, meshes, materials, assets]);

  void version;

  // A material asset picked in the Assets panel edits here (Blender-like).
  const assetEntry = selectedAssetId ? assets.get(selectedAssetId) : undefined;
  if (assetEntry && assetEntry.get('kind') === 'material') {
    return <MaterialAssetEditor entry={assetEntry} />;
  }

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

  const docObj = readObject(yObj, primaryId);
  if (!docObj) return null;
  // When the playhead is scrubbing an animated object, show the sampled
  // keyframe pose in the transform fields (like Blender's N-panel) so the
  // numbers track the animation. Editing still writes the base transform.
  const sampled = sampleAnim(docObj.anim, animTime);
  const obj = sampled ? { ...docObj, transform: sampled } : docObj;

  const yMat = obj.materialId ? materials.get(obj.materialId) : undefined;
  const mat = yMat ? readMaterial(yMat, obj.materialId!) : undefined;

  // Library materials, offered in the Assign dropdown (Blender's material list).
  const materialAssets: { id: string; name: string; material: Material }[] = [];
  assets.forEach((m, id) => {
    if (m.get('kind') === 'material' && m.get('material')) {
      materialAssets.push({
        id,
        name: (m.get('name') as string) ?? 'Material',
        material: m.get('material') as Material,
      });
    }
  });

  const setName = (v: string) => yObj.set('name', v.slice(0, 80) || 'Object');

  // Bounding-box size for the read-only Dimensions readout (shows the
  // object's real-world size in the current unit so CAD measurements are
  // always visible, like Blender's N-panel).
  const meshSize = (() => {
    if (!obj.meshId) return null;
    const verts = meshes.get(obj.meshId)?.get('vertices') as number[] | undefined;
    if (!verts || verts.length < 3) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      const x = verts[i]!, y = verts[i + 1]!, z = verts[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    return { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  })();

  const setTransform = (path: 'position' | 'rotation' | 'scale', axis: keyof Vec3, value: number) => {
    const t: Transform = {
      ...obj.transform,
      [path]: { ...obj.transform[path], [axis]: value },
    };
    yObj.set('transform', t);
    // Auto-key an already-animated object so the edit is recorded at the
    // playhead instead of being masked by the sampled pose on the next scrub.
    autoKeyframe(room.slate, [obj.id], animTime);
  };

  // Copy-on-write: forks a shared material so recoloring one object never
  // recolors the others that happen to share the default material.
  const setMatField = <K extends keyof Material>(key: K, value: Material[K]) => {
    editObjectMaterial(room.slate, obj.id, { [key]: value } as Partial<Material>);
  };

  const setLightField = <K extends keyof LightData>(key: K, value: LightData[K]) => {
    editObjectLight(room.slate, obj.id, { [key]: value } as Partial<LightData>);
  };

  return (
    <div className="flex flex-col gap-2 text-sm">
      <Section title="Object">
        <Row label="Name">
          <Input value={obj.name} onChange={(e) => setName(e.target.value)} />
        </Row>
        {/* Smooth/flat shading is controlled from the top toolbar (Blender-style). */}
      </Section>

      <Section
        title="Transform"
        badge={
          obj.anim && obj.anim.length > 0 ? (
            // Blender-style channel state: filled yellow diamond when the
            // playhead sits ON a key, green-ish outline when just animated.
            <Diamond
              size={10}
              className={
                obj.anim.some((k) => Math.abs(k.t - animTime) < 0.02)
                  ? 'fill-warn text-warn'
                  : 'text-green'
              }
            />
          ) : undefined
        }
      >
        {/* Lengths display in the user's units (Settings); 1 world unit = 1 m. */}
        <Vec3Row
          label={`Location (${units})`}
          decimals={unitDecimals(units)}
          v={{
            x: metersToUnit(obj.transform.position.x, units),
            y: metersToUnit(obj.transform.position.y, units),
            z: metersToUnit(obj.transform.position.z, units),
          }}
          onChange={(a, x) => setTransform('position', a, unitToMeters(x, units))}
        />
        <Vec3Row
          label="Rotation (°)"
          v={{
            x: rad2deg(obj.transform.rotation.x),
            y: rad2deg(obj.transform.rotation.y),
            z: rad2deg(obj.transform.rotation.z),
          }}
          onChange={(a, x) => setTransform('rotation', a, deg2rad(x))}
        />
        <Vec3Row label="Scale" v={obj.transform.scale} onChange={(a, x) => setTransform('scale', a, x)} />
        {/* Read-only real-world dimensions readout (CAD measurements visible
            at a glance, like Blender's N-panel). Shows the bounding-box size
            in the current unit, including feet+inches for ft. */}
        {meshSize && (
          <Row label={`Size (${units})`}>
            <span className="font-mono text-xs text-text-mid">
              {formatLength(meshSize.x * Math.abs(obj.transform.scale.x), units)} ×{' '}
              {formatLength(meshSize.y * Math.abs(obj.transform.scale.y), units)} ×{' '}
              {formatLength(meshSize.z * Math.abs(obj.transform.scale.z), units)}
            </span>
          </Row>
        )}
        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetTransform(room.slate, selection)}
            className="w-full justify-center"
          >
            Reset Transform
          </Button>
        </div>
      </Section>

      {obj.type === 'light' && (
        <Section title={`Light — ${obj.light?.kind ?? 'point'}`}>
          <Row label="Color">
            <input
              type="color"
              value={obj.light?.color ?? '#ffffff'}
              onChange={(e) => setLightField('color', e.target.value)}
              className="h-7 w-full rounded-sm bg-transparent border border-border"
            />
          </Row>
          <Row label="Intensity">
            <SliderNumber
              value={obj.light?.intensity ?? 25}
              min={0}
              max={
                obj.light?.kind === 'sun'
                  ? 10
                  : obj.light?.kind === 'hemisphere'
                    ? 5
                    : 50
              }
              step={0.1}
              onChange={(v) => setLightField('intensity', v)}
            />
          </Row>
          {/* Distance only meaningful for the falloff lights. */}
          {(obj.light?.kind === 'point' || obj.light?.kind === 'spot') && (
            <Row label="Distance">
              <SliderNumber
                value={obj.light?.distance ?? 0}
                min={0}
                max={50}
                step={0.5}
                onChange={(v) => setLightField('distance', v)}
              />
            </Row>
          )}
          {obj.light?.kind === 'spot' && (
            <Row label="Angle">
              <SliderNumber
                value={rad2deg(obj.light?.angle ?? Math.PI / 6)}
                min={1}
                max={89}
                step={1}
                onChange={(v) => setLightField('angle', deg2rad(v))}
              />
            </Row>
          )}
          {obj.light?.kind === 'area' && (
            <Row label="Size">
              <SliderNumber
                value={obj.light?.angle ?? 1}
                min={0.1}
                max={1.5}
                step={0.05}
                onChange={(v) => setLightField('angle', v)}
              />
            </Row>
          )}
        </Section>
      )}

      {obj.type === 'camera' && (
        <Section title="Camera">
          <Row label="FOV (°)">
            <SliderNumber
              value={obj.camera?.fov ?? 50}
              min={10}
              max={120}
              step={1}
              onChange={(v) => yObj.set('camera', { ...(obj.camera ?? { fov: 50 }), fov: v })}
            />
          </Row>
          <p className="text-[11px] text-text-dim">
            Numpad 0 looks through this camera; the render button saves the view as PNG.
          </p>
        </Section>
      )}

      {obj.meshId && (
        <Section title="Material">
          {materialAssets.length > 0 && (
            <Row label="Assign">
              <select
                value=""
                onChange={(e) => {
                  const asset = materialAssets.find((a) => a.id === e.target.value);
                  if (!asset) return;
                  const matId = makeId('mat');
                  room.slate.doc.transact(() => {
                    const nm = new Y.Map<unknown>();
                    for (const [k, v] of Object.entries({ ...asset.material, id: matId })) nm.set(k, v);
                    materials.set(matId, nm);
                    for (const id of selection) {
                      const target = objects.get(id);
                      if (target && target.get('meshId')) target.set('materialId', matId);
                    }
                  });
                }}
                className="w-full rounded-sm border border-border bg-bg-4 px-1.5 py-1 text-sm outline-none focus:border-accent"
              >
                <option value="">From assets…</option>
                {materialAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
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
          <Row label="Emissive">
            <input
              type="color"
              value={mat?.emissive ?? '#000000'}
              onChange={(e) => setMatField('emissive', e.target.value)}
              className="h-7 w-full rounded-sm bg-transparent border border-border"
            />
          </Row>
          <Row label="Glow">
            <SliderNumber
              value={mat?.emissiveIntensity ?? 0}
              min={0}
              max={5}
              step={0.1}
              onChange={(v) => setMatField('emissiveIntensity', v)}
            />
          </Row>
        </Section>
      )}

      {obj.meshId && (
        <Section title="Texture">
          <Row label="Pattern">
            <select
              value={mat?.texture?.kind ?? 'none'}
              onChange={(e) =>
                setMatField('texture', {
                  kind: e.target.value as MaterialTexture['kind'],
                  scale: mat?.texture?.scale ?? 2,
                  color2: mat?.texture?.color2 ?? '#1e1e26',
                  src: e.target.value === 'image' ? mat?.texture?.src : undefined,
                })
              }
              className="w-full rounded-sm border border-border bg-bg-4 px-1.5 py-1 text-sm outline-none focus:border-accent"
            >
              {(['none', 'checker', 'grid', 'dots', 'stripes', 'bricks', 'waves', 'noise', 'image'] as const).map((k) => (
                <option key={k} value={k}>
                  {k[0]!.toUpperCase() + k.slice(1)}
                </option>
              ))}
            </select>
          </Row>
          {/* Image texture upload — pick an image file, it's stored as a data
              URL in the material and applied as a box-projected texture. */}
          {mat?.texture?.kind === 'image' && (
            <Row label="Image">
              <div className="flex flex-col gap-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      const src = String(reader.result);
                      setMatField('texture', { ...mat.texture!, kind: 'image', src });
                    };
                    reader.readAsDataURL(file);
                  }}
                  className="block w-full text-xs text-text-mid file:mr-2 file:rounded-sm file:border-0 file:bg-bg-3 file:px-2 file:py-1 file:text-text file:cursor-pointer"
                />
                {mat.texture.src && (
                  <img
                    src={mat.texture.src}
                    alt="Texture preview"
                    className="h-16 w-full rounded-sm border border-border object-cover"
                  />
                )}
              </div>
            </Row>
          )}
          {mat?.texture && mat.texture.kind !== 'none' && mat.texture.kind !== 'image' && (
            <>
              <Row label="Color">
                <input
                  type="color"
                  value={mat.texture.color2}
                  onChange={(e) => setMatField('texture', { ...mat.texture!, color2: e.target.value })}
                  className="h-7 w-full rounded-sm bg-transparent border border-border"
                />
              </Row>
              <Row label="Scale">
                <SliderNumber
                  value={mat.texture.scale}
                  min={0.5}
                  max={16}
                  step={0.5}
                  onChange={(v) => setMatField('texture', { ...mat.texture!, scale: v })}
                />
              </Row>
            </>
          )}
          {mat?.texture?.kind === 'image' && mat.texture.src && (
            <Row label="Scale">
              <SliderNumber
                value={mat.texture.scale}
                min={0.5}
                max={16}
                step={0.5}
                onChange={(v) => setMatField('texture', { ...mat.texture!, scale: v })}
              />
            </Row>
          )}
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

/** Edits a material ASSET in place (picked in the Assets panel). */
function MaterialAssetEditor({ entry }: { entry: Y.Map<unknown> }) {
  const name = (entry.get('name') as string) ?? 'Material';
  const mat = (entry.get('material') as Material | undefined) ?? null;
  if (!mat) return null;
  const set = <K extends keyof Material>(key: K, value: Material[K]) => {
    entry.set('material', { ...mat, [key]: value });
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <Section title={`Material asset — ${name}`}>
        <Row label="Color">
          <input
            type="color"
            value={mat.color}
            onChange={(e) => set('color', e.target.value)}
            className="h-7 w-full rounded-sm bg-transparent border border-border"
          />
        </Row>
        <Row label="Metalness">
          <SliderNumber value={mat.metalness} min={0} max={1} step={0.05} onChange={(v) => set('metalness', v)} />
        </Row>
        <Row label="Roughness">
          <SliderNumber value={mat.roughness} min={0} max={1} step={0.05} onChange={(v) => set('roughness', v)} />
        </Row>
        <Row label="Opacity">
          <SliderNumber value={mat.opacity} min={0} max={1} step={0.05} onChange={(v) => set('opacity', v)} />
        </Row>
        <Row label="Emissive">
          <input
            type="color"
            value={mat.emissive}
            onChange={(e) => set('emissive', e.target.value)}
            className="h-7 w-full rounded-sm bg-transparent border border-border"
          />
        </Row>
        <Row label="Glow">
          <SliderNumber value={mat.emissiveIntensity} min={0} max={5} step={0.1} onChange={(v) => set('emissiveIntensity', v)} />
        </Row>
      </Section>
      <Section title="Texture">
        <Row label="Pattern">
          <select
            value={mat.texture?.kind ?? 'none'}
            onChange={(e) =>
              set('texture', {
                kind: e.target.value as MaterialTexture['kind'],
                scale: mat.texture?.scale ?? 2,
                color2: mat.texture?.color2 ?? '#1e1e26',
              })
            }
            className="w-full rounded-sm border border-border bg-bg-4 px-1.5 py-1 text-sm outline-none focus:border-accent"
          >
            {(['none', 'checker', 'grid', 'dots', 'stripes', 'bricks', 'waves', 'noise'] as const).map((k) => (
              <option key={k} value={k}>
                {k[0]!.toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </Row>
        {mat.texture && mat.texture.kind !== 'none' && (
          <>
            <Row label="Color">
              <input
                type="color"
                value={mat.texture.color2}
                onChange={(e) => set('texture', { ...mat.texture!, color2: e.target.value })}
                className="h-7 w-full rounded-sm bg-transparent border border-border"
              />
            </Row>
            <Row label="Scale">
              <SliderNumber
                value={mat.texture.scale}
                min={0.5}
                max={16}
                step={0.5}
                onChange={(v) => set('texture', { ...mat.texture!, scale: v })}
              />
            </Row>
          </>
        )}
      </Section>
      <p className="text-[11px] text-text-dim">
        Editing the library asset. Double-click it in Assets (or use the Assign dropdown on an
        object) to put it on something — already-assigned copies keep their look.
      </p>
    </div>
  );
}

function Section({
  title,
  children,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <div className="rounded-sm bg-bg-3 p-1.5 border border-border">
      <h5 className="panel-title mb-1.5 flex items-center gap-1.5">
        {title}
        {badge}
      </h5>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  // Compact: labels wrap onto their own line in a narrow dock.
  return (
    <div className="grid grid-cols-[minmax(56px,72px)_1fr] items-center gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Vec3Row({
  label,
  v,
  onChange,
  decimals,
}: {
  label: string;
  v: Vec3;
  onChange: (axis: keyof Vec3, value: number) => void;
  decimals?: number;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((a) => (
          <NumberInput
            key={a}
            value={v[a]}
            onChange={(x) => onChange(a, x)}
            label={a.toUpperCase()}
            decimals={decimals}
          />
        ))}
      </div>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  label,
  decimals = 3,
}: {
  value: number;
  onChange: (n: number) => void;
  label?: string;
  decimals?: number;
}) {
  const [draft, setDraft] = useState(value.toFixed(decimals));
  useEffect(() => {
    setDraft(value.toFixed(decimals));
  }, [value, decimals]);
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
          else setDraft(value.toFixed(decimals));
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
    light: yMap.get('light'),
    camera: yMap.get('camera'),
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
    texture: yMap.get('texture'),
  };
  const parsed = materialSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

void Button;
