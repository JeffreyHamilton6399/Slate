/**
 * Friends API client — backed by the `public.profiles` + `public.friends`
 * tables (see supabase/schema.sql). All functions degrade gracefully when
 * Supabase isn't configured (supabase === null) so the rest of the app keeps
 * working in account-less mode.
 *
 * Friendship rows are stored bidirectionally once accepted: an accepted
 * friendship has TWO rows (user_id → friend_id AND friend_id → user_id) so
 * both sides see it with a single query. A pending request has ONE row from
 * the sender → recipient.
 */

import { supabase } from './supabase';

export type FriendStatus = 'pending' | 'accepted' | 'blocked';

/** A friend is "online" if their heartbeat is newer than this. */
export const ONLINE_WINDOW_MS = 90_000;

export interface Friend {
  userId: string;
  displayName: string;
  email: string | null;
  /** Small JPEG data URL, or null. */
  avatarUrl: string | null;
  status: FriendStatus;
  /** true = THEY sent the request to ME; false = I sent the request to them. */
  incoming: boolean;
  /** Presence: true when their heartbeat is recent (and they show it). */
  online: boolean;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  last_seen: string | null;
}

/** The friends feature needs the profiles/friends tables (supabase/schema.sql).
 *  PostgREST reports a missing table as "Could not find the table … in the
 *  schema cache" (or a 42P01 relation-does-not-exist). Turn that into one
 *  actionable message instead of a raw Postgres string. */
function friendlyError(msg: string | undefined): string | undefined {
  if (!msg) return msg;
  if (/schema cache|does not exist|relation .* does not/i.test(msg)) {
    return 'Friends need a one-time database setup — run supabase/schema.sql in your Supabase project (SQL editor), then try again.';
  }
  return msg;
}

interface FriendRow {
  user_id: string;
  friend_id: string;
  status: FriendStatus;
}

/**
 * Get the current user's friends list — accepted friends + pending requests
 * (incoming and outgoing). Blocked entries are excluded from the UI list.
 */
export async function getFriends(userId: string): Promise<Friend[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('friends')
    .select('user_id,friend_id,status')
    .or(`user_id.eq.${userId},friend_id.eq.${userId}`);
  if (error) {
    console.warn('getFriends failed:', error.message);
    return [];
  }
  if (!data || data.length === 0) return [];

  const rows = data as FriendRow[];

  // Collect the OTHER user's id for every relationship, then look up their
  // profiles in one query so the friends list can render display names.
  const otherIds = Array.from(
    new Set(rows.map((r) => (r.user_id === userId ? r.friend_id : r.user_id))),
  );
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('user_id,display_name,email,avatar_url,last_seen')
    .in('user_id', otherIds);
  if (pErr) {
    console.warn('getFriends profiles lookup failed:', pErr.message);
  }
  const profileById = new Map<string, ProfileRow>();
  for (const p of (profiles ?? []) as ProfileRow[]) {
    profileById.set(p.user_id, p);
  }

  // De-duplicate: an accepted friendship has TWO rows (one from each side).
  // Prefer the row where the current user is `user_id` so the `incoming`
  // flag is computed from the sender's perspective; fall back to the reverse
  // row for purely incoming pending requests.
  const byOtherId = new Map<string, Friend>();
  for (const r of rows) {
    const otherId = r.user_id === userId ? r.friend_id : r.user_id;
    const incoming = r.user_id !== userId && r.status === 'pending';
    const existing = byOtherId.get(otherId);
    // For pending: only the sender→recipient row exists, so incoming is
    // true when the recipient (us) is `friend_id`.
    // For accepted: both rows exist; pick the one where we are `user_id`
    // (incoming = false) so we don't double-count.
    if (!existing) {
      const p = profileById.get(otherId);
      const seen = p?.last_seen ? Date.parse(p.last_seen) : 0;
      byOtherId.set(otherId, {
        userId: otherId,
        displayName: p?.display_name ?? 'Anonymous',
        email: p?.email ?? null,
        avatarUrl: p?.avatar_url ?? null,
        status: r.status,
        incoming,
        online: seen > 0 && Date.now() - seen < ONLINE_WINDOW_MS,
      });
      continue;
    }
    // Already have an entry — only overwrite if the new row gives a clearer
    // picture: prefer our outgoing perspective for accepted relationships.
    if (r.user_id === userId && r.status === 'accepted') {
      byOtherId.set(otherId, {
        ...existing,
        status: r.status,
        incoming: false,
      });
    }
  }

  return Array.from(byOtherId.values());
}

