/**
 * Shared mutations + parsing for 'code' boards. Centralizes every write to the
 * `code:files` Y.Map so the editor rail, the Files panel, and the AI assistant
 * all create/rename/delete files the same way (and stay in one Yjs transaction
 * each).
 *
 * Folders: a folder is either implied by a file's path ("src/app.ts" nests
 * under src/) OR stored explicitly as a `{ name, kind: 'folder' }` entry so an
 * EMPTY folder can exist. `listCodeFiles` (in exportCode) returns only real
 * files; `listCodeFolders` here returns the explicit folder paths.
 */

import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import type { SlateDoc } from '../sync/doc';

/** Normalize a user/AI-supplied path: forward slashes, no leading/trailing or
 *  duplicate separators, no `.`/`..` segments. */
export function normalizePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

/** Explicit empty-folder paths (entries flagged kind: 'folder'). */
export function listCodeFolders(slate: SlateDoc): string[] {
  const out: string[] = [];
  slate.codeFiles().forEach((m) => {
    if (m.get('kind') === 'folder') {
      const name = m.get('name');
      if (typeof name === 'string' && name) out.push(normalizePath(name));
    }
  });
  return out;
}

/** Find a file entry id by its exact path (real files only, not folders). */
function findFileId(slate: SlateDoc, path: string): string | null {
  let found: string | null = null;
  slate.codeFiles().forEach((m, id) => {
    if (m.get('kind') === 'folder') return;
    if (m.get('name') === path) found = id;
  });
  return found;
}

/** Create a file if absent, or replace an existing file's contents. Returns the
 *  entry id and whether it was newly created. One Yjs transaction. */
export function upsertCodeFile(
  slate: SlateDoc,
  rawPath: string,
  content: string,
): { id: string; created: boolean } {
  const path = normalizePath(rawPath);
  const existing = findFileId(slate, path);
  if (existing) {
    const yt = slate.codeText(existing);
    slate.doc.transact(() => {
      if (yt.length > 0) yt.delete(0, yt.length);
      if (content) yt.insert(0, content);
    });
    return { id: existing, created: false };
  }
  const id = nanoid(8);
  slate.doc.transact(() => {
    const meta = new Y.Map<unknown>();
    meta.set('name', path);
    slate.codeFiles().set(id, meta);
    const yt = slate.codeText(id);
    if (content) yt.insert(0, content);
  });
  return { id, created: true };
}

/** Create an explicit (possibly empty) folder. No-op if a folder with that path
 *  already exists. */
export function createCodeFolder(slate: SlateDoc, rawPath: string): void {
  const path = normalizePath(rawPath);
  if (!path) return;
  if (listCodeFolders(slate).includes(path)) return;
  slate.doc.transact(() => {
    const meta = new Y.Map<unknown>();
    meta.set('name', path);
    meta.set('kind', 'folder');
    slate.codeFiles().set(nanoid(8), meta);
  });
}

/** Rename a file or folder entry. For folders, also re-prefixes every file and
 *  folder that lived under the old path so the whole subtree moves. */
export function renameCodeEntry(slate: SlateDoc, id: string, rawName: string): void {
  const name = normalizePath(rawName);
  if (!name) return;
  const entry = slate.codeFiles().get(id);
  if (!entry) return;
  const oldName = entry.get('name');
  if (typeof oldName !== 'string' || oldName === name) {
    if (typeof oldName === 'string') entry.set('name', name);
    return;
  }
  const isFolder = entry.get('kind') === 'folder';
  slate.doc.transact(() => {
    entry.set('name', name);
    if (!isFolder) return;
    const prefix = `${oldName}/`;
    slate.codeFiles().forEach((m) => {
      const n = m.get('name');
      if (typeof n === 'string' && n.startsWith(prefix)) {
        m.set('name', `${name}/${n.slice(prefix.length)}`);
      }
    });
  });
}

/** Delete a file or folder entry. Deleting a folder removes everything under it
 *  (its own entry plus any file/folder whose path is nested inside). Returns the
 *  ids removed so callers can drop them from open-tab state. */
export function deleteCodeEntry(slate: SlateDoc, id: string): string[] {
  const entry = slate.codeFiles().get(id);
  if (!entry) return [];
  const name = entry.get('name');
  const isFolder = entry.get('kind') === 'folder';
  const removed: string[] = [id];
  slate.doc.transact(() => {
    if (isFolder && typeof name === 'string') {
      const prefix = `${name}/`;
      slate.codeFiles().forEach((m, otherId) => {
        const n = m.get('name');
        if (otherId !== id && typeof n === 'string' && n.startsWith(prefix)) removed.push(otherId);
      });
    }
    for (const rid of removed) slate.codeFiles().delete(rid);
  });
  return removed;
}

/** Delete everything at a path: the exact entry (file or folder) plus every
 *  file/folder nested under it. Works for implicit folders (derived from file
 *  paths) as well as explicit `kind: 'folder'` entries. */
export function deleteCodePath(slate: SlateDoc, rawPath: string): void {
  const path = normalizePath(rawPath);
  if (!path) return;
  const prefix = `${path}/`;
  slate.doc.transact(() => {
    const toDelete: string[] = [];
    slate.codeFiles().forEach((m, id) => {
      const n = m.get('name');
      if (typeof n === 'string' && (n === path || n.startsWith(prefix))) toDelete.push(id);
    });
    for (const id of toDelete) slate.codeFiles().delete(id);
  });
}

/** Move/rename a path: re-prefixes the exact entry and its whole subtree. */
export function renameCodePath(slate: SlateDoc, rawOld: string, rawNew: string): void {
  const oldPath = normalizePath(rawOld);
  const newPath = normalizePath(rawNew);
  if (!oldPath || !newPath || oldPath === newPath) return;
  const prefix = `${oldPath}/`;
  slate.doc.transact(() => {
    slate.codeFiles().forEach((m) => {
      const n = m.get('name');
      if (typeof n !== 'string') return;
      if (n === oldPath) m.set('name', newPath);
      else if (n.startsWith(prefix)) m.set('name', `${newPath}/${n.slice(prefix.length)}`);
    });
  });
}

export interface ParsedFileBlock {
  path: string;
  content: string;
}

/**
 * Extract file blocks from an AI reply. The assistant is instructed to emit
 * each file as a fenced code block whose opening fence carries the path, e.g.
 *
 *     ```ts path=src/app.ts
 *     ...full file contents...
 *     ```
 *
 * We accept `path=`, `file=`, or `filename=` (quoted or not) anywhere on the
 * opening fence so small formatting differences from the model still parse.
 */
export function parseAiFileBlocks(text: string): ParsedFileBlock[] {
  const out: ParsedFileBlock[] = [];
  // Opening fence (``` + optional info string containing path=…), then content
  // up to the closing fence on its own line.
  const re = /```[^\n]*?\b(?:path|file|filename)\s*=\s*["'`]?([^\s"'`\n]+)["'`]?[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = normalizePath(m[1] ?? '');
    if (!path) continue;
    // Trim a single trailing newline the fence adds, keep interior formatting.
    const content = (m[2] ?? '').replace(/\n$/, '');
    out.push({ path, content });
  }
  return out;
}
