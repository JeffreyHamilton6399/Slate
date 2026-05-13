/**
 * Workspace — the main board surface after onboarding.
 *
 * Layout: header on top; main area is left dock | central viewport | right dock.
 * On mobile both docks collapse into a bottom drawer.
 *
 * The central viewport switches between 2D canvas and 3D viewport based on
 * `currentBoard.mode`. Panels register themselves into the dock via the
 * panel registry; this component owns nothing about specific panel content.
 */

import { useEffect, useMemo, useState } from 'react';
import { Dock } from '../workspace/Dock';
import { MobileDrawer } from '../workspace/MobileDrawer';
import { useDockStore } from '../workspace/dockStore';
import { useIsMobile } from '../workspace/useMediaQuery';
import { usePanelRegistry } from '../workspace/panelRegistry';
import { useAppStore } from './store';
import { Header, type FileMenuAction } from './Header';
import { SettingsDialog } from './Settings';
import { useSlateRoom } from '../sync/useSlateRoom';
import { initMetaIfEmpty } from '../sync/doc';
import { RoomProvider } from '../sync/RoomContext';
import { Canvas2D } from '../canvas2d/Canvas2D';
import { Viewport3D } from '../viewport3d/Viewport3D';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { toast } from '../ui/Toast';
import { ExportDialog } from '../files/ExportDialog';
import { ImportDialog } from '../files/ImportDialog';
import { SaveOpenDialog } from '../files/SaveOpenDialog';
import { BackgroundDialog } from '../files/BackgroundDialog';
import { persistSave, snapshotDoc } from '../files/snapshot';
import { useAutosave } from '../files/useAutosave';
import { VoiceProvider } from '../voice/VoiceProvider';

export function Workspace() {
  const board = useAppStore((s) => s.currentBoard)!;
  const displayName = useAppStore((s) => s.displayName);
  const leaveBoard = useAppStore((s) => s.leaveBoard);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const setShortcutsOpen = useAppStore((s) => s.setShortcutsOpen);

  const sidebarWidth = useDockStore((s) => s.sidebarWidth);
  const dockWidth = useDockStore((s) => s.dockWidth);
  const setSidebarWidth = useDockStore((s) => s.setSidebarWidth);
  const setDockWidth = useDockStore((s) => s.setDockWidth);
  const ensureTab = useDockStore((s) => s.ensureTab);
  const isMobile = useIsMobile();

  const { room, status, awareness } = useSlateRoom(board.name, displayName);
  const autosave = useAutosave(room);

  // On first open, push default tabs based on mode + register fresh panels.
  const panels = usePanelRegistry((s) => s.panels);
  useEffect(() => {
    Object.values(panels).forEach((p) => {
      if (p.mode && p.mode !== 'both' && p.mode !== board.mode) return;
      ensureTab(p.defaultSide, p.id);
    });
  }, [panels, board.mode, ensureTab]);

  // Initialize meta if this is the creator on a fresh board.
  useEffect(() => {
    if (!room) return;
    if (!board.iAmCreator) return;
    initMetaIfEmpty(room.slate, {
      createdBy: room.identity.peerId,
      createdAt: board.joinedAt,
      name: board.name,
      topic: '',
      visibility: board.visibility,
      mode: board.mode,
      paper: '#0c0c0e',
      hostId: room.identity.peerId,
    });
  }, [room, board]);

  // Reflect host status in awareness.
  useEffect(() => {
    if (!room) return;
    const meta = room.slate.meta();
    const apply = () => {
      const hostId = meta.get('hostId') as string | undefined;
      room.setLocalAwareness({ isHost: hostId === room.identity.peerId });
    };
    apply();
    meta.observe(apply);
    return () => meta.unobserve(apply);
  }, [room]);

  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [saveDialog, setSaveDialog] = useState<'save-as' | 'open' | null>(null);
  const [bgOpen, setBgOpen] = useState(false);

  // File-menu keyboard shortcuts (Ctrl+S / Shift+Ctrl+S / Ctrl+O / Ctrl+P / `?`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const k = e.key.toLowerCase();
      if (k === 's' && e.shiftKey) {
        e.preventDefault();
        setSaveDialog('save-as');
      } else if (k === 's') {
        e.preventDefault();
        if (room) persistSave(snapshotDoc(room));
        toast({ title: 'Saved' });
      } else if (k === 'o') {
        e.preventDefault();
        setSaveDialog('open');
      } else if (k === 'p') {
        e.preventDefault();
        window.print();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [room, setShortcutsOpen]);

  const handleFileMenu = useMemo(
    () => (action: FileMenuAction) => {
      switch (action) {
        case 'save':
          if (!room) return;
          persistSave(snapshotDoc(room));
          toast({ title: 'Saved' });
          break;
        case 'save-as':
          setSaveDialog('save-as');
          break;
        case 'open':
          setSaveDialog('open');
          break;
        case 'export':
          setExportOpen(true);
          break;
        case 'import':
          setImportOpen(true);
          break;
        case 'background':
          setBgOpen(true);
          break;
        case 'print':
          window.print();
          break;
        case 'shortcuts':
          setShortcutsOpen(true);
          break;
        case 'install':
          toast({
            title: 'Install Slate',
            description:
              'Use your browser menu → "Install app" / "Add to Home Screen". Slate works fully offline once installed.',
          });
          break;
      }
    },
    [setShortcutsOpen, room],
  );

  if (!room) {
    return (
      <div className="flex h-full w-full flex-col bg-bg text-text">
        <Header
          status={status}
          awareness={awareness}
          onLeave={leaveBoard}
          onFileMenu={handleFileMenu}
        />
        <LoadingBoard />
      </div>
    );
  }

  return (
    <RoomProvider room={room}>
      <VoiceProvider>
      <div className="flex h-full w-full flex-col bg-bg text-text">
        <Header
          status={status}
          awareness={awareness}
          onLeave={leaveBoard}
          onFileMenu={handleFileMenu}
        />
        <div className="flex flex-1 min-h-0">
          {!isMobile && (
            <Dock side="left" width={sidebarWidth} onResize={setSidebarWidth} />
          )}
          <main className="relative flex-1 min-w-0">
            {board.mode === '3d' ? <Viewport3D room={room} /> : <Canvas2D room={room} />}
          </main>
          {!isMobile && (
            <Dock side="right" width={dockWidth} onResize={setDockWidth} />
          )}
        </div>
        {isMobile && <MobileDrawer />}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
        <SaveOpenDialog mode={saveDialog} onClose={() => setSaveDialog(null)} />
        <BackgroundDialog open={bgOpen} onOpenChange={setBgOpen} />
        <AutosaveBadge state={autosave} />
      </div>
      </VoiceProvider>
    </RoomProvider>
  );
}

function AutosaveBadge({ state }: { state: ReturnType<typeof useAutosave> }) {
  if (!state.savedAt && !state.dirty) return null;
  const ago = state.savedAt
    ? Math.max(0, Math.round((Date.now() - state.savedAt) / 1000))
    : null;
  return (
    <div
      className="pointer-events-none fixed bottom-2 left-2 z-30 rounded-md border border-border bg-bg-2/90 backdrop-blur px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-dim"
      role="status"
    >
      {state.dirty ? 'Saving…' : `Saved ${formatAgo(ago)}`}
    </div>
  );
}

function formatAgo(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function LoadingBoard() {
  return (
    <div className="grid h-full place-items-center text-text-dim text-sm">
      <span>Connecting to board…</span>
    </div>
  );
}
