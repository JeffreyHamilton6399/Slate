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

-- ============================================================================
-- Friends system
-- ============================================================================
-- User profiles (public display info, since auth.users is not client-readable).
-- One row per auth user; created on first sign-in (or on demand from the
-- Profile dialog). The display_name mirrors the local onboarding name so
-- collaborators can recognize each other.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Anonymous',
  email text,
  -- Cropped avatar as a small (~128px) JPEG data URL. Kept inline (not
  -- Storage) so it syncs with a plain profiles read — friends see your pic.
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Safe to re-run on an existing project that predates the avatar column.
alter table public.profiles add column if not exists avatar_url text;

alter table public.profiles enable row level security;

-- Anyone signed in can read profiles (needed to look up friends by email +
-- to render display names in the friends list).
create policy "Users can read all profiles"
  on public.profiles for select
  using (true);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = user_id);

-- Friend relationships. Bidirectional once accepted: an accepted friendship
-- has TWO rows (user_id → friend_id AND friend_id → user_id) so both sides
-- see it in their list with one query. A pending request has ONE row from
-- the sender → recipient.
create table if not exists public.friends (
  user_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending', -- 'pending' | 'accepted' | 'blocked'
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

alter table public.friends enable row level security;

-- Either side of a relationship can read it (so the recipient sees the
-- incoming request and the sender sees the outgoing one).
create policy "Users can read own friends"
  on public.friends for select
  using (auth.uid() = user_id or auth.uid() = friend_id);

create policy "Users can insert own friends"
  on public.friends for insert
  with check (auth.uid() = user_id);

create policy "Users can update own friends"
  on public.friends for update
  using (auth.uid() = user_id or auth.uid() = friend_id);

create policy "Users can delete own friends"
  on public.friends for delete
  using (auth.uid() = user_id or auth.uid() = friend_id);
