/**
 * PeopleWidget — a compact avatar pill that lives in the bottom-left of the
 * viewport and expands on hover into the full roster: who's here, who's in
 * voice, who's talking, plus the voice controls. Draggable by its grip;
 * position persists per browser. On touch devices (no hover) a tap toggles
 * it open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Crown, GripHorizontal, PencilOff, UserX, UserPlus, Check } from 'lucide-react';
import type { AwarenessState } from '@slate/sync-protocol';
import type { SlateRoom } from '../sync/provider';
import { useVoiceOptional } from '../voice/useVoiceOptional';
import { useServerStatus } from '../sync/serverStatus';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../utils/cn';
import { useAccount } from '../account/useAccount';
import { useFriends } from '../account/useFriends';
import { sendBoardInvite } from '../account/social';
import { useAppStore } from './store';
import { Avatar } from './Avatar';
import { toast } from '../ui/Toast';

const STORE_KEY = 'slate.people.v2';
const WIDTH = 224;

/** Position is stored as left/bottom offsets so expansion grows upward. */
interface WidgetPos {
  x: number;
  y: number;
}

function defaultPos(): WidgetPos {
  // Clear of the 2D tool rail (left) and the mobile bottom style bar.
  return window.innerWidth < 640 ? { x: 8, y: 72 } : { x: 60, y: 14 };
}

function clampPos(p: WidgetPos): WidgetPos {
  return {
    x: Math.max(4, Math.min(p.x, window.innerWidth - WIDTH - 4)),
    y: Math.max(4, Math.min(p.y, window.innerHeight - 96)),
  };
}

function loadPos(): WidgetPos {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return clampPos(JSON.parse(raw) as WidgetPos);
  } catch {
    /* fall through */
  }
  return clampPos(defaultPos());
}

