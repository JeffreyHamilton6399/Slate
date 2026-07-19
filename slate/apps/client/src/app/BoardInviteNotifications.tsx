/**
 * BoardInviteNotifications — pending "come join my board" invites as small
 * cards pinned bottom-right (below the toast layer, so the arrival toast
 * announces and then fades to reveal the persistent, actionable card). Mounted
 * app-wide so an invite is joinable from Home or from inside another board;
 * renders nothing when there are none.
 */

import { X } from 'lucide-react';
import { useAccount } from '../account/useAccount';
import { useBoardInvites } from '../account/useBoardInvites';
import { useAppStore } from './store';
import { Avatar } from './Avatar';

export function BoardInviteNotifications() {
  const { user } = useAccount();
  const { invites, accept, decline } = useBoardInvites(user?.id);
  const enterBoard = useAppStore((s) => s.enterBoard);
  const currentBoard = useAppStore((s) => s.currentBoard);

  // Don't advertise an invite to the board you're already in.
  const shown = invites.filter((i) => i.boardName !== currentBoard?.name).slice(0, 3);
  if (shown.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[1090] flex w-[320px] max-w-[92vw] flex-col gap-2">
      {shown.map((inv) => (
        <div
          key={inv.id}
          className="flex items-center gap-2 rounded-lg border border-accent/40 bg-bg-2/95 p-2.5 shadow-xl backdrop-blur animate-slide-up"
        >
          <Avatar url={inv.fromAvatar} name={inv.fromName} size={30} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-text">
              <span className="font-semibold">{inv.fromName}</span> invited you to{' '}
              <span className="font-semibold text-accent">{inv.boardName}</span>
            </p>
            <span className="text-[9px] font-mono uppercase tracking-wider text-text-dim">{inv.mode}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              const i = accept(inv.id);
              if (i) enterBoard({ name: i.boardName, mode: i.mode, visibility: 'public', iAmCreator: false, joinedAt: Date.now() });
            }}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white hover:bg-accent/90"
          >
            Join
          </button>
          <button
            type="button"
            onClick={() => decline(inv.id)}
            className="rounded-sm p-1 text-text-dim hover:bg-bg-4 hover:text-text"
            aria-label="Dismiss invite"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
