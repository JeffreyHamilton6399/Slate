/**
 * Asset uploads to a Supabase Storage bucket. Big binaries (doc/2D images,
 * board backgrounds, audio samples) are stored here and referenced by URL,
 * rather than base64-embedded in the Yjs doc — keeping boards small and sync
 * fast.
 *
 * Uses the SAME Supabase client as the accounts system (`account/supabase`) so
 * there's only one client/session. Every function returns null when Supabase
 * isn't configured or the upload fails, so callers fall back to embedding.
 */

import { supabase } from '../account/supabase';

const bucketEnv = (import.meta.env as { VITE_SUPABASE_BUCKET?: string }).VITE_SUPABASE_BUCKET;

/** Public bucket assets are uploaded to. Override with VITE_SUPABASE_BUCKET. */
export const ASSET_BUCKET = bucketEnv || 'slate-assets';

/** True when Supabase (and therefore bucket upload) is available. */
export function storageEnabled(): boolean {
  return supabase !== null;
}

/** Upload a Blob; returns its public URL, or null on failure / not configured. */
export async function uploadAsset(data: Blob, ext: string, prefix = 'assets'): Promise<string | null> {
  if (!supabase) return null;
  try {
    const path = `${prefix}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, data, {
      contentType: data.type || undefined,
      cacheControl: '31536000',
      upsert: false,
    });
    if (error) {
      console.warn('[supabase] upload failed:', error.message);
      return null;
    }
    return supabase.storage.from(ASSET_BUCKET).getPublicUrl(path).data.publicUrl || null;
  } catch (err) {
    console.warn('[supabase] upload error:', err);
    return null;
  }
}

/** Upload a `data:` URL (e.g. a downscaled image) and return its bucket URL. */
export async function uploadDataUrl(dataUrl: string, prefix = 'images'): Promise<string | null> {
  if (!supabase || !dataUrl.startsWith('data:')) return null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    return uploadAsset(blob, mimeToExt(blob.type) ?? 'bin', prefix);
  } catch (err) {
    console.warn('[supabase] data-url upload error:', err);
    return null;
  }
}

function mimeToExt(mime: string): string | null {
  const map: Record<string, string> = {
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
  };
  return map[mime] ?? null;
}
