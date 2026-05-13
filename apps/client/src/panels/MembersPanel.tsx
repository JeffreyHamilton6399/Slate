/**
 * MembersPanel — live list of awareness states with host indicator and
 * per-member actions (host-only: draw-mute, kick, transfer host).
 *
 * Host actions write a small claim to `meta`:
 *   - meta.hostId       — the peer id currently acting as host
 *   - meta.drawMutes    — array of peer ids the host has draw-muted
 *   - meta.kicks        — array of peer ids the host has kicked. Clients
 *                         that find their id in this list leave the board.
 *
 * Anyone can read these but only the current host's writes are honored at
 * the UI level (server-side ACL is enforced in a future phase via signed
 * host claims; for now host = creator unless transferred).
 */
import { Crown, Mic, MicOff, MoreHorizontal, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRoom } from '../sync/RoomContext';
import { colorForPeerId, type AwarenessState } from '@slate/sync-protocol';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/DropdownMenu';
import { Button } from '../ui/Button';
import { useAppStore } from '../app/store';
import { toast } from '../ui/Toast';

export function MembersPanel() {
  const room = useRoom();
  const [members, setMembers] = useState<AwarenessState[]>(() => room.awarenessStates());
  const [drawMutes, setDrawMutes] = useState<string[]>([]);
  const [kicks, setKicks] = useState<string[]>([]);
  const leaveBoard = useAppStore((s) => s.leaveBoard);

  useEffect(() => {
    return room.onAwarenessChange(setMembers);
  }, [room]);

  useEffect(() => {
    const meta = room.slate.meta();
    const update = () => {
      setDrawMutes((meta.get('drawMutes') as string[] | undefined) ?? []);
      setKicks((meta.get('kicks') as string[] | undefined) ?? []);
    };
    update();
    meta.observe(update);
    return () => meta.unobserve(update);
  }, [room]);

  // Self-eject if the host kicked me.
  useEffect(() => {
    if (kicks.includes(room.identity.peerId)) {
      toast({ title: 'You were removed from the board', variant: 'error' });
      leaveBoard();
    }
  }, [kicks, room.identity.peerId, leaveBoard]);

  const me = members.find((m) => m.id === room.identity.peerId);
  const others = members.filter((m) => m.id !== room.identity.peerId);
  const iAmHost = !!me?.isHost;

  const transferHost = (peerId: string) => {
    const meta = room.slate.meta();
    meta.set('hostId', peerId);
    toast({ title: 'Host transferred' });
  };
  const toggleDrawMute = (peerId: string) => {
    const meta = room.slate.meta();
    const cur = (meta.get('drawMutes') as string[] | undefined) ?? [];
    const next = cur.includes(peerId) ? cur.filter((x) => x !== peerId) : [...cur, peerId];
    meta.set('drawMutes', next);
  };
  const kick = (peerId: string) => {
    if (!window.confirm('Remove this member from the board?')) return;
    const meta = room.slate.meta();
    const cur = (meta.get('kicks') as string[] | undefined) ?? [];
    if (!cur.includes(peerId)) meta.set('kicks', [...cur, peerId]);
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <h4 className="panel-title mb-2">You</h4>
        {me ? (
          <MemberRow
            m={me}
            self
            drawMuted={drawMutes.includes(me.id)}
          />
        ) : (
          <p className="text-xs text-text-dim">Joining…</p>
        )}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <h4 className="panel-title mb-2">Others ({others.length})</h4>
        <ul className="flex-1 overflow-y-auto flex flex-col gap-1">
          {others.map((m) => (
            <li key={m.id}>
              <MemberRow
                m={m}
                hostControls={iAmHost}
                drawMuted={drawMutes.includes(m.id)}
                onTransferHost={() => transferHost(m.id)}
                onToggleDrawMute={() => toggleDrawMute(m.id)}
                onKick={() => kick(m.id)}
              />
            </li>
          ))}
          {others.length === 0 && (
            <li className="text-xs text-text-dim text-center pt-4">
              You&apos;re alone. Share the link to invite people.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function MemberRow({
  m,
  self,
  hostControls,
  drawMuted,
  onTransferHost,
  onToggleDrawMute,
  onKick,
}: {
  m: AwarenessState;
  self?: boolean;
  hostControls?: boolean;
  drawMuted?: boolean;
  onTransferHost?: () => void;
  onToggleDrawMute?: () => void;
  onKick?: () => void;
}) {
  const color = m.color || colorForPeerId(m.id);
  return (
    <div className="flex items-center gap-2 rounded-sm bg-bg-3 px-2 py-1.5">
      <span
        className="inline-block size-2.5 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      <span className="flex-1 truncate text-sm text-text">{m.name}</span>
      {drawMuted && (
        <span className="text-warn" title="Drawing muted by host">
          <VolumeX size={12} />
        </span>
      )}
      {m.isHost && (
        <span className="text-warn" title="Host">
          <Crown size={12} />
        </span>
      )}
      {m.voiceLevel > 0.05 ? (
        <Mic size={12} className="text-green" />
      ) : (
        <MicOff size={12} className="text-text-dim opacity-40" />
      )}
      {!self && hostControls && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="icon" size="none" aria-label="Member actions">
              <MoreHorizontal size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onToggleDrawMute}>
              {drawMuted ? <Volume2 size={12} /> : <VolumeX size={12} />}
              <span className="ml-2">{drawMuted ? 'Allow drawing' : 'Mute drawing'}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTransferHost}>
              <Crown size={12} />
              <span className="ml-2">Make host</span>
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={onKick}>
              Kick from board
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
