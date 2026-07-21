/**
 * Presence heartbeat + board invites — the "whole friends thing" backend on
 * top of the profiles/friends/board_invites tables (supabase/schema.sql).
 * All functions no-op when Supabase isn't configured.
 */

import type { DocMode } from '@slate/sync-protocol';
import { supabase } from './supabase';

// ── Presence ────────────────────────────────────────────────────────────────

/** Update my `last_seen` so friends see me online. Called on a timer while the
 *  app is open and I've opted in to showing my presence. */
export async function heartbeat(userId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('profiles')
    .update({ last_seen: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) console.warn('heartbeat failed:', error.message);
}

/** Clear my `last_seen` so I immediately show as offline (opt out of presence
 *  or on sign-out). */
export async function goOffline(userId: string): Promise<void> {
  if (!supabase) return;
  await supabase.from('profiles').update({ last_seen: null }).eq('user_id', userId);
}

// ── Board invites ───────────────────────────────────────────────────────────

export interface BoardInvite {
  id: string;
  fromUserId: string;
  fromName: string;
  fromAvatar: string | null;
  boardName: string;
  mode: DocMode;
  createdAt: number;
}

/** Invite a friend to a board. Dedupes an existing pending invite to the same
 *  friend + board so spamming the button doesn't pile up rows. */
export async function sendBoardInvite(
  fromUserId: string,
  toUserId: string,
  boardName: string,
  mode: DocMode,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Accounts are not configured.' };
  const { data: existing } = await supabase
    .from('board_invites')
    .select('id')
    .eq('from_user', fromUserId)
    .eq('to_user', toUserId)
    .eq('board_name', boardName)
    .maybeSingle();
  if (existing) return { ok: true }; // already invited to this board
  const { error } = await supabase.from('board_invites').insert({
    from_user: fromUserId,
    to_user: toUserId,
    board_name: boardName,
    mode,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Incoming board invites for me, newest first, with the sender's profile. */
export async function getIncomingInvites(userId: string): Promise<BoardInvite[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('board_invites')
    .select('id,from_user,board_name,mode,created_at')
    .eq('to_user', userId)
    .order('created_at', { ascending: false });
  if (error || !data || data.length === 0) return [];
  const rows = data as { id: string; from_user: string; board_name: string; mode: string; created_at: string }[];
  const senderIds = Array.from(new Set(rows.map((r) => r.from_user)));
  const { data: profs } = await supabase
    .from('profiles')
    .select('user_id,display_name,avatar_url')
    .in('user_id', senderIds);
  const byId = new Map<string, { display_name: string; avatar_url: string | null }>();
  for (const p of (profs ?? []) as { user_id: string; display_name: string; avatar_url: string | null }[]) {
    byId.set(p.user_id, p);
  }
  return rows.map((r) => ({
    id: r.id,
    fromUserId: r.from_user,
    fromName: byId.get(r.from_user)?.display_name ?? 'A friend',
    fromAvatar: byId.get(r.from_user)?.avatar_url ?? null,
    boardName: r.board_name,
    mode: (r.mode === '3d' || r.mode === 'audio' || r.mode === 'doc' || r.mode === 'code' || r.mode === 'diagram' ? r.mode : '2d') as DocMode,
    createdAt: Date.parse(r.created_at) || Date.now(),
  }));
}

/** Remove an invite (recipient joined/declined, or sender cancelled). */
export async function deleteInvite(inviteId: string): Promise<void> {
  if (!supabase) return;
  await supabase.from('board_invites').delete().eq('id', inviteId);
}
