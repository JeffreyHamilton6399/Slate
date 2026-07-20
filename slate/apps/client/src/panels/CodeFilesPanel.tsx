/**
 * CodeFilesPanel — dockable file tree for 'code' boards.
 *
 * Reads the shared `code:files` Y.Map and renders the files as a folder
 * tree based on their path segments (e.g. `src/utils/helper.ts` nests under
 * `src/` → `utils/`). Clicking a file asks the central CodeEditor to open
 * it via a `slate:code-open-file` window CustomEvent — CodeEditor owns the
 * open-tabs/active-file state, this panel only triggers navigation so the
 * same file can't end up "open" in two different places.
 *
 * New-file / rename / delete actions live in the editor's rail; this panel
 * is navigation-only so it doesn't duplicate Yjs mutation paths.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen,
} from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { listCodeFiles } from '../code/exportCode';

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
  /** Path segment name (folder name or file name). Empty for the root. */
  name: string;
  /** Full path joined by '/'. Empty for the root. */
  path: string;
  /** True if this is a file leaf; false for folders. */
  isFile: boolean;
  /** File id from the Y.Map (only set on file leaves). */
  fileId?: string;
  /** Children (folders + files) for this folder. Empty for file leaves. */
  children: TreeNode[];
}

export function CodeFilesPanel() {
  const room = useRoom();
  const [, bump] = useState(0);

  // Re-render on file map changes (add/rename/delete, local or remote).
  useEffect(() => {
    const files = room.slate.codeFiles();
    const fn = () => bump((v) => v + 1);
    files.observeDeep(fn);
    return () => files.unobserveDeep(fn);
  }, [room]);

  const files = listCodeFiles(room.slate);
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div className="flex h-full flex-col gap-2">
      <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">
        <Folder size={11} className="mr-1 inline-block align-[-1px]" />
        Files
        <span className="ml-1 normal-case text-text-dim/70">({files.length})</span>
      </h5>
      {files.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-text-dim">
          No files in this board yet. Use the + in the editor&apos;s file rail to add one.
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto pr-1">
          <TreeChildren node={tree} depth={0} />
        </div>
      )}
    </div>
  );
}

function TreeChildren({ node, depth }: { node: TreeNode; depth: number }) {
  // Folders first (alphabetical), then files (alphabetical) — matches what
  // most file explorers do and keeps related files grouped under their
  // parent folder rather than scattered through the list.
  const sorted = [...node.children].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className="flex flex-col gap-0.5">
      {sorted.map((child) => (
        <TreeRow key={child.path} node={child} depth={depth} />
      ))}
    </ul>
  );
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (!node.isFile) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={indent}
          className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {open ? <FolderOpen size={12} className="text-accent" /> : <Folder size={12} className="text-accent" />}
          <span className="truncate font-mono">{node.name}</span>
        </button>
        {open && <TreeChildren node={node} depth={depth + 1} />}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => node.fileId && openCodeFile(node.fileId)}
        style={indent}
        title={node.path}
        className="flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
      >
        <span className="w-[11px]" />
        <FileCode2 size={12} className="shrink-0 opacity-70" />
        <span className="truncate font-mono">{node.name}</span>
      </button>
    </li>
  );
}

/** Build a folder tree from a flat list of file paths. */
function buildTree(files: { id: string; name: string }[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] };
  for (const f of files) {
    // Normalize backslashes (Windows-style) to forward slashes so paths
    // entered by users on either platform end up with the same shape.
    const segs = f.name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let cur = root;
    segs.forEach((seg, i) => {
      const isLeaf = i === segs.length - 1;
      const path = segs.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.name === seg && !c.isFile === !isLeaf);
      if (!next) {
        next = {
          name: seg,
          path,
          isFile: isLeaf,
          children: [],
          fileId: isLeaf ? f.id : undefined,
        };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  return root;
}

export default CodeFilesPanel;
