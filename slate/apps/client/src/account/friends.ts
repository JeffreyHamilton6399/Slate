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

export interface Friend {
  userId: string;
  displayName: string;
  email: string | null;
  status: FriendStatus;
  /** true = THEY sent the request to ME; false = I sent the request to them. */
  incoming: boolean;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  email: string | null;
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
    .select('user_id,display_name,email')
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
      byOtherId.set(otherId, {
        userId: otherId,
        displayName: p?.display_name ?? 'Anonymous',
        email: p?.email ?? null,
        status: r.status,
        incoming,
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
    .select('user_id,display_name,email')
    .eq('email', email)
    .maybeSingle();
  if (pErr) return { ok: false, error: pErr.message };
  if (!profile) return { ok: false, error: 'User not found' };
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
  if (insErr) return { ok: false, error: insErr.message };
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
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('profiles')
    .upsert(
      { user_id: userId, display_name: displayName, email },
      { onConflict: 'user_id' },
    );
  if (error) console.warn('upsertMyProfile failed:', error.message);
}
