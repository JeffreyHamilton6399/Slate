/**
 * AudioEditorPanel — dockable wrapper that renders the AudioEditor full-width.
 * When opened as a full panel (not docked), it takes the main viewport area.
 */
import { AudioEditor } from '../audio/AudioEditor';

export function AudioEditorPanel() {
  return <AudioEditor />;
}