export function PeopleWidget({
  awareness,
  room,
}: {
  awareness: AwarenessState[];
  room: SlateRoom;
}) {
  const voice = useVoiceOptional();
  const availability = useServerStatus((s) => s.availability);
  const [pos, setPos] = useState<WidgetPos>(() => loadPos());
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  const open = hovered || pinnedOpen;

  const me = room.identity.peerId;
  const members = [...awareness].sort((a, b) => {
    if (a.id === me) return -1;
    if (b.id === me) return 1;
    return a.joinedAt - b.joinedAt;
  });
  const iAmHost = members.some((m) => m.id === me && m.isHost);

  // Host moderation state lives in board meta so every client enforces it.
  const [drawMutes, setDrawMutes] = useState<string[]>([]);
  useEffect(() => {
    const meta = room.slate.meta();
    const read = () => setDrawMutes((meta.get('drawMutes') as string[] | undefined) ?? []);
    read();
    meta.observe(read);
    return () => meta.unobserve(read);
  }, [room]);

  const toggleDrawMute = useCallback(
    (peerId: string) => {
      const meta = room.slate.meta();
      const list = (meta.get('drawMutes') as string[] | undefined) ?? [];
      meta.set(
        'drawMutes',
        list.includes(peerId) ? list.filter((x) => x !== peerId) : [...list, peerId],
      );
    },
    [room],
  );

  const kick = useCallback(
    (peerId: string) => {
      const meta = room.slate.meta();
      const list = (meta.get('kicked') as string[] | undefined) ?? [];
      if (!list.includes(peerId)) meta.set('kicked', [...list, peerId]);
    },
    [room],
  );

  const savePos = useCallback((p: WidgetPos) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  }, []);

  const onGripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      dx: e.clientX - posRef.current.x,
      dy: window.innerHeight - e.clientY - posRef.current.y,
      moved: false,
    };
  };
  const onGripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;
    setPos(clampPos({ x: e.clientX - d.dx, y: window.innerHeight - e.clientY - d.dy }));
  };
  const onGripPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) savePos(posRef.current);
    // Touch has no hover — a tap (no movement) toggles the roster open.
    else if (e.pointerType === 'touch') setPinnedOpen((v) => !v);
  };

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** Session-local per-person volume (applied to the live voice client). */
  const [peerVol, setPeerVol] = useState<Record<string, number>>({});

  const speaking = (s: AwarenessState) =>
    (s.id === me ? (voice?.selfLevel ?? 0) : s.voiceLevel) > 0.08;
  const inVoice = (s: AwarenessState) => (s.id === me ? !!voice?.connected : s.inVoice);
  const voiceCount = members.filter(inVoice).length;

  return (
    <div
      className="absolute z-40 select-none rounded-lg border border-border bg-bg-2/95 shadow-xl backdrop-blur transition-shadow"
      style={{ left: pos.x, bottom: pos.y, width: open ? WIDTH : undefined }}
      role="group"
      aria-label="People"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') setHovered(false);
      }}
    >
      {open && (
        <>
          <ul className="max-h-56 overflow-y-auto px-1.5 py-1">
            {members.map((m) => (
              <li key={m.id} className="group flex items-center gap-2 rounded-sm px-1 py-1">
                <span
                  className={cn(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-black/80 transition-shadow',
                    speaking(m) && 'ring-2 ring-green',
                  )}
                  style={{ backgroundColor: m.color }}
                >
                  {(m.name || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-text">
                  {m.name}
                  {m.id === me && <span className="text-text-dim"> (you)</span>}
                </span>
                {m.isHost && (
                  <Tooltip content="Host">
                    <Crown size={11} className="shrink-0 text-warn" />
                  </Tooltip>
                )}
                {drawMutes.includes(m.id) && (
                  <Tooltip content="Drawing muted by host">
                    <PencilOff size={11} className="shrink-0 text-warn" />
                  </Tooltip>
                )}
                {inVoice(m) && (
                  <Mic
                    size={11}
                    className={cn('shrink-0', speaking(m) ? 'text-green' : 'text-text-dim')}
                  />
                )}
                {/* Personal volume for this speaker (only while you're in voice). */}
                {voice?.connected && inVoice(m) && m.id !== me && (
                  <Tooltip content={`Volume of ${m.name}`}>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      value={peerVol[m.id] ?? 1}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setPeerVol((cur) => ({ ...cur, [m.id]: v }));
                        voice.setPeerVolume(m.id, v);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="w-12 shrink-0 accent-accent"
                      aria-label={`Volume of ${m.name}`}
                    />
                  </Tooltip>
                )}
                {iAmHost && m.id !== me && (
                  // Always visible so the host can always find them (a
                  // hover-only control is invisible on touch and easy to miss).
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Tooltip
                      content={drawMutes.includes(m.id) ? 'Allow drawing' : 'Mute drawing'}
                    >
                      <button
                        type="button"
                        onClick={() => toggleDrawMute(m.id)}
                        className={cn(
                          'rounded-sm p-0.5 hover:bg-bg-4',
                          drawMutes.includes(m.id) ? 'text-warn' : 'text-text-dim hover:text-warn',
                        )}
                        aria-label={`Toggle drawing for ${m.name}`}
                      >
                        <PencilOff size={11} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Remove from board">
                      <button
                        type="button"
                        onClick={() => kick(m.id)}
                        className="rounded-sm p-0.5 text-text-dim hover:bg-bg-4 hover:text-danger"
                        aria-label={`Remove ${m.name}`}
                      >
                        <UserX size={11} />
                      </button>
                    </Tooltip>
                  </span>
                )}
              </li>
            ))}
          </ul>

          <InviteFriends />

          {voice && (
            <div className="border-t border-border p-1.5">
              {!voice.connected ? (
                <Tooltip
                  content={
                    availability === 'online' ? 'Talk while you draw' : 'Voice needs the sync server'
                  }
                >
                  <button
                    type="button"
                    disabled={availability !== 'online'}
                    onClick={() => void voice.connect()}
                    className={cn(
                      'flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium',
                      availability === 'online'
                        ? 'border-accent/50 bg-accent/15 text-accent hover:bg-accent/25'
                        : 'cursor-not-allowed border-border text-text-dim opacity-60',
                    )}
                  >
                    <Mic size={13} />
                    Join voice
                  </button>
                </Tooltip>
              ) : (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => voice.setMuted(!voice.muted)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium',
                      voice.muted
                        ? 'border-warn/50 bg-warn/15 text-warn hover:bg-warn/25'
                        : 'border-border text-text-mid hover:bg-bg-3 hover:text-text',
                    )}
                  >
                    {voice.muted ? <MicOff size={13} /> : <Mic size={13} />}
                    {voice.muted ? 'Unmute' : 'Mute'}
                  </button>
                  <Tooltip content="Leave voice">
                    <button
                      type="button"
                      onClick={() => voice.disconnect()}
                      className="flex items-center justify-center rounded-md border border-danger/40 px-2.5 text-danger hover:bg-danger/15"
                      aria-label="Leave voice"
                    >
                      <PhoneOff size={13} />
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Grip row — always visible, drag handle + compact summary. */}
      <div
        className={cn(
          'flex cursor-grab items-center gap-1.5 px-2 py-1.5 active:cursor-grabbing',
          open && 'border-t border-border',
        )}
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerUp}
      >
        <GripHorizontal size={11} className="shrink-0 text-text-dim" />
        <AvatarStack members={members} speaking={speaking} />
        <span className="whitespace-nowrap text-[11px] font-medium text-text-mid">
          {members.length}
          {voiceCount > 0 && <span className="text-green"> · {voiceCount} in voice</span>}
        </span>
        {voice?.connected && (
          <Mic size={11} className={cn(voice.muted ? 'text-warn' : 'text-green')} />
        )}
      </div>
    </div>
  );
}

function AvatarStack({
  members,
  speaking,
}: {
  members: AwarenessState[];
  speaking: (s: AwarenessState) => boolean;
}) {
  const shown = members.slice(0, 4);
  return (
    <div className="flex -space-x-1.5">
      {shown.map((m) => (
        <span
          key={m.id}
          className={cn(
            'grid h-5 w-5 place-items-center rounded-full border border-bg-2 text-[9px] font-bold text-black/80',
            speaking(m) && 'ring-1 ring-green',
          )}
          style={{ backgroundColor: m.color }}
        >
          {(m.name || '?').slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

/**
 * Invite friends to THIS board. Lists your accepted friends inside the People
 * widget (in-board, so the board name/mode are in scope); clicking one sends a
 * board_invite they'll see as a notification on Home. Renders nothing when
 * you're signed out or have no friends yet.
 */
function InviteFriends() {
  const { user } = useAccount();
  const { friends } = useFriends(user?.id);
  const board = useAppStore((s) => s.currentBoard);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  if (!user?.id || !board || friends.length === 0) return null;

  const invite = async (friendId: string, name: string) => {
    setInvited((s) => new Set(s).add(friendId));
    const r = await sendBoardInvite(user.id, friendId, board.name, board.mode);
    if (r.ok) toast({ title: 'Invite sent', description: `${name} was invited to this board` });
    else {
      toast({ title: 'Could not invite', description: r.error, variant: 'error' });
      setInvited((s) => { const n = new Set(s); n.delete(friendId); return n; });
    }
  };

  return (
    <div className="border-t border-border p-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-xs font-medium text-text-mid hover:bg-bg-3 hover:text-text"
      >
        <UserPlus size={12} />
        Invite a friend
        <span className="ml-auto text-[10px] text-text-dim">{friends.length}</span>
      </button>
      {open && (
        <ul className="mt-1 max-h-40 overflow-y-auto">
          {[...friends]
            .sort((a, b) => Number(b.online) - Number(a.online))
            .map((f) => (
              <li key={f.userId} className="flex items-center gap-2 rounded-sm px-1 py-1">
                <span className="relative shrink-0">
                  <Avatar url={f.avatarUrl} name={f.displayName} size={22} />
                  {f.online && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-green ring-2 ring-bg-2" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-text">{f.displayName || 'Anonymous'}</span>
                <button
                  type="button"
                  disabled={invited.has(f.userId)}
                  onClick={() => void invite(f.userId, f.displayName || 'Friend')}
                  className="rounded-sm p-0.5 text-text-dim hover:bg-bg-4 hover:text-accent disabled:text-green"
                  aria-label={`Invite ${f.displayName}`}
                >
                  {invited.has(f.userId) ? <Check size={12} /> : <UserPlus size={12} />}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
