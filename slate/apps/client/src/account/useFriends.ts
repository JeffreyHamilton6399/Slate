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

export function useFriends(userId: string | undefined): {
  friends: Friend[];
  pending: Friend[];
  loading: boolean;
  refresh: () => void;
  sendRequest: (email: string) => Promise<void>;
  accept: (friendId: string) => Promise<void>;
  remove: (friendId: string) => Promise<void>;
} {
  const [all, setAll] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(Boolean(userId));
  const reqIdRef = useRef(0);

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
      setAll(list);
      setLoading(false);
    });
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return {
    friends: accepted,
    pending,
    loading,
    refresh,
    sendRequest,
    accept,
    remove,
  };
}
