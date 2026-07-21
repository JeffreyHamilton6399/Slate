/**
 * Workspace header: brand, board title, connection dot, File menu, share,
 * settings, leave. Voice + members live in the floating People widget.
 */

import { useEffect, useRef, useState } from 'react';
import { Menu, Settings, Share2, LogOut, WifiOff, FileText } from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/DropdownMenu';
import { useAppStore } from './store';
import { useServerStatus } from '../sync/serverStatus';
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
  | 'new'
  | 'save'
  | 'save-as'
  | 'open'
  | 'export'
  | 'import'
  | 'print'
  | 'background'
  | 'board-settings'
  | 'shortcuts'
  | 'install';

export function Header({ status, awareness, onLeave, onFileMenu }: HeaderProps) {
  const board = useAppStore((s) => s.currentBoard);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setMobileDrawer = useDockStore((s) => s.setMobileDrawer);
  const isMobile = useIsMobile();
  void awareness;

  // Surface only *sustained* connection changes as toasts. Routine WebSocket
  // re-syncs blip disconnected→connecting→connected within a second; toasting
  // each blip spams "Connection lost / Back online". We debounce: a drop must
  // hold ~3s before we announce it, and we only announce recovery if we had
  // actually announced the drop.
  const lastToastedRef = useRef<'up' | 'down'>('up');
  useEffect(() => {
    if (status === 'connected') {
      if (lastToastedRef.current === 'down') {
        lastToastedRef.current = 'up';
        toast({ title: 'Back online', description: 'Live sync restored.' });
      }
      return;
    }
    if (status === 'disconnected' || status === 'error') {
      const t = setTimeout(() => {
        if (lastToastedRef.current !== 'down') {
          lastToastedRef.current = 'down';
          toast({ title: 'Connection lost', description: 'Reconnecting…', variant: 'error' });
        }
      }, 3000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [status]);

  return (
    <header
      className="flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-border bg-bg-2 px-3"
      style={{ paddingTop: 'var(--safe-top, 0px)' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <BrandMark />
        {/* Always-visible board title — compact on phones (truncate at ~120px)
            so the user knows which board/mode they're in even on a 375px screen. */}
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="max-w-[120px] truncate text-xs font-medium text-text sm:max-w-[260px] sm:text-sm">
            {board?.name ?? 'Slate'}
          </span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-text-dim sm:text-[10px]">
            {board?.mode === '3d' ? '3D Editor' : board?.mode === 'audio' ? 'Audio Studio' : board?.mode === 'doc' ? 'Doc Editor' : board?.mode === 'code' ? 'Code Editor' : '2D Whiteboard'}
          </span>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="ml-1 gap-1 px-2 py-1">
            <FileText size={13} />
            <span>File</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {/* Project */}
          <DropdownMenuItem onSelect={() => onFileMenu('new')}>New project…</DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Save / Open */}
          <DropdownMenuItem onSelect={() => onFileMenu('save')} shortcut="Ctrl+S">
            Save
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('save-as')} shortcut="Ctrl+Shift+S">
            Save as…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('open')}>Open…</DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Import / Export / Print / Background */}
          <DropdownMenuItem onSelect={() => onFileMenu('import')}>Import…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('export')}>Export…</DropdownMenuItem>
          {board?.mode !== '3d' && board?.mode !== 'audio' && (
            <DropdownMenuItem onSelect={() => onFileMenu('print')} shortcut="Ctrl+P">
              Print
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => onFileMenu('background')}>Background…</DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Board / Help / Install */}
          <DropdownMenuItem onSelect={() => onFileMenu('board-settings')}>
            Board settings…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('shortcuts')} shortcut="?">
            Keyboard shortcuts
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFileMenu('install')}>Install app…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      {/* Right cluster — ConnectionPill (only when not connected), Share,
          Settings, Leave. Wraps in overflow-x-auto so a very narrow phone
          can scroll the cluster instead of pushing layout off-screen. */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {/* Only surfaces when something needs attention; a healthy connection
            shows nothing (transitions arrive as toasts). */}
        <ConnectionPill status={status} />

        {/* Share collapses to an icon — the tooltip and toast carry the intent. */}
        <Tooltip content="Copy an invite link to this board">
          <Button
            variant="icon"
            size="none"
            onClick={() => shareBoard(board)}
            aria-label="Share board"
            className="shrink-0 text-accent hover:bg-accent/10"
          >
            <Share2 size={15} />
          </Button>
        </Tooltip>

        {/* Desktop-only divider between Share and the app cluster. */}
        <HeaderDivider />

        {/* App cluster: panels (mobile) · settings · leave */}
        {isMobile && (
          <Tooltip content="Panels">
            <Button
              variant="icon"
              size="none"
              onClick={() => setMobileDrawer(true)}
              aria-label="Panels"
              className="shrink-0"
            >
              <Menu size={16} />
            </Button>
          </Tooltip>
        )}
        <Tooltip content="Settings">
          <Button
            variant="icon"
            size="none"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            className="shrink-0"
          >
            <Settings size={16} />
          </Button>
        </Tooltip>
        <Tooltip content="Leave board">
          <Button
            variant="icon"
            size="none"
            onClick={onLeave}
            aria-label="Leave board"
            className="shrink-0 text-text-dim hover:text-danger"
          >
            <LogOut size={16} />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

function HeaderDivider() {
  return <div className="mx-1.5 hidden h-5 w-px bg-border sm:block" aria-hidden />;
}

function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const availability = useServerStatus((s) => s.availability);

  // Debounce a non-connected status: WebSocket sync naturally blips through
  // 'connecting' during routine re-syncs, and rendering that instantly makes
  // the header flap "Connecting" on and off. Only surface a problem state once
  // it has persisted ~2.5s; a connection that recovers before then shows
  // nothing. 'none' (no server) is a settled verdict, so it shows immediately.
  const unstable = status !== 'connected' && availability !== 'none';
  const [showUnstable, setShowUnstable] = useState(false);
  useEffect(() => {
    if (!unstable) {
      setShowUnstable(false);
      return;
    }
    const t = setTimeout(() => setShowUnstable(true), 2500);
    return () => clearTimeout(t);
  }, [unstable, status, availability]);

  // No sync server on this deployment: the board is local-only by design,
  // not broken — show a calm LOCAL badge instead of an error state.
  if (availability === 'none' && status !== 'connected') {
    return (
      <Tooltip content="No sync server configured — changes stay on this device.">
        <div
          className="flex items-center gap-1.5 rounded-full border border-border bg-bg-3 px-2 py-0.5 text-xs font-mono uppercase tracking-wider text-text-mid"
          role="status"
        >
          <WifiOff size={11} />
          <span>Local</span>
        </div>
      </Tooltip>
    );
  }
  // Healthy connection (or a blip that recovered quickly): show nothing.
  // Connect/disconnect transitions arrive as toasts, so a persistent
  // indicator is just noise.
  if (status === 'connected' || !showUnstable) return null;
  const waking = availability === 'waking' || availability === 'probing';
  const label =
    waking ? 'Waking…' :
    status === 'connecting' ? 'Connecting' :
    status === 'disconnected' ? 'Offline' :
    'Error';
  const color =
    status === 'connecting' || waking
      ? 'bg-warn/15 text-warn border-warn/30'
      : 'bg-danger/15 text-danger border-danger/30';
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-mono uppercase tracking-wider ${color}`}
      role="status"
    >
      <WifiOff size={11} />
      <span>{label}</span>
    </div>
  );
}

function BrandMark() {
  // SVG sized via Tailwind classes so the mark shrinks on a narrow phone
  // (18px) and returns to its full 22px on the sm breakpoint and up.
  return (
    <svg
      viewBox="0 0 32 32"
      aria-label="Slate"
      className="h-[18px] w-[18px] shrink-0 sm:h-[22px] sm:w-[22px]"
    >
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

function shareBoard(board: { name: string; mode: string } | null | undefined) {
  if (!board?.name) return;
  const url = `${location.origin}/?board=${encodeURIComponent(board.name)}&mode=${board.mode}`;
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

