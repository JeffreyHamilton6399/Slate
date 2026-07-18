/**
 * App-level state: which board the user is in, current mode (2d/3d),
 * onboarding status, and shared UI flags. Persisted in localStorage so a
 * refresh restores the last board.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DocMode } from '@slate/sync-protocol';
import type { LengthUnit } from '../viewport3d/units';

export type Theme = 'dark' | 'light';

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
  /** Cropped avatar as a small JPEG data URL ('' = none, show initial). */
  avatarUrl: string;
  /** Current board, or null if user is on the boards list. */
  currentBoard: JoinedBoard | null;
  /** UI flag for command palette / overlays. */
  shortcutsOpen: boolean;
  /** UI flag for settings modal. */
  settingsOpen: boolean;
  /** UI flag for the board-background dialog (opened from Settings). */
  backgroundOpen: boolean;
  /** PWA install prompt event captured. */
  pwaInstallable: boolean;
  /** UI theme (persisted; applied to <html data-theme> by App). */
  theme: Theme;
  /** When true (default) the 2D paper renders in theme colors on this
   *  device, like the 3D viewport; the board's shared background color is
   *  used when off. */
  paperFollowsTheme: boolean;
  /** Display unit for 3D lengths (canonical scale: 1 world unit = 1 m). */
  units: LengthUnit;
  /** CAD behavior: modal transforms snap by default; Ctrl frees them. */
  cadSnap: boolean;
  /** UI accent color (hex), applied to the CSS custom properties. */
  accent: string;
  /** Voice output volume for everyone you hear (0–1). */
  voiceVolume: number;
  /** Show the 3D modal-transform HUD hints (bottom of the viewport). */
  showTransformHud: boolean;

  setDisplayName: (n: string) => void;
  setAvatarUrl: (url: string) => void;
  setTheme: (t: Theme) => void;
  setPaperFollowsTheme: (v: boolean) => void;
  setUnits: (u: LengthUnit) => void;
  setCadSnap: (v: boolean) => void;
  setAccent: (c: string) => void;
  setVoiceVolume: (v: number) => void;
  setShowTransformHud: (v: boolean) => void;
  enterBoard: (b: JoinedBoard) => void;
  leaveBoard: () => void;
  setShortcutsOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setBackgroundOpen: (v: boolean) => void;
  setPwaInstallable: (v: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      displayName: '',
      avatarUrl: '',
      currentBoard: null,
      shortcutsOpen: false,
      settingsOpen: false,
      backgroundOpen: false,
      pwaInstallable: false,
      theme: 'dark',
      paperFollowsTheme: true,
      units: 'm',
      cadSnap: false,
      accent: '#7c6aff',
      voiceVolume: 1,
      showTransformHud: true,
      setDisplayName: (displayName) => set({ displayName }),
      setAvatarUrl: (avatarUrl) => set({ avatarUrl }),
      setTheme: (theme) => set({ theme }),
      setPaperFollowsTheme: (paperFollowsTheme) => set({ paperFollowsTheme }),
      setUnits: (units) => set({ units }),
      setCadSnap: (cadSnap) => set({ cadSnap }),
      setAccent: (accent) => set({ accent }),
      setVoiceVolume: (voiceVolume) => set({ voiceVolume: Math.max(0, Math.min(1, voiceVolume)) }),
      setShowTransformHud: (showTransformHud) => set({ showTransformHud }),
      enterBoard: (currentBoard) => set({ currentBoard }),
      leaveBoard: () => set({ currentBoard: null }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setBackgroundOpen: (backgroundOpen) => set({ backgroundOpen }),
      setPwaInstallable: (pwaInstallable) => set({ pwaInstallable }),
    }),
    {
      name: 'slate.app.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        displayName: s.displayName,
        avatarUrl: s.avatarUrl,
        currentBoard: s.currentBoard,
        theme: s.theme,
        paperFollowsTheme: s.paperFollowsTheme,
        units: s.units,
        cadSnap: s.cadSnap,
        accent: s.accent,
        voiceVolume: s.voiceVolume,
        showTransformHud: s.showTransformHud,
      }),
    },
  ),
);
