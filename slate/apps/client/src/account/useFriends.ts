/**
 * useFriends — React hook wrapping the friends API client. Loads the current
 * user's accepted friends + pending requests, exposes mutation helpers, and
 * re-fetches on success. Returns empty arrays when Supabase isn't configured
 * or the user isn't signed in (so the UI can render the same shape everywhere).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptFriendRequest,
  getFriends,
  removeFriend,
  sendFriendRequest,
  type Friend,
} from './friends';
import { supabase } from './supabase';
import { toast } from '../ui/Toast';

const POLL_MS = 15_000;

export function useFriends(userId: string | undefined): {
  friends: Friend[];
  pending: Friend[];
  /** Count of INCOMING pending requests (for the notification badge). */
  incomingCount: number;
  loading: boolean;
  refresh: () => void;
  sendRequest: (email: string) => Promise<void>;
  accept: (friendId: string) => Promise<void>;
  remove: (friendId: string) => Promise<void>;
} {
  const [all, setAll] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(Boolean(userId));
  const reqIdRef = useRef(0);
  /** Ids of incoming requests we've already seen, so we only toast NEW ones. */
  const seenIncomingRef = useRef<Set<string> | null>(null);

  const refresh = useCallback(() => {
    if (!userId || !supabase) {
      setAll([]);
      setLoading(false);
      return;
    }
    const myReq = ++reqIdRef.current;
    setLoading(true);
    void getFriends(userId).then((list) => {
      // Drop the result if a newer refresh started in the meantime.
      if (myReq !== reqIdRef.current) return;
      // Notify on newly-arrived incoming friend requests. The first load just
      // seeds the "seen" set (no toast for a backlog you already knew about).
      const incoming = list.filter((f) => f.status === 'pending' && f.incoming);
      if (seenIncomingRef.current === null) {
        seenIncomingRef.current = new Set(incoming.map((f) => f.userId));
      } else {
        for (const f of incoming) {
          if (!seenIncomingRef.current.has(f.userId)) {
            seenIncomingRef.current.add(f.userId);
            toast({ title: 'New friend request', description: `${f.displayName || f.email || 'Someone'} wants to be friends` });
          }
        }
      }
      setAll(list);
      setLoading(false);
    });
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll so incoming requests + online status stay fresh without a reload.
  useEffect(() => {
    if (!userId || !supabase) return;
    const iv = setInterval(refresh, POLL_MS);
    return () => clearInterval(iv);
  }, [userId, refresh]);

  const sendRequest = useCallback(
    async (email: string) => {
      if (!userId) {
        toast({ title: 'Sign in to add friends', variant: 'error' });
        return;
      }
      const r = await sendFriendRequest(userId, email);
      if (r.ok) {
        toast({ title: 'Friend request sent', variant: 'success' });
        refresh();
      } else {
        toast({ title: 'Could not send request', description: r.error, variant: 'error' });
      }
    },
    [userId, refresh],
  );

  const accept = useCallback(
    async (friendId: string) => {
      if (!userId) return;
      await acceptFriendRequest(userId, friendId);
      toast({ title: 'Friend added', variant: 'success' });
      refresh();
    },
    [userId, refresh],
  );

  const remove = useCallback(
    async (friendId: string) => {
      if (!userId) return;
      await removeFriend(userId, friendId);
      toast({ title: 'Removed' });
      refresh();
    },
    [userId, refresh],
  );

  const accepted = all.filter((f) => f.status === 'accepted');
  const pending = all.filter((f) => f.status === 'pending');
  const incomingCount = pending.filter((f) => f.incoming).length;

  return {
    friends: accepted,
    pending,
    incomingCount,
    loading,
    refresh,
    sendRequest,
    accept,
    remove,
  };
}
