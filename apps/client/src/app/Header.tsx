/**
 * Workspace header: brand, board title + topic, connection pill, member
 * count, File menu, settings, leave.
 */

import { useEffect } from 'react';
import {
  Menu,
  Settings,
  Users,
  Share2,
  LogOut,
  MessageSquare,
  StickyNote,
  Wifi,
  WifiOff,
  Mic,
  MicOff,
  PhoneOff,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { useVoiceOptional } from '../voice/useVoiceOptional';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/DropdownMenu';
import { useAppStore } from './store';
import { useDockStore } from '../workspace/dockStore';
import { useIsMobile } from '../workspace/useMediaQuery';
import type { ConnectionStatus } from '../sync/provider';
import type { AwarenessState } from '@slate/sync-protocol';
import { toast } from '../ui/Toast';

interface HeaderProps {
  status: ConnectionStatus;
  awareness: AwarenessState[];
  onLeave: () => void;
  onFileMenu: (action: FileMenuAction) => void;
}

export type FileMenuAction =
  | 'save'
  | 'save-as'
  | 'open'
  | 'export'
  | 'import'
  | 'print'
  | 'background'
  | 'shortcuts'
  | 'install';

export function Header({ status, awareness, onLeave, onFileMenu }: HeaderProps) {
  const board = useAppStore((s) => s.currentBoard);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setMobileDrawer = useDockStore((s) => s.setMobileDrawer);
  const isMobile = useIsMobile();

  const memberCount = awareness.length;

  return (
    <header
      className="flex h-[var(--header-h)] shrink-0 items-center gap-3 border-b border-border bg-bg-2 px-3"
      style={{ paddingTop: 'var(--safe-top, 0px)' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <BrandMark />
        <div className="hidden sm:flex flex-col leading-tight min-w-0">
          <span className="text-sm font-semibold truncate max-w-[260px]">
            {board?.name ?? 'Slate'}
          </span>
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-dim">
            {board?.mode === '3d' ? '3D Editor' : '2D Whiteboard'}
          </span>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="ml-1">
            File
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => onFileMenu('save')} shortcut="Ctrl+S">
            Save
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('save-as')} shortcut="Ctrl+Shift+S">
            Save as…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('open')}>Open…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onFileMenu('import')}>Import…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('export')}>Export…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onFileMenu('background')}>Background…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('print')} shortcut="Ctrl+P">
            Print
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onFileMenu('shortcuts')} shortcut="?">
            Keyboard shortcuts
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('install')}>Install app…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <ConnectionPill status={status} />

      <VoiceButton />

      <Tooltip content="Share">
        <Button variant="icon" size="none" onClick={() => shareBoard(board?.name)}>
          <Share2 size={16} />
        </Button>
      </Tooltip>

      {isMobile ? (
        <>
          <Tooltip content="Chat">
            <Button variant="icon" size="none" onClick={() => setMobileDrawer(true, 'chat')}>
              <MessageSquare size={16} />
            </Button>
          </Tooltip>
          <Tooltip content="Notes">
            <Button variant="icon" size="none" onClick={() => setMobileDrawer(true, 'notes')}>
              <StickyNote size={16} />
            </Button>
          </Tooltip>
        </>
      ) : null}

      <Tooltip content={`${memberCount} member${memberCount === 1 ? '' : 's'}`}>
        <Button
          variant="icon"
          size="none"
          onClick={() => setMobileDrawer(true, 'members')}
          className="flex items-center gap-1 px-1.5"
        >
          <Users size={16} />
          <span className="text-xs font-mono">{memberCount}</span>
        </Button>
      </Tooltip>

      <Tooltip content="Settings">
        <Button variant="icon" size="none" onClick={() => setSettingsOpen(true)}>
          <Settings size={16} />
        </Button>
      </Tooltip>

      <Tooltip content="Leave board">
        <Button variant="icon" size="none" onClick={onLeave}>
          <LogOut size={16} />
        </Button>
      </Tooltip>

      {isMobile && (
        <Tooltip content="Panels">
          <Button variant="icon" size="none" onClick={() => setMobileDrawer(true)}>
            <Menu size={16} />
          </Button>
        </Tooltip>
      )}
    </header>
  );
}

function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const label =
    status === 'connected' ? 'Online' :
    status === 'connecting' ? 'Connecting' :
    status === 'disconnected' ? 'Offline' :
    'Error';
  const color =
    status === 'connected' ? 'bg-green/15 text-green border-green/30' :
    status === 'connecting' ? 'bg-warn/15 text-warn border-warn/30' :
    'bg-danger/15 text-danger border-danger/30';
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-mono uppercase tracking-wider ${color}`}
      role="status"
    >
      {status === 'connected' ? <Wifi size={11} /> : <WifiOff size={11} />}
      <span>{label}</span>
    </div>
  );
}

function VoiceButton() {
  const voice = useVoiceOptional();
  if (!voice) return null;
  if (!voice.connected) {
    return (
      <Tooltip content="Join voice chat">
        <Button variant="icon" size="none" onClick={() => void voice.connect()} aria-label="Join voice">
          <MicOff size={16} />
        </Button>
      </Tooltip>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Tooltip content={voice.muted ? 'Unmute' : 'Mute'}>
        <Button
          variant="icon"
          size="none"
          onClick={() => voice.setMuted(!voice.muted)}
          aria-label={voice.muted ? 'Unmute' : 'Mute'}
        >
          {voice.muted ? <MicOff size={16} className="text-warn" /> : <Mic size={16} className="text-green" />}
        </Button>
      </Tooltip>
      <Tooltip content="Leave voice">
        <Button
          variant="icon"
          size="none"
          onClick={() => voice.disconnect()}
          aria-label="Leave voice"
        >
          <PhoneOff size={16} className="text-danger" />
        </Button>
      </Tooltip>
    </div>
  );
}

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-label="Slate">
      <rect width="32" height="32" rx="7" fill="#0c0c0e" />
      <rect x="3" y="3" width="26" height="26" rx="4" fill="none" stroke="#7c6aff" strokeWidth="1.8" />
      <path
        d="M20 8l4 4-10 10-4.5 1 1-4.5z"
        fill="none"
        stroke="#7c6aff"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function shareBoard(name: string | undefined) {
  if (!name) return;
  const url = `${location.origin}/?board=${encodeURIComponent(name)}`;
  if (navigator.share) {
    navigator
      .share({ title: 'Slate board', url })
      .catch(() => navigator.clipboard.writeText(url).then(() => toast({ title: 'Link copied' })));
  } else {
    navigator.clipboard.writeText(url).then(
      () => toast({ title: 'Link copied' }),
      () => toast({ title: 'Copy failed', variant: 'error' }),
    );
  }
}

// Mark the hook as used in case linter is too eager.
void useEffect;
