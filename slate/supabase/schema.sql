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
--
-- This whole file is IDEMPOTENT — safe to run again on an existing project
-- (tables/columns use `if not exists`; each policy is dropped-then-created,
-- since Postgres has no `create policy if not exists`).

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

drop policy if exists "users read own saves" on public.board_saves;
create policy "users read own saves"
  on public.board_saves for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own saves" on public.board_saves;
create policy "users insert own saves"
  on public.board_saves for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own saves" on public.board_saves;
create policy "users update own saves"
  on public.board_saves for update
  using (auth.uid() = user_id);

drop policy if exists "users delete own saves" on public.board_saves;
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

-- Safe to re-run on an existing project that predates these columns.
alter table public.profiles add column if not exists avatar_url text;
-- Presence: heartbeat timestamp for the online dot. Null / stale = offline.
-- `show_online` lets a user hide their presence (we then stop heartbeating).
alter table public.profiles add column if not exists last_seen timestamptz;
alter table public.profiles add column if not exists show_online boolean not null default true;
-- Social profile fields: short about-me, a one-line status ("🎨 sketching"),
-- and the profile banner color shown behind the avatar.
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists status text;
alter table public.profiles add column if not exists banner_color text;

alter table public.profiles enable row level security;

-- Anyone signed in can read profiles (needed to look up friends by email +
-- to render display names in the friends list).
drop policy if exists "Users can read all profiles" on public.profiles;
create policy "Users can read all profiles"
  on public.profiles for select
  using (true);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own profile" on public.profiles;
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
drop policy if exists "Users can read own friends" on public.friends;
create policy "Users can read own friends"
  on public.friends for select
  using (auth.uid() = user_id or auth.uid() = friend_id);

drop policy if exists "Users can insert own friends" on public.friends;
create policy "Users can insert own friends"
  on public.friends for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own friends" on public.friends;
create policy "Users can update own friends"
  on public.friends for update
  using (auth.uid() = user_id or auth.uid() = friend_id);

drop policy if exists "Users can delete own friends" on public.friends;
create policy "Users can delete own friends"
  on public.friends for delete
  using (auth.uid() = user_id or auth.uid() = friend_id);

-- ============================================================================
-- Board invites — "come join my board". One row per pending invite; the
-- recipient sees it as a notification and joining/declining deletes it.
-- ============================================================================
create table if not exists public.board_invites (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  board_name text not null,
  mode text not null default '2d',
  created_at timestamptz not null default now()
);

alter table public.board_invites enable row level security;

-- Sender or recipient can read the invite.
drop policy if exists "Read own board invites" on public.board_invites;
create policy "Read own board invites"
  on public.board_invites for select
  using (auth.uid() = from_user or auth.uid() = to_user);

-- Only the sender can create it, and only for themselves.
drop policy if exists "Send board invites" on public.board_invites;
create policy "Send board invites"
  on public.board_invites for insert
  with check (auth.uid() = from_user);

-- Either side can remove it (recipient joins/declines, sender cancels).
drop policy if exists "Delete own board invites" on public.board_invites;
create policy "Delete own board invites"
  on public.board_invites for delete
  using (auth.uid() = from_user or auth.uid() = to_user);

-- ── Asset storage bucket ─────────────────────────────────────────────────────
-- Big binaries (doc/2D images, board backgrounds, audio-sample PCM) are
-- uploaded here and referenced by URL, instead of being base64-embedded in the
-- Yjs doc — keeps boards small and sync fast. The client uses VITE_SUPABASE_BUCKET
-- (default 'slate-assets'). Public bucket = anyone can read via the CDN URL.
insert into storage.buckets (id, name, public)
values ('slate-assets', 'slate-assets', true)
on conflict (id) do nothing;

-- Reads: NONE needed. A public bucket serves each object over its public CDN
-- URL (getPublicUrl) with no RLS check, and Slate only ever fetches URLs it
-- already stored in the doc — it never LISTs the bucket. A `for select` policy
-- would let any client enumerate every file in the bucket, so we deliberately
-- omit it (Supabase's storage linter flags that as over-exposure).
--
-- Uploads: allowed for anon + signed-in users, matching Slate's open
-- collaboration model (no account required to edit a board). Tighten to
-- `to authenticated` once you require sign-in.
drop policy if exists "slate-assets read" on storage.objects;  -- remove if previously created
drop policy if exists "slate-assets insert" on storage.objects;
create policy "slate-assets insert"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'slate-assets');
