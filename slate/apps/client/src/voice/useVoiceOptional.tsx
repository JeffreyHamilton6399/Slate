/**
 * Optional voice hook — returns null if no VoiceProvider is mounted, so
 * components like Header can render before the workspace tree is ready.
 */

import { createContext } from 'react';
import { useVoice } from './VoiceProvider';

const Sentinel = createContext<true | null>(null);
export const VoiceMountedMarker = Sentinel.Provider;

export function useVoiceOptional() {
  // We can't import VoiceProvider's context directly without circular import,
  // so we wrap useVoice in a try/catch via context probe.
  try {
    return useVoice();
  } catch {
    return null;
  }
}
