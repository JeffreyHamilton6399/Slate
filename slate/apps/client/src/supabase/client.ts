/**
 * Supabase client — created only when VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY are set at build time. Supabase is OPTIONAL: every
 * caller must handle the `null` case so Slate runs exactly as before without it
 * (assets fall back to being embedded in the Yjs doc).
 *
 * Set on Vercel (client) — the anon key is safe to ship; real protection comes
 * from the bucket's row-level-security policies, not from hiding the key.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface SupabaseEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_BUCKET?: string;
}

const env = import.meta.env as SupabaseEnv;

export const supabase: SupabaseClient | null =
  env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY
    ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null;

/** Public bucket assets are uploaded to. Override with VITE_SUPABASE_BUCKET. */
export const ASSET_BUCKET = env.VITE_SUPABASE_BUCKET || 'slate-assets';

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
