/**
 * Supabase client — accounts + cross-device save backup.
 *
 * Configured entirely by env vars so the app keeps working account-less:
 *   VITE_SUPABASE_URL       e.g. https://xyzcompany.supabase.co
 *   VITE_SUPABASE_ANON_KEY  the project's public anon key
 *
 * When unset, `supabase` is null and the Settings account section explains
 * how to enable it. Database schema + RLS policies live in /supabase/schema.sql.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface SupabaseEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

const env = import.meta.env as SupabaseEnv;

export const supabase: SupabaseClient | null =
  env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY
    ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
    : null;

export const accountsEnabled = supabase !== null;
