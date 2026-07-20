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
 * Extract file blocks from an AI reply. The assistant is asked to tag each
 * fenced block with `path=…`, but models are inconsistent, so we also accept:
 *   - the path as the info string itself   ```src/app.js
 *   - a filename on the line just before    **index.html** \n ```html
 * Blocks with no discernible path are treated as illustrative snippets and
 * skipped (never written).
 */
export function parseAiFileBlocks(text: string): ParsedFileBlock[] {
  const out: ParsedFileBlock[] = [];
  const seen = new Set<string>();
  const fence = /```([^\n]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = fence.exec(text)) !== null) {
    const info = (m[1] ?? '').trim();
    const content = (m[2] ?? '').replace(/\n$/, '');
    const between = text.slice(lastIndex, m.index);
    lastIndex = fence.lastIndex;
    const raw = pathFromInfo(info) ?? pathFromText(between);
    if (!raw) continue;
    const path = normalizePath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, content });
  }
  return out;
}

function looksLikePath(s: string): boolean {
  if (!s || /\s/.test(s)) return false;
  return s.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

/** Path from a fence info string: `path=…`, or the info itself if it's a path. */
function pathFromInfo(info: string): string | null {
  const kv = /\b(?:path|file|filename|name)\s*=\s*["'`]?([^\s"'`]+)/i.exec(info);
  if (kv?.[1]) return kv[1];
  const token = info.split(/\s+/)[0] ?? '';
  return token && !token.includes('=') && looksLikePath(token) ? token : null;
}

/**
 * Remove the path-tagged file blocks from an AI reply, leaving just the prose
 * (and any non-file code snippets). Used so the chat shows the explanation, not
 * the full file contents, which are written to the tree instead.
 */
export function stripFileBlocks(text: string): string {
  const fence = /```([^\n]*)\n[\s\S]*?```/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const between = text.slice(last, m.index);
    const info = (m[1] ?? '').trim();
    if (pathFromInfo(info) ?? pathFromText(between)) {
      // Drop the file block, plus a trailing filename-only line ("index.html").
      const lines = between.split('\n');
      while (lines.length && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
      const tail = (lines[lines.length - 1] ?? '').trim();
      if (tail && pathFromText(tail)) lines.pop();
      out += lines.join('\n');
    } else {
      out += between + m[0]; // keep a non-file snippet
    }
    last = fence.lastIndex;
  }
  out += text.slice(last);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Path from the last non-empty line before a block (a filename heading). */
function pathFromText(between: string): string | null {
  const lines = between.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const cleaned = last
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^(?:file|filename|path)\s*:\s*/i, '')
    .replace(/^\/\/\s*/, '')
    .replace(/:\s*$/, '')
    .trim();
  if (looksLikePath(cleaned)) return cleaned;
  const tok = cleaned.split(/\s+/).find((t) => looksLikePath(t));
  return tok ?? null;
}
