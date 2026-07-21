/**
 * Bridge between the dockable Presentation Tools panel and the central
 * PresentationEditor. The panel can't reach the editor's contenteditable
 * directly, so it dispatches a window event with the command name (+ an
 * optional value payload like a hex color or px size); PresentationEditor
 * listens and applies it via `document.execCommand` for text formatting, or
 * the matching slide mutation for deck-level commands.
 *
 * Mirrors `docs/docBridge.ts` — same pattern, different event name so the
 * two editors don't cross-talk.
 */

export const PRESENTATION_COMMAND_EVENT = 'slate:presentation-command';

export interface PresentationCommandDetail {
  command: string;
  /** Optional value payload for commands that need one (the picked color for
   *  `textColor`, the picked px size for `fontSize`, the picked transition
   *  for `setTransition`, the template id for `addSlideTemplate`, …). */
  value?: string;
}

/**
 * Dispatch a presentation command to the PresentationEditor. The optional
 * `value` is forwarded to the editor's command handler so commands like
 * `textColor` / `fontSize` / `setTransition` can carry the user's picked
 * value (color hex, pixel size, transition id, …).
 */
export function runPresentationCommand(command: string, value?: string): void {
  window.dispatchEvent(
    new CustomEvent<PresentationCommandDetail>(PRESENTATION_COMMAND_EVENT, {
      detail: { command, value },
    }),
  );
}
