/**
 * useBoardInvites — the current user's incoming "come join my board" invites,
 * polled so they arrive as notifications, plus a presence heartbeat.
 *
 * Accepting returns the board to join (the caller enters it and the invite is
 * deleted); declining just deletes it. A toast fires for each newly-arrived
 * invite (the first load seeds the seen-set so a backlog isn't re-announced).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteInvite,
  getIncomingInvites,
  goOffline,
  heartbeat,
  type BoardInvite,
} from './social';
import { supabase } from './supabase';
import { toast } from '../ui/Toast';

const POLL_MS = 15_000;
const HEARTBEAT_MS = 45_000;

export function useBoardInvites(userId: string | undefined): {
  invites: BoardInvite[];
  refresh: () => void;
  accept: (id: string) => BoardInvite | null;
  decline: (id: string) => void;
} {
  const [invites, setInvites] = useState<BoardInvite[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const invitesRef = useRef<BoardInvite[]>([]);
  invitesRef.current = invites;

  const refresh = useCallback(() => {
    if (!userId || !supabase) {
      setInvites([]);
      return;
    }
    void getIncomingInvites(userId).then((list) => {
      if (seenRef.current === null) {
        seenRef.current = new Set(list.map((i) => i.id));
      } else {
        for (const inv of list) {
          if (!seenRef.current.has(inv.id)) {
            seenRef.current.add(inv.id);
            toast({ title: 'Board invite', description: `${inv.fromName} invited you to “${inv.boardName}”` });
          }
        }
      }
      setInvites(list);
    });
  }, [userId]);

  useEffect(() => {
    refresh();
    if (!userId || !supabase) return;
    const iv = setInterval(refresh, POLL_MS);
    return () => clearInterval(iv);
  }, [userId, refresh]);

  const accept = useCallback((id: string): BoardInvite | null => {
    const inv = invitesRef.current.find((i) => i.id === id) ?? null;
    setInvites((cur) => cur.filter((i) => i.id !== id));
    void deleteInvite(id);
    return inv;
  }, []);

  const decline = useCallback((id: string) => {
    setInvites((cur) => cur.filter((i) => i.id !== id));
    void deleteInvite(id);
  }, []);

  return { invites, refresh, accept, decline };
}

/** Keep the user's presence heartbeat alive while `enabled`; clear it on
 *  disable / unmount so they show offline when they opt out or leave. */
export function usePresence(userId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!userId || !supabase) return;
    if (!enabled) {
      void goOffline(userId);
      return;
    }
    void heartbeat(userId);
    const iv = setInterval(() => void heartbeat(userId), HEARTBEAT_MS);
    const onHide = () => { if (document.visibilityState === 'hidden') void heartbeat(userId); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [userId, enabled]);
}
