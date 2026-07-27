/**
 * Slides local UI state. Slide/element DATA lives in Yjs; this store only
 * holds this device's ephemeral editing state.
 *
 * The active slide id lives here (rather than in SlidesEditor's own state) so
 * the left Design panel and the Export dialog — neither of which is a child of
 * the editor — can follow the selection reactively.
 */

import { create } from 'zustand';

interface SlidesState {
  /** Slide currently open on the stage (null before the deck loads). */
  activeSlideId: string | null;
  setActiveSlide: (id: string | null) => void;
}

export const useSlidesStore = create<SlidesState>()((set) => ({
  activeSlideId: null,
  setActiveSlide: (activeSlideId) => set({ activeSlideId }),
}));
