/**
 * App root: chooses Onboarding vs Workspace based on app store. Mounts
 * global providers (toast, tooltip) and registers built-in panels.
 */

import { useEffect } from 'react';
import { Entry } from './Home';
import { Workspace } from './Workspace';
import { useAppStore } from './store';
import { ToastProvider } from '../ui/Toast';
import { TooltipProvider } from '../ui/Tooltip';
import { registerBuiltInPanels } from '../panels/registerBuiltInPanels';
import { InstallPrompt } from './InstallPrompt';
import { ServerWakeGate } from './ServerWakeGate';
import { useAccount } from '../account/useAccount';
import { startCloudSaveBridge } from '../account/cloudSaves';
import { usePresence } from '../account/useBoardInvites';
import { BoardInviteNotifications } from './BoardInviteNotifications';
import { sanitizeBoardName } from './Onboarding';
import { fetchRooms } from '../sync/rooms';

registerBuiltInPanels();

export function App() {
  const board = useAppStore((s) => s.currentBoard);
  const setPwaInstallable = useAppStore((s) => s.setPwaInstallable);
  const theme = useAppStore((s) => s.theme);
  const accent = useAppStore((s) => s.accent);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Custom accent: override the token vars (and derived glow) app-wide.
  useEffect(() => {
    const root = document.documentElement.style;
    if (!/^#[0-9a-fA-F]{6}$/.test(accent) || accent.toLowerCase() === '#7c6aff') {
      root.removeProperty('--accent');
      root.removeProperty('--accent-2');
      root.removeProperty('--accent-glow');
      return;
    }
    const r = parseInt(accent.slice(1, 3), 16);
    const g = parseInt(accent.slice(3, 5), 16);
    const b = parseInt(accent.slice(5, 7), 16);
    root.setProperty('--accent', accent);
    root.setProperty('--accent-2', accent);
    root.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.15)`);
  }, [accent]);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = e;
      setPwaInstallable(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [setPwaInstallable]);

  // Honor a share link (?board=…) even when a different board is already
  // persisted. Without this, opening a colleague's link while you're inside
  // your own board silently keeps you where you were. The signed-out / Home
  // cases are handled in Home/Onboarding; here we only switch when already
  // past the entry gate (a board is open) and the link names a different one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkBoard = sanitizeBoardName(params.get('board') ?? '');
    if (!linkBoard) return;
    const cur = useAppStore.getState().currentBoard;
    if (!cur || cur.name === linkBoard) return;
    const rawMode = params.get('mode');
    const linkMode = rawMode === '3d' ? '3d' : rawMode === '2d' ? '2d' : rawMode === 'audio' ? 'audio' : null;
    window.history.replaceState(null, '', window.location.pathname);
    fetchRooms()
      .then((rooms) => {
        const found = rooms.find((r) => r.name === linkBoard);
        useAppStore.getState().enterBoard({
          name: linkBoard,
          mode: linkMode ?? found?.mode ?? '2d',
          visibility: found?.visibility ?? 'public',
          iAmCreator: !found,
          joinedAt: Date.now(),
        });
      })
      .catch(() => {
        useAppStore.getState().enterBoard({
          name: linkBoard,
          mode: linkMode ?? '2d',
          visibility: 'public',
          iAmCreator: true,
          joinedAt: Date.now(),
        });
      });
    // Mount-only: the link is consumed once and the URL cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TooltipProvider>
      <ToastProvider>
        <ServerWakeGate>
          {board ? <Workspace /> : <Entry />}
        </ServerWakeGate>
        <CloudSaveBridge />
        <PresenceBridge />
        <BoardInviteNotifications />
        <InstallPrompt />
      </ToastProvider>
    </TooltipProvider>
  );
}

/** While signed in, every save write is mirrored to the account's cloud. */
function CloudSaveBridge() {
  const { user } = useAccount();
  useEffect(() => {
    if (!user) return;
    return startCloudSaveBridge(user.id);
  }, [user]);
  return null;
}

/** Heartbeat the presence timestamp app-wide (on Home AND inside a board) so
 *  friends see us online while we're active — gated by the "show online"
 *  setting. Mounted at the root so it survives entering/leaving boards. */
function PresenceBridge() {
  const { user } = useAccount();
  const showOnline = useAppStore((s) => s.showOnline);
  usePresence(user?.id, showOnline);
  return null;
}
