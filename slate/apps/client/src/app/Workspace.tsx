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
import { FloatingPanels } from '../workspace/FloatingPanels';
import { MobileDrawer } from '../workspace/MobileDrawer';
import { useDockStore } from '../workspace/dockStore';
import { useIsMobile } from '../workspace/useMediaQuery';
import { usePanelRegistry } from '../workspace/panelRegistry';
import { useAppStore } from './store';
import { Header, type FileMenuAction } from './Header';
import { SettingsDialog } from './Settings';
import { BoardSettingsDialog } from './BoardSettings';
import { NewProjectDialog } from './NewProjectDialog';
import { useSlateRoom } from '../sync/useSlateRoom';
import { initMetaIfEmpty } from '../sync/doc';
import { RoomProvider } from '../sync/RoomContext';
import { Canvas2D } from '../canvas2d/Canvas2D';
import { Viewport3D } from '../viewport3d/Viewport3D';
import { AudioEditor } from '../audio/AudioEditor';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { toast } from '../ui/Toast';
import { ExportDialog } from '../files/ExportDialog';
import { ImportDialog } from '../files/ImportDialog';
import { SaveOpenDialog } from '../files/SaveOpenDialog';
import { BackgroundDialog } from '../files/BackgroundDialog';
import { manualSlotId, persistSave, snapshotDoc } from '../files/snapshot';
import { useAutosave } from '../files/useAutosave';
import { VoiceProvider } from '../voice/VoiceProvider';
import { PeopleWidget } from './PeopleWidget';

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
      // New boards start with paper matching the creator's app theme; the
      // Board background dialog changes it (synced) afterwards.
      paper: useAppStore.getState().theme === 'light' ? '#f6f5f0' : '#0c0c0e',
      hostId: room.identity.peerId,
    });
  }, [room, board]);

  // Honor the host's kick list: if our peer id appears, leave the board.
  useEffect(() => {
    if (!room) return;
    const meta = room.slate.meta();
    const check = () => {
      const kicked = (meta.get('kicked') as string[] | undefined) ?? [];
      if (kicked.includes(room.identity.peerId)) {
        toast({
          title: 'Removed from board',
          description: 'The host removed you from this board.',
          variant: 'error',
        });
        leaveBoard();
      }
    };
    check();
    meta.observe(check);
    return () => meta.unobserve(check);
  }, [room, leaveBoard]);

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

  // Browser back/forward (incl. mouse gestures like RMB-swipe-left in Opera,
  // and mouse thumb buttons) must never yank the user out of an open board —
  // it reads as "the page closed". Swallow history pops while a board is open;
  // leaving is always explicit via the header button.
  useEffect(() => {
    window.history.pushState({ slate: 'board' }, '');
    const onPop = () => {
      if (useAppStore.getState().currentBoard) {
        window.history.pushState({ slate: 'board' }, '');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [saveDialog, setSaveDialog] = useState<'save-as' | 'open' | null>(null);
  const bgOpen = useAppStore((s) => s.backgroundOpen);
  const setBgOpen = useAppStore((s) => s.setBackgroundOpen);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);

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
        if (room) {
          const snap = snapshotDoc(room);
          persistSave(snap, `${snap.boardName} (saved)`, manualSlotId(snap.boardName));
          toast({ title: 'Saved', description: 'Overwrites your previous save — use Save as… for a copy.' });
        }
      } else if (k === 'o') {
        e.preventDefault();
        setSaveDialog('open');
      } else if (k === 'p' && board.mode !== '3d') {
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
        case 'new':
          setNewProjectOpen(true);
          break;
        case 'save': {
          if (!room) return;
          const snap = snapshotDoc(room);
          persistSave(snap, `${snap.boardName} (saved)`, manualSlotId(snap.boardName));
          toast({ title: 'Saved', description: 'Overwrites your previous save — use Save as… for a copy.' });
          break;
        }
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
        case 'board-settings':
          setBoardSettingsOpen(true);
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
            {board.mode === '3d' ? (
              <Viewport3D room={room} />
            ) : board.mode === 'audio' ? (
              <AudioEditor />
            ) : (
              <Canvas2D room={room} />
            )}
            <PeopleWidget awareness={awareness} room={room} />
          </main>
          {!isMobile && (
            <Dock side="right" width={dockWidth} onResize={setDockWidth} />
          )}
        </div>
        {!isMobile && <FloatingPanels />}
        {isMobile && <MobileDrawer />}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
        <SaveOpenDialog mode={saveDialog} onClose={() => setSaveDialog(null)} />
        <BackgroundDialog open={bgOpen} onOpenChange={setBgOpen} />
        <BoardSettingsDialog open={boardSettingsOpen} onOpenChange={setBoardSettingsOpen} />
        <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
        <AutosaveBadge state={autosave} />
      </div>
      </VoiceProvider>
    </RoomProvider>
  );
}

const SAVED_FLASH_MS = 2000;

/** Shows "Saving…" while dirty, flashes "Saved" briefly, then disappears. */
function AutosaveBadge({ state }: { state: ReturnType<typeof useAutosave> }) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (state.dirty || !state.savedAt) return;
    // Re-render once after the flash window so the badge unmounts.
    const t = setTimeout(() => bump((x) => x + 1), SAVED_FLASH_MS + 100);
    return () => clearTimeout(t);
  }, [state.dirty, state.savedAt]);

  const flashing = !!state.savedAt && Date.now() - state.savedAt < SAVED_FLASH_MS;
  if (!state.dirty && !flashing) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-md border border-border bg-bg-2/90 backdrop-blur px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-dim sm:bottom-12"
      role="status"
    >
      {state.dirty ? 'Saving…' : 'Saved ✓'}
    </div>
  );
}

function LoadingBoard() {
  return (
    <div className="grid h-full place-items-center text-text-dim text-sm">
      <span>Connecting to board…</span>
    </div>
  );
}
