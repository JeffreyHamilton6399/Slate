/**
 * HierarchyPanel — outliner-style scene tree for the 3D viewport.
 *
 * Phase 3 ships read-only rendering + select + visibility toggle + rename
 * + delete + new-folder. Phase 5 wires drag-reparent + multi-select.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Plus,
  Trash2,
} from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { Button } from '../ui/Button';
import { useScene3DStore } from '../viewport3d/store';
import { makeId } from '../utils/id';
import { object3DSchema, type Object3D } from '@slate/sync-protocol';

export function HierarchyPanel() {
  const room = useRoom();
  const objects = useMemo(() => room.slate.scene3dObjects(), [room]);
  const [tree, setTree] = useState<TreeNode[]>(() => buildTree(objects));
  const selection = useScene3DStore((s) => s.selection);
  const setSelection = useScene3DStore((s) => s.setSelection);

  useEffect(() => {
    const update = () => setTree(buildTree(objects));
    objects.observeDeep(update);
    return () => objects.unobserveDeep(update);
  }, [objects]);

  const addFolder = () => {
    room.slate.doc.transact(() => {
      const id = makeId('folder');
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('parentId', null);
      m.set('type', 'folder');
      m.set('name', 'Folder');
      m.set('visible', true);
      m.set('transform', {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });
      m.set('meshId', null);
      m.set('materialId', null);
      m.set('collapsed', false);
      objects.set(id, m);
    });
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="panel-title">Scene</h4>
        <Button variant="ghost" size="sm" onClick={addFolder}>
          <Plus size={12} />
          <span className="ml-1">Folder</span>
        </Button>
      </div>
      <ul className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {tree.length === 0 && (
          <li className="text-xs text-text-dim text-center pt-4">
            Empty scene. Add primitives from the 3D toolbar.
          </li>
        )}
        {tree.map((n) => (
          <HierarchyNode
            key={n.id}
            node={n}
            depth={0}
            selection={selection}
            setSelection={setSelection}
          />
        ))}
      </ul>
    </div>
  );
}

interface TreeNode {
  id: string;
  obj: Object3D;
  children: TreeNode[];
}

function HierarchyNode({
  node,
  depth,
  selection,
  setSelection,
}: {
  node: TreeNode;
  depth: number;
  selection: string[];
  setSelection: (ids: string[]) => void;
}) {
  const room = useRoom();
  const [collapsed, setCollapsed] = useState(!!node.obj.collapsed);
  const isFolder = node.obj.type === 'folder';
  const selected = selection.includes(node.id);

  const yObj = room.slate.scene3dObjects().get(node.id);

  return (
    <li>
      <div
        className={
          'group flex items-center gap-1 rounded-sm px-1.5 py-1 text-sm cursor-pointer border border-transparent ' +
          (selected ? 'bg-bg-4 border-accent/40 text-text' : 'hover:bg-bg-3 text-text-mid')
        }
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={(e) => {
          if (e.shiftKey) {
            setSelection(selection.includes(node.id) ? selection.filter((x) => x !== node.id) : [...selection, node.id]);
          } else {
            setSelection([node.id]);
          }
        }}
      >
        {isFolder ? (
          <button
            type="button"
            aria-label="Toggle folder"
            onClick={(e) => {
              e.stopPropagation();
              const next = !collapsed;
              setCollapsed(next);
              yObj?.set('collapsed', next);
            }}
            className="text-text-dim hover:text-text"
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : (
          <span className="inline-block w-3" />
        )}
        {isFolder ? (
          collapsed ? (
            <Folder size={12} className="text-text-mid" />
          ) : (
            <FolderOpen size={12} className="text-accent" />
          )
        ) : (
          <Box size={12} className="text-accent" />
        )}
        <input
          value={node.obj.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => yObj?.set('name', e.target.value.slice(0, 80) || 'Object')}
          className="flex-1 bg-transparent border-0 outline-none text-sm focus:bg-bg-4 rounded-sm px-1"
        />
        <button
          type="button"
          aria-label={node.obj.visible ? 'Hide' : 'Show'}
          onClick={(e) => {
            e.stopPropagation();
            yObj?.set('visible', !node.obj.visible);
          }}
          className="text-text-mid hover:text-text"
        >
          {node.obj.visible ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
        <button
          type="button"
          aria-label="Delete"
          onClick={(e) => {
            e.stopPropagation();
            room.slate.doc.transact(() => removeWithChildren(room.slate.scene3dObjects(), node.id));
          }}
          className="text-text-dim hover:text-danger opacity-0 group-hover:opacity-100"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {isFolder && !collapsed && node.children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((c) => (
            <HierarchyNode
              key={c.id}
              node={c}
              depth={depth + 1}
              selection={selection}
              setSelection={setSelection}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function buildTree(objects: Y.Map<Y.Map<unknown>>): TreeNode[] {
  const all = new Map<string, Object3D>();
  objects.forEach((m, id) => {
    const candidate = {
      id: m.get('id') ?? id,
      parentId: m.get('parentId') ?? null,
      type: m.get('type'),
      name: m.get('name'),
      visible: m.get('visible'),
      transform: m.get('transform'),
      meshId: m.get('meshId') ?? null,
      materialId: m.get('materialId') ?? null,
      collapsed: m.get('collapsed'),
      smooth: m.get('smooth'),
    };
    const parsed = object3DSchema.safeParse(candidate);
    if (parsed.success) all.set(parsed.data.id, parsed.data);
  });
  const byParent = new Map<string | null, Object3D[]>();
  for (const obj of all.values()) {
    const pid = obj.parentId;
    const bucket = byParent.get(pid) ?? [];
    bucket.push(obj);
    byParent.set(pid, bucket);
  }
  const make = (parent: string | null): TreeNode[] => {
    const list = byParent.get(parent) ?? [];
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list.map((obj) => ({
      id: obj.id,
      obj,
      children: make(obj.id),
    }));
  };
  return make(null);
}

function removeWithChildren(objects: Y.Map<Y.Map<unknown>>, rootId: string): void {
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    objects.forEach((m, childId) => {
      if (m.get('parentId') === id) queue.push(childId);
    });
    objects.delete(id);
  }
}
