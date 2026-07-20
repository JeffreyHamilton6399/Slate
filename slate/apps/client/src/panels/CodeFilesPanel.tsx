/**
 * CodeFilesPanel — the primary file browser for 'code' boards.
 *
 * Renders the shared `code:files` Y.Map as a folder tree from path segments
 * (e.g. `src/utils/helper.ts` nests under `src/` → `utils/`), including empty
 * folders stored as explicit `kind: 'folder'` entries. Create files/folders,
 * rename, and delete here; clicking a file asks the central CodeEditor to open
 * it via the `slate:code-open-file` window event (CodeEditor owns tab/active
 * state so a file can't be "open" in two places).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, FilePlus2, FolderPlus,
  Pencil, Trash2,
} from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { listCodeFiles } from '../code/exportCode';
import {
  listCodeFolders, upsertCodeFile, createCodeFolder, renameCodeEntry,
  deleteCodeEntry, renameCodePath, deleteCodePath, normalizePath,
} from '../code/codeFiles';
import type { SlateDoc } from '../sync/doc';

/** Event detail for `slate:code-open-file`. CodeEditor listens and opens. */
export interface CodeOpenFileEvent {
  id: string;
}
export const CODE_OPEN_FILE_EVENT = 'slate:code-open-file';

/** Fire the open-file event on the window. CodeEditor listens. */
export function openCodeFile(id: string): void {
  window.dispatchEvent(new CustomEvent<CodeOpenFileEvent>(CODE_OPEN_FILE_EVENT, { detail: { id } }));
}

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  fileId?: string;
  children: TreeNode[];
}

export function CodeFilesPanel() {
  const room = useRoom();
  const [, bump] = useState(0);

  useEffect(() => {
    const files = room.slate.codeFiles();
    const fn = () => bump((v) => v + 1);
    files.observeDeep(fn);
    return () => files.unobserveDeep(fn);
  }, [room]);

  const files = listCodeFiles(room.slate);
  const folders = listCodeFolders(room.slate);
  const tree = useMemo(() => buildTree(files, folders), [files, folders]);

  const newFile = () => {
    const path = window.prompt('New file path (folders allowed, e.g. src/app.js)', 'untitled.js');
    if (!path || !normalizePath(path)) return;
    const { id } = upsertCodeFile(room.slate, path, '');
    openCodeFile(id);
  };
  const newFolder = () => {
    const path = window.prompt('New folder path (e.g. src/components)', 'new-folder');
    if (!path || !normalizePath(path)) return;
    createCodeFolder(room.slate, path);
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1">
        <h5 className="panel-title flex-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          <Folder size={11} className="mr-1 inline-block align-[-1px]" />
          Files
          <span className="ml-1 normal-case text-text-dim/70">({files.length})</span>
        </h5>
        <button
          type="button" onClick={newFile} title="New file" aria-label="New file"
          className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
        >
          <FilePlus2 size={13} />
        </button>
        <button
          type="button" onClick={newFolder} title="New folder" aria-label="New folder"
          className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
        >
          <FolderPlus size={13} />
        </button>
      </div>
      {files.length === 0 && folders.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-text-dim">
          No files yet. Use the + buttons above (or ask the AI assistant to build something).
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto pr-1">
          <TreeChildren node={tree} depth={0} slate={room.slate} />
        </div>
      )}
    </div>
  );
}

function TreeChildren({ node, depth, slate }: { node: TreeNode; depth: number; slate: SlateDoc }) {
  const sorted = [...node.children].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className="flex flex-col gap-0.5">
      {sorted.map((child) => (
        <TreeRow key={child.path} node={child} depth={depth} slate={slate} />
      ))}
    </ul>
  );
}

function TreeRow({ node, depth, slate }: { node: TreeNode; depth: number; slate: SlateDoc }) {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (!node.isFile) {
    const renameFolder = () => {
      const next = window.prompt(`Rename folder “${node.path}”`, node.path);
      if (next && normalizePath(next) !== node.path) renameCodePath(slate, node.path, next);
    };
    const deleteFolder = () => {
      if (window.confirm(`Delete folder “${node.path}” and everything inside it?`)) deleteCodePath(slate, node.path);
    };
    return (
      <li className="group/row relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={indent}
          className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 pr-12 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {open ? <FolderOpen size={12} className="text-accent" /> : <Folder size={12} className="text-accent" />}
          <span className="truncate font-mono">{node.name}</span>
        </button>
        <RowActions onRename={renameFolder} onDelete={deleteFolder} name={node.name} />
        {open && <TreeChildren node={node} depth={depth + 1} slate={slate} />}
      </li>
    );
  }

  const renameFile = () => {
    if (!node.fileId) return;
    const next = window.prompt(`Rename “${node.path}”`, node.path);
    if (next && normalizePath(next) !== node.path) renameCodeEntry(slate, node.fileId, next);
  };
  const deleteFile = () => {
    if (!node.fileId) return;
    if (window.confirm(`Delete ${node.path}? It disappears for everyone on this board.`)) deleteCodeEntry(slate, node.fileId);
  };
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => node.fileId && openCodeFile(node.fileId)}
        style={indent}
        title={node.path}
        className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 pr-12 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
      >
        <span className="w-[11px]" />
        <FileCode2 size={12} className="shrink-0 opacity-70" />
        <span className="truncate font-mono">{node.name}</span>
      </button>
      <RowActions onRename={renameFile} onDelete={deleteFile} name={node.name} />
    </li>
  );
}

function RowActions({ onRename, onDelete, name }: { onRename: () => void; onDelete: () => void; name: string }) {
  return (
    <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover/row:flex">
      <button type="button" title={`Rename ${name}`} onClick={onRename} className="grid h-5 w-5 place-items-center rounded bg-bg-2/90 text-text-dim hover:text-text">
        <Pencil size={10} />
      </button>
      <button type="button" title={`Delete ${name}`} onClick={onDelete} className="grid h-5 w-5 place-items-center rounded bg-bg-2/90 text-text-dim hover:text-danger">
        <Trash2 size={10} />
      </button>
    </span>
  );
}

/** Build a folder tree from file paths + explicit (possibly empty) folders. */
function buildTree(files: { id: string; name: string }[], folders: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] };

  const ensureFolder = (segs: string[]): TreeNode => {
    let cur = root;
    segs.forEach((seg, i) => {
      const path = segs.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.name === seg && !c.isFile);
      if (!next) {
        next = { name: seg, path, isFile: false, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
    return cur;
  };

  // Seed explicit empty folders first so they show even with no files inside.
  for (const f of folders) {
    const segs = f.split('/').filter(Boolean);
    if (segs.length) ensureFolder(segs);
  }

  for (const f of files) {
    const segs = f.name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segs.length === 0) continue;
    const parent = ensureFolder(segs.slice(0, -1));
    const leaf = segs[segs.length - 1]!;
    parent.children.push({ name: leaf, path: segs.join('/'), isFile: true, fileId: f.id, children: [] });
  }
  return root;
}

export default CodeFilesPanel;
