/**
 * Export helpers for 'code' boards — read the shared file map + Y.Texts and
 * produce downloads. Dependency-free (zip.ts is hand-rolled), so the
 * ExportDialog can import this eagerly without pulling in CodeMirror.
 */

import type { SlateDoc } from '../sync/doc';
import { buildZip, type ZipEntry } from './zip';

export interface CodeFile {
  id: string;
  name: string;
}

/** File list off the Yjs map, name-sorted for stable display order. */
export function listCodeFiles(slate: SlateDoc): CodeFile[] {
  const out: CodeFile[] = [];
  slate.codeFiles().forEach((m, id) => {
    const name = m.get('name');
    if (typeof name === 'string' && name.length > 0) out.push({ id, name });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** All files zipped (stored, not compressed). Duplicate names get a " (n)"
 *  suffix before the extension so archives never contain colliding paths. */
export function codeZipBlob(slate: SlateDoc): Blob {
  const enc = new TextEncoder();
  const seen = new Map<string, number>();
  const entries: ZipEntry[] = listCodeFiles(slate).map((f) => {
    const n = seen.get(f.name) ?? 0;
    seen.set(f.name, n + 1);
    let name = f.name;
    if (n > 0) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    return { name, data: enc.encode(slate.codeText(f.id).toString()) };
  });
  return new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' });
}
