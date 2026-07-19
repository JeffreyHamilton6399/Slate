/**
 * FriendsPanel — a dockable Friends tab (bottom-right by default). Shows your
 * friends with online dots, incoming requests to accept/decline, an add-by-
 * email form, and — because it lives inside a board — an "invite to this
 * board" button per friend. The invited friend gets a toast + a Board-invites
 * banner on their Home.
 *
 * Replaces the Friends section that used to live on the Home screen.
 */

import { useState } from 'react';
import { Check, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { useAccount } from '../account/useAccount';
import { useFriends } from '../account/useFriends';
import { sendBoardInvite } from '../account/social';
import { accountsEnabled } from '../account/supabase';
import { useAppStore } from '../app/store';
import { Avatar } from '../app/Avatar';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { toast } from '../ui/Toast';

export function FriendsPanel() {
  const { user } = useAccount();
  const userId = user?.id;
  const { friends, pending, sendRequest, accept, remove } = useFriends(userId);
  const board = useAppStore((s) => s.currentBoard);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  if (!accountsEnabled) {
    return (
      <div className="p-3 text-xs text-text-dim">
        Sign in with an account to add friends. (Accounts need Supabase configured — see
        supabase/schema.sql.)
      </div>
    );
  }
  if (!userId) {
    return (
      <div className="p-3 text-xs text-text-dim">
        Sign in from the start screen to add friends and invite them to boards.
      </div>
    );
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    await sendRequest(email);
    setBusy(false);
    setEmail('');
  };

  const invite = async (friendId: string, name: string) => {
    if (!board) return;
    setInvited((s) => new Set(s).add(friendId));
    const r = await sendBoardInvite(userId, friendId, board.name, board.mode);
    if (r.ok) toast({ title: 'Invite sent', description: `${name} → ${board.name}` });
    else {
      toast({ title: 'Could not invite', description: r.error, variant: 'error' });
      setInvited((s) => { const n = new Set(s); n.delete(friendId); return n; });
    }
  };

  const onlineCount = friends.filter((f) => f.online).length;

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex items-center justify-between">
        <h5 className="panel-title flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          <Users size={11} /> Friends
        </h5>
        {friends.length > 0 && (
          <span className="text-[10px] text-text-dim">{onlineCount}/{friends.length} online</span>
        )}
      </div>

      {/* Add by email */}
      <form onSubmit={submit} className="flex gap-1.5">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="friend@email.com"
          aria-label="Friend's email"
          className="min-w-0 flex-1 text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>
          <UserPlus size={12} />
        </Button>
      </form>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {/* Incoming / sent requests */}
        {pending.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">Requests</p>
            <ul className="flex flex-col gap-1">
              {pending.map((f) => (
                <li key={f.userId} className="flex items-center gap-2 rounded-md border border-border bg-bg-3 px-2 py-1.5">
                  <Avatar url={f.avatarUrl} name={f.displayName} size={24} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-text">{f.displayName || 'Anonymous'}</p>
                    {f.email && <p className="truncate text-[10px] text-text-dim">{f.email}</p>}
                  </div>
                  {f.incoming ? (
                    <>
                      <button type="button" onClick={() => void accept(f.userId)} className="rounded-sm p-1 text-text-mid hover:bg-bg-4 hover:text-green" aria-label={`Accept ${f.displayName}`}>
                        <Check size={13} />
                      </button>
                      <button type="button" onClick={() => void remove(f.userId)} className="rounded-sm p-1 text-text-mid hover:bg-bg-4 hover:text-danger" aria-label={`Decline ${f.displayName}`}>
                        <X size={13} />
                      </button>
                    </>
                  ) : (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-text-dim">sent</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Accepted friends */}
        {friends.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {[...friends]
              .sort((a, b) => Number(b.online) - Number(a.online))
              .map((f) => (
                <li key={f.userId} className="group flex items-center gap-2 rounded-md border border-border bg-bg-3 px-2 py-1.5">
                  <span className="relative shrink-0">
                    <Avatar url={f.avatarUrl} name={f.displayName} size={26} />
                    <span
                      className={
                        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-3 ' +
                        (f.online ? 'bg-green' : 'bg-text-dim/50')
                      }
                      title={f.online ? 'Online' : 'Offline'}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-text">{f.displayName || 'Anonymous'}</p>
                    <p className="text-[10px] text-text-dim">{f.online ? 'Online' : 'Offline'}</p>
                  </div>
                  {board && (
                    <button
                      type="button"
                      disabled={invited.has(f.userId)}
                      onClick={() => void invite(f.userId, f.displayName || 'Friend')}
                      title={`Invite to ${board.name}`}
                      className="rounded-sm p-1 text-text-mid hover:bg-bg-4 hover:text-accent disabled:text-green"
                      aria-label={`Invite ${f.displayName} to this board`}
                    >
                      {invited.has(f.userId) ? <Check size={13} /> : <UserPlus size={13} />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(f.userId)}
                    className="rounded-sm p-1 text-text-dim opacity-0 hover:bg-bg-4 hover:text-danger group-hover:opacity-100"
                    aria-label={`Remove ${f.displayName}`}
                  >
                    <UserMinus size={13} />
                  </button>
                </li>
              ))}
          </ul>
        ) : pending.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-center text-[11px] text-text-dim">
            No friends yet — add someone by their email above. Then you can invite them to this board.
          </p>
        ) : null}
      </div>
    </div>
  );
}
