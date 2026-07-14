/**
 * AssetsPanel — a curated, Google-Drive-style library for the board.
 *
 * Nothing lands here automatically: you explicitly save a selected object's
 * mesh, create materials, and organize into folders. Right-click empty space
 * for New folder / New material / Save selection; right-click an item for
 * Use / Rename / Delete. Double-click opens folders, instances meshes, and
 * applies materials to the selection. The library lives in the board doc, so
 * collaborators share it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { Box, ChevronRight, Folder, Home, Palette } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { useScene3DStore } from '../viewport3d/store';
import { defaultMaterial, readMesh, readObject } from '../viewport3d/scene';
import { parseModel } from '../files/import3d';
import { makeId } from '../utils/id';
import { toast } from '../ui/Toast';
import { cn } from '../utils/cn';
import type { Material, MeshData, Object3D } from '@slate/sync-protocol';

const MODEL_RE = /\.(obj|stl|ply|gltf|glb|fbx)$/i;

interface AssetItem {
  id: string;
  kind: 'folder' | 'mesh' | 'material';
  name: string;
  parentId: string | null;
  mesh?: { vertices: number[]; faces: { v: number[] }[] };
  material?: Material;
}

interface MenuState {
  x: number;
  y: number;
  targetId: string | null;
}

export function AssetsPanel() {
  const room = useRoom();
  const assets = useMemo(() => room.slate.assets(), [room]);
  const [version, setVersion] = useState(0);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const selection = useScene3DStore((s) => s.selection);
  const setSelection = useScene3DStore((s) => s.setSelection);
  const selectedAssetId = useScene3DStore((s) => s.selectedAssetId);
  const setSelectedAsset = useScene3DStore((s) => s.setSelectedAsset);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    assets.observeDeep(bump);
    return () => assets.unobserveDeep(bump);
  }, [assets]);
  void version;

  const items: AssetItem[] = [];
  assets.forEach((m, id) => {
    const kind = m.get('kind');
    if (kind !== 'folder' && kind !== 'mesh' && kind !== 'material') return;
    items.push({
      id,
      kind,
      name: (m.get('name') as string) ?? 'Untitled',
      parentId: (m.get('parentId') as string | null) ?? null,
      mesh: m.get('mesh') as AssetItem['mesh'],
      material: m.get('material') as Material | undefined,
    });
  });
  const here = items
    .filter((i) => i.parentId === folderId)
    .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name));
  const currentFolder = items.find((i) => i.id === folderId);

  const put = (item: AssetItem) => {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(item)) if (v !== undefined) m.set(k, v);
    assets.set(item.id, m);
  };

  // ── Creation ──────────────────────────────────────────────────────────────
  const newFolder = () => {
    const id = makeId('asset');
    put({ id, kind: 'folder', name: 'New folder', parentId: folderId });
    setRenaming(id);
  };
  const newMaterial = () => {
    const id = makeId('asset');
    put({ id, kind: 'material', name: 'New material', parentId: folderId, material: defaultMaterial() });
    setRenaming(id);
  };
  const saveSelection = () => {
    const objId = selection[0];
    const yo = objId ? room.slate.scene3dObjects().get(objId) : undefined;
    const obj = yo ? readObject(yo, objId!) : null;
    if (!obj) {
      toast({ title: 'Select an object first', description: 'Its mesh and material get saved here.' });
      return;
    }
    room.slate.doc.transact(() => {
      if (obj.meshId) {
        const ym = room.slate.scene3dMeshes().get(obj.meshId);
        const mesh = ym ? readMesh(ym, obj.meshId) : null;
        if (mesh) {
          put({
            id: makeId('asset'),
            kind: 'mesh',
            name: obj.name,
            parentId: folderId,
            mesh: { vertices: mesh.vertices.slice(), faces: mesh.faces.map((f) => ({ v: f.v.slice() })) },
          });
        }
      }
    });
    toast({ title: `Saved “${obj.name}” to assets` });
  };

  // Drag-and-drop 3D model files → parse and add each mesh to this folder as a
  // reusable asset (double-click later to instance it into the scene).
  const importFiles = async (files: File[]) => {
    const models = files.filter((f) => MODEL_RE.test(f.name));
    if (models.length === 0) {
      toast({ title: 'Unsupported file', description: 'Drop .obj / .stl / .ply / .gltf / .glb / .fbx here.', variant: 'error' });
      return;
    }
    setImporting(true);
    let added = 0;
    try {
      for (const file of models) {
        try {
          const meshes = await parseModel(file);
          room.slate.doc.transact(() => {
            for (const pm of meshes) {
              if (pm.vertices.length === 0) continue;
              put({
                id: makeId('asset'),
                kind: 'mesh',
                name: pm.name,
                parentId: folderId,
                mesh: { vertices: pm.vertices, faces: pm.faces },
              });
              added++;
            }
          });
        } catch (err) {
          toast({ title: `Couldn't import ${file.name}`, description: (err as Error).message, variant: 'error' });
        }
      }
    } finally {
      setImporting(false);
    }
    if (added) toast({ title: `Added ${added} model${added === 1 ? '' : 's'} to assets`, description: 'Double-click to place one in the scene.' });
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void importFiles(files);
    },
    // importFiles closes over folderId/room; recreated each render is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folderId],
  );

  // ── Item actions ──────────────────────────────────────────────────────────
  const use = (item: AssetItem) => {
    if (item.kind === 'folder') {
      setFolderId(item.id);
      return;
    }
    if (item.kind === 'mesh' && item.mesh) {
      const meshId = makeId('mesh');
      const objId = makeId('obj');
      room.slate.doc.transact(() => {
        const ym = new Y.Map<unknown>();
        ym.set('id', meshId);
        ym.set('vertices', item.mesh!.vertices.slice());
        ym.set('faces', item.mesh!.faces.map((f) => ({ v: f.v.slice() })));
        room.slate.scene3dMeshes().set(meshId, ym);
        const obj: Object3D = {
          id: objId,
          parentId: null,
          type: 'mesh',
          name: item.name,
          visible: true,
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          meshId,
          materialId: null,
        };
        const yo = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(obj)) yo.set(k, v);
        room.slate.scene3dObjects().set(objId, yo);
      });
      setSelection([objId]);
      return;
    }
    if (item.kind === 'material' && item.material) {
      if (selection.length === 0) {
        toast({ title: 'Select an object first', description: 'Materials apply to the selection.' });
        return;
      }
      const matId = makeId('mat');
      room.slate.doc.transact(() => {
        const nm = new Y.Map<unknown>();
        for (const [k, v] of Object.entries({ ...item.material!, id: matId })) nm.set(k, v);
        room.slate.scene3dMaterials().set(matId, nm);
        for (const id of selection) {
          const yo = room.slate.scene3dObjects().get(id);
          if (yo && yo.get('meshId')) yo.set('materialId', matId);
        }
      });
    }
  };

  const remove = (id: string) => {
    room.slate.doc.transact(() => {
      // Folders take their contents with them.
      const doomed = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const i of items) {
          if (!doomed.has(i.id) && i.parentId && doomed.has(i.parentId)) {
            doomed.add(i.id);
            grew = true;
          }
        }
      }
      for (const d of doomed) assets.delete(d);
    });
    if (folderId && !assets.get(folderId)) setFolderId(null);
  };

  const rename = (id: string, name: string) => {
    const m = assets.get(id);
    if (m && name.trim()) m.set('name', name.trim().slice(0, 60));
    setRenaming(null);
  };

  const openMenu = (e: React.MouseEvent, targetId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const host = (e.currentTarget as HTMLElement).closest('[data-assets-root]')!.getBoundingClientRect();
    setMenu({ x: e.clientX - host.left, y: e.clientY - host.top, targetId });
  };
  const target = menu?.targetId ? items.find((i) => i.id === menu.targetId) : null;

  return (
    <div
      data-assets-root
      className={cn(
        'relative flex h-full flex-col gap-2 text-sm',
        dragOver && 'outline-dashed outline-2 outline-accent/70',
      )}
      onContextMenu={(e) => openMenu(e, null)}
      onClick={() => setMenu(null)}
      onDragOver={(e) => {
        if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the panel entirely, not on child transitions.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {(dragOver || importing) && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-sm bg-accent/10 text-xs font-medium text-accent backdrop-blur-[1px]">
          {importing ? 'Importing…' : 'Drop 3D models to add to assets'}
        </div>
      )}
      {/* Breadcrumb (Drive-style). */}
      <div className="flex items-center gap-1 text-xs text-text-dim">
        <button
          type="button"
          onClick={() => setFolderId(null)}
          className={cn('flex items-center gap-1 rounded-sm px-1 py-0.5 hover:text-text', !folderId && 'text-text')}
        >
          <Home size={11} /> Assets
        </button>
        {currentFolder && (
          <>
            <ChevronRight size={10} />
            <span className="truncate text-text">{currentFolder.name}</span>
          </>
        )}
      </div>

      {here.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-text-dim">
          Empty — right-click for New folder, New material, or Save selection.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {here.map((item) => (
            <li key={item.id}>
              <div
                role="button"
                tabIndex={0}
                // Mesh + material assets can be dragged straight into the
                // viewport (Unity-style). We carry the id via a custom mime.
                draggable={item.kind === 'mesh' || item.kind === 'material'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-slate-asset', item.id);
                  e.dataTransfer.setData('text/plain', item.name);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(null);
                  // Click selects the asset — Properties edits materials.
                  setSelectedAsset(item.id);
                }}
                onDoubleClick={() => use(item)}
                onContextMenu={(e) => openMenu(e, item.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') use(item);
                }}
                className={cn(
                  'group flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-bg-3',
                  selectedAssetId === item.id && 'bg-accent/10 outline outline-1 outline-accent/40',
                )}
                title={
                  item.kind === 'folder'
                    ? 'Double-click to open'
                    : item.kind === 'mesh'
                      ? 'Double-click or drag into the scene'
                      : 'Double-click to apply to the selection'
                }
              >
                {item.kind === 'folder' ? (
                  <Folder size={13} className="shrink-0 text-warn" />
                ) : item.kind === 'mesh' ? (
                  <Box size={13} className="shrink-0 text-accent" />
                ) : (
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-text-dim/40"
                    style={{ backgroundColor: item.material?.color ?? '#888' }}
                  />
                )}
                {renaming === item.id ? (
                  <input
                    autoFocus
                    defaultValue={item.name}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => rename(item.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(item.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded-sm border border-accent/50 bg-bg-4 px-1 text-xs outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs text-text-mid group-hover:text-text">
                    {item.name}
                  </span>
                )}
                {item.kind === 'mesh' && (
                  <span className="font-mono text-[10px] text-text-dim">{item.mesh?.faces.length ?? 0}f</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <div
          role="menu"
          className="absolute z-30 w-44 rounded-md border border-border bg-bg-2 py-1 shadow-xl"
          style={{ left: Math.min(menu.x, 140), top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {target ? (
            <>
              <MenuBtn
                label={
                  target.kind === 'folder' ? 'Open' : target.kind === 'mesh' ? 'Add to scene' : 'Apply to selection'
                }
                onClick={() => {
                  use(target);
                  setMenu(null);
                }}
              />
              <MenuBtn
                label="Rename"
                onClick={() => {
                  setRenaming(target.id);
                  setMenu(null);
                }}
              />
              <div className="my-1 h-px bg-border" />
              <MenuBtn
                danger
                label="Delete"
                onClick={() => {
                  remove(target.id);
                  setMenu(null);
                }}
              />
            </>
          ) : (
            <>
              <MenuBtn
                label="New folder"
                Icon={Folder}
                onClick={() => {
                  newFolder();
                  setMenu(null);
                }}
              />
              <MenuBtn
                label="New material"
                Icon={Palette}
                onClick={() => {
                  newMaterial();
                  setMenu(null);
                }}
              />
              <MenuBtn
                label="Save selected object here"
                Icon={Box}
                onClick={() => {
                  saveSelection();
                  setMenu(null);
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuBtn({
  label,
  onClick,
  Icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  Icon?: typeof Box;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-bg-3',
        danger ? 'text-danger' : 'text-text-mid hover:text-text',
      )}
    >
      {Icon && <Icon size={12} className="text-text-dim" />}
      {label}
    </button>
  );
}

export type { MeshData };