/** Send a friend request by email. Returns ok=false if the user isn't found. */
export async function sendFriendRequest(
  userId: string,
  friendEmail: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Accounts are not configured.' };
  const email = friendEmail.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, error: 'Enter a valid email address.' };

  // Don't allow friending yourself.
  const { data: self } = await supabase.auth.getUser();
  if (self?.user?.email?.toLowerCase() === email) {
    return { ok: false, error: "You can't add yourself as a friend." };
  }

  // Look up the friend's profile by email.
  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('user_id,display_name,email,avatar_url')
    .eq('email', email)
    .maybeSingle();
  if (pErr) return { ok: false, error: friendlyError(pErr.message) };
  if (!profile) return { ok: false, error: 'No Slate user with that email — they need an account first.' };
  const friend = profile as ProfileRow;

  // Already friends (either direction)? Short-circuit.
  const { data: existing } = await supabase
    .from('friends')
    .select('user_id,friend_id,status')
    .or(
      `and(user_id.eq.${userId},friend_id.eq.${friend.user_id}),and(user_id.eq.${friend.user_id},friend_id.eq.${userId})`,
    );
  if (existing && existing.length > 0) {
    const row = existing[0] as FriendRow;
    if (row.status === 'accepted') {
      return { ok: false, error: 'You are already friends.' };
    }
    if (row.user_id === userId) {
      return { ok: false, error: 'Friend request already sent.' };
    }
    // They sent us a request — accept it instead of duplicating.
    await acceptFriendRequest(userId, friend.user_id);
    return { ok: true };
  }

  const { error: insErr } = await supabase.from('friends').insert({
    user_id: userId,
    friend_id: friend.user_id,
    status: 'pending',
  });
  if (insErr) return { ok: false, error: friendlyError(insErr.message) };
  return { ok: true };
}

/**
 * Accept a pending friend request. Flips the incoming row to `accepted` AND
 * inserts the reverse row so both sides see the friendship in their list.
 */
export async function acceptFriendRequest(userId: string, friendId: string): Promise<void> {
  if (!supabase) return;
  // The pending row was sent BY the friend → ME, so user_id = friendId,
  // friend_id = userId. Update it to accepted.
  const { error: updErr } = await supabase
    .from('friends')
    .update({ status: 'accepted' })
    .eq('user_id', friendId)
    .eq('friend_id', userId);
  if (updErr) {
    console.warn('acceptFriendRequest update failed:', updErr.message);
    return;
  }
  // Insert the reverse row (me → friend, accepted) so both sides see it
  // with one query. Upsert guards against the rare race where it already
  // exists.
  const { error: insErr } = await supabase
    .from('friends')
    .upsert(
      { user_id: userId, friend_id: friendId, status: 'accepted' },
      { onConflict: 'user_id,friend_id' },
    );
  if (insErr) {
    console.warn('acceptFriendRequest reverse insert failed:', insErr.message);
  }
}

/**
 * Remove a friend — declines a pending request or unfriends an accepted one.
 * Deletes BOTH rows (user_id → friend_id AND friend_id → user_id) so neither
 * side sees the relationship.
 */
export async function removeFriend(userId: string, friendId: string): Promise<void> {
  if (!supabase) return;
  const { error: e1 } = await supabase
    .from('friends')
    .delete()
    .eq('user_id', userId)
    .eq('friend_id', friendId);
  if (e1) console.warn('removeFriend (self → friend) failed:', e1.message);

  const { error: e2 } = await supabase
    .from('friends')
    .delete()
    .eq('user_id', friendId)
    .eq('friend_id', userId);
  if (e2) console.warn('removeFriend (friend → self) failed:', e2.message);
}

/**
 * Upsert the current user's profile row. Called on sign-in / display name
 * change so friends can look them up by email and render their display name.
 */
export async function upsertMyProfile(
  userId: string,
  displayName: string,
  email: string | null,
  avatarUrl?: string | null,
): Promise<void> {
  if (!supabase) return;
  // Store email lowercased so friend lookups (which lowercase the query) match.
  const row: Record<string, unknown> = { user_id: userId, display_name: displayName, email: email?.toLowerCase() ?? null };
  // Only send avatar_url when provided so a name-only update never clears it.
  if (avatarUrl !== undefined) row.avatar_url = avatarUrl || null;
  const { error } = await supabase.from('profiles').upsert(row, { onConflict: 'user_id' });
  if (error) console.warn('upsertMyProfile failed:', error.message);
}

/**
 * Make sure THIS user has a profiles row so friends can find them by email —
 * called on every sign-in. Without it, a user who signed up but never opened
 * their Profile to save a name has no row, and "add friend by email" reports
 * "no user with that email" even though the account exists. Creates the row
 * (with a sensible default name) only when missing; when it already exists we
 * just keep the email in sync (lowercased) and never clobber the saved name or
 * avatar.
 */
export async function ensureMyProfile(
  userId: string,
  email: string | null,
  fallbackName: string,
): Promise<void> {
  if (!supabase) return;
  const lower = email?.toLowerCase() ?? null;
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id,display_name,email')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('ensureMyProfile lookup failed:', error.message);
    return;
  }
  if (!data) {
    const name = fallbackName.trim() || lower?.split('@')[0] || 'Anonymous';
    const { error: insErr } = await supabase
      .from('profiles')
      .insert({ user_id: userId, display_name: name, email: lower });
    if (insErr) console.warn('ensureMyProfile insert failed:', insErr.message);
  } else if ((data as { email: string | null }).email !== lower) {
    const { error: updErr } = await supabase.from('profiles').update({ email: lower }).eq('user_id', userId);
    if (updErr) console.warn('ensureMyProfile email sync failed:', updErr.message);
  }
}

/** Fetch MY profile (used on sign-in to pull the avatar synced from another
 *  device). Returns null if unconfigured / not found. */
export async function fetchMyProfile(userId: string): Promise<{ displayName: string; avatarUrl: string | null } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name,avatar_url')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { display_name: string; avatar_url: string | null };
  return { displayName: row.display_name, avatarUrl: row.avatar_url };
}
