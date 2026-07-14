-- Slate — Supabase setup
--
-- 1. Create a project at https://supabase.com, then run this file in the
--    SQL editor (Database → SQL).
-- 2. Enable the Email provider (Authentication → Providers → Email);
--    magic links are on by default.
-- 3. Set the site URL (Authentication → URL configuration) to your app
--    origin, e.g. https://your-slate.vercel.app
-- 4. Add to the client build environment (Vercel → Settings → Env vars):
--      VITE_SUPABASE_URL=      (Project settings → API → Project URL)
--      VITE_SUPABASE_ANON_KEY= (Project settings → API → anon public key)

-- Per-user board save backups (mirrors the local save slots).
create table if not exists public.board_saves (
  user_id uuid not null references auth.users (id) on delete cascade,
  save_id text not null,
  board_name text not null,
  label text not null,
  mode text not null default '2d',
  saved_at timestamptz not null default now(),
  data jsonb not null,
  primary key (user_id, save_id)
);

alter table public.board_saves enable row level security;

create policy "users read own saves"
  on public.board_saves for select
  using (auth.uid() = user_id);

create policy "users insert own saves"
  on public.board_saves for insert
  with check (auth.uid() = user_id);

create policy "users update own saves"
  on public.board_saves for update
  using (auth.uid() = user_id);

create policy "users delete own saves"
  on public.board_saves for delete
  using (auth.uid() = user_id);
