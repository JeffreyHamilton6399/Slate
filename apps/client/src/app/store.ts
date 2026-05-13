/**
 * App-level state: which board the user is in, current mode (2d/3d),
 * onboarding status, and shared UI flags. Persisted in localStorage so a
 * refresh restores the last board.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DocMode } from '@slate/sync-protocol';

export interface JoinedBoard {
  name: string;
  mode: DocMode;
  visibility: 'public' | 'private';
  /** Whether THIS browser is the original creator (permanent host). */
  iAmCreator: boolean;
  joinedAt: number;
}

interface AppState {
  /** Latest display name chosen in onboarding. */
  displayName: string;
  /** Current board, or null if user is on the boards list. */
  currentBoard: JoinedBoard | null;
  /** UI flag for command palette / overlays. */
  shortcutsOpen: boolean;
  /** UI flag for settings modal. */
  settingsOpen: boolean;
  /** PWA install prompt event captured. */
  pwaInstallable: boolean;

  setDisplayName: (n: string) => void;
  enterBoard: (b: JoinedBoard) => void;
  leaveBoard: () => void;
  setShortcutsOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setPwaInstallable: (v: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      displayName: '',
      currentBoard: null,
      shortcutsOpen: false,
      settingsOpen: false,
      pwaInstallable: false,
      setDisplayName: (displayName) => set({ displayName }),
      enterBoard: (currentBoard) => set({ currentBoard }),
      leaveBoard: () => set({ currentBoard: null }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setPwaInstallable: (pwaInstallable) => set({ pwaInstallable }),
    }),
    {
      name: 'slate.app.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        displayName: s.displayName,
        currentBoard: s.currentBoard,
      }),
    },
  ),
);
