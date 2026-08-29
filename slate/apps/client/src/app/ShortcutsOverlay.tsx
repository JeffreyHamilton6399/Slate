/**
 * Keyboard-shortcuts cheatsheet.
 *
 * Sections are tagged with the modes they apply to and the overlay opens
 * filtered to the board you're actually on — a slides board showing four
 * screens of Blender-style 3D bindings is worse than no cheatsheet, because
 * the reader has to work out which half is a lie. "All modes" is one click
 * away for anyone comparing.
 */
import { useState } from 'react';
import type { DocMode } from '@slate/sync-protocol';
import { Dialog } from '../ui/Dialog';
import { useAppStore } from './store';
import { cn } from '../utils/cn';

interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShortcutRow {
  keys: string[];
  desc: string;
}

interface Section {
  title: string;
  /** Modes this section applies to; omitted = every mode. */
  modes?: DocMode[];
  rows: ShortcutRow[];
}

const sections: Section[] = [
  {
    title: 'Global',
    rows: [
      { keys: ['?'], desc: 'Open this overlay' },
      { keys: ['Ctrl', 'S'], desc: 'Save board' },
      { keys: ['Ctrl', 'Shift', 'S'], desc: 'Save as…' },
      { keys: ['Ctrl', 'Z'], desc: 'Undo' },
      { keys: ['Ctrl', 'Shift', 'Z'], desc: 'Redo' },
      { keys: ['Ctrl', 'P'], desc: 'Print' },
      { keys: ['Esc'], desc: 'Cancel modal / clear selection' },
    ],
  },
  {
    title: '2D tools',
    modes: ['2d'],
    rows: [
      { keys: ['V'], desc: 'Select' },
      { keys: ['P'], desc: 'Pen' },
      { keys: ['Y'], desc: 'Highlighter' },
      { keys: ['E'], desc: 'Eraser' },
      { keys: ['R'], desc: 'Rectangle' },
      { keys: ['O'], desc: 'Ellipse' },
      { keys: ['G'], desc: 'Triangle' },
      { keys: ['L'], desc: 'Line' },
      { keys: ['A'], desc: 'Arrow' },
      { keys: ['T'], desc: 'Text (double-click text to edit)' },
      { keys: ['I'], desc: 'Eyedropper' },
      { keys: ['K'], desc: 'Fill' },
      { keys: ['H'], desc: 'Pan · hold Space' },
      { keys: ['X'], desc: 'Swap stroke/fill colors' },
    ],
  },
  {
    title: '2D selection',
    modes: ['2d'],
    rows: [
      { keys: ['Ctrl', 'A'], desc: 'Select all' },
      { keys: ['Ctrl', 'C'], desc: 'Copy' },
      { keys: ['Ctrl', 'X'], desc: 'Cut' },
      { keys: ['Ctrl', 'V'], desc: 'Paste' },
      { keys: ['Ctrl', 'D'], desc: 'Duplicate' },
      { keys: [']'], desc: 'Bring to front' },
      { keys: ['['], desc: 'Send to back' },
      { keys: ['Del'], desc: 'Delete selected' },
      { keys: ['←↑↓→'], desc: 'Nudge selection (Shift = 10×)' },
      { keys: ['Shift'], desc: 'Uniform resize / rotate snap (handles)' },
      { keys: ['F'], desc: 'Frame selection' },
      { keys: ['Home'], desc: 'Frame everything · Ctrl+0 same' },
      { keys: ['Ctrl', '0'], desc: 'Fit view · + / − zoom' },
    ],
  },
  {
    title: '3D viewport',
    modes: ['3d'],
    rows: [
      { keys: ['MMB'], desc: 'Hold to fly — WASD/QE + mouse look' },
      { keys: ['LMB drag'], desc: 'Orbit · Shift+MMB pan · RMB pan · wheel zoom' },
      { keys: ['Num 1/3/7'], desc: 'Front / right / top (Ctrl = opposite)' },
      { keys: ['Num 0'], desc: 'Look through the scene camera' },
      { keys: ['Tab'], desc: 'Object / edit mode' },
      { keys: ['1', '2', '3'], desc: 'Vertex / edge / face select (edit)' },
      { keys: ['G', 'R', 'S'], desc: 'Move / rotate / scale (follows mouse)' },
      { keys: ['X', 'Y', 'Z'], desc: 'Axis lock · Ctrl snaps (during G/R/S)' },
      { keys: ['E'], desc: 'Extrude selected faces (follows mouse)' },
      { keys: ['I'], desc: 'Inset' },
      { keys: ['Ctrl', 'B'], desc: 'Bevel' },
      { keys: ['Ctrl', 'R'], desc: 'Loop cut' },
      { keys: ['M'], desc: 'Merge verts · F fill face from verts' },
      { keys: ['Ctrl', 'J'], desc: 'Join selected objects' },
      { keys: ['Shift', 'A'], desc: 'Add object menu (mesh / light / empty)' },
      { keys: ['A'], desc: 'Select all · Alt+A deselect' },
      { keys: ['F'], desc: 'Frame selected · Home frame all' },
      { keys: ['Shift', 'D'], desc: 'Duplicate object' },
      { keys: ['I'], desc: 'Insert keyframe at playhead (object mode)' },
      { keys: ['H'], desc: 'Hide · Alt+H unhide all' },
      { keys: ['Z'], desc: 'Wireframe · Shift+Z rendered shading' },
      { keys: ['X', 'Del'], desc: 'Delete selection / faces' },
    ],
  },
  {
    title: 'Slides — editing',
    modes: ['presentation'],
    rows: [
      { keys: ['Double-click'], desc: 'New text box · on text, edit it' },
      { keys: ['Enter'], desc: 'Commit text · Shift+Enter for a new line' },
      { keys: ['Ctrl', 'C'], desc: 'Copy · Ctrl+X cut · Ctrl+V paste' },
      { keys: ['Ctrl', 'D'], desc: 'Duplicate selection' },
      { keys: ['Del'], desc: 'Delete selection' },
      { keys: ['←↑↓→'], desc: 'Nudge selection (Shift = 10×)' },
      { keys: [']'], desc: 'Bring to front · [ send to back' },
      { keys: ['Shift'], desc: 'Add to selection (click) · lock aspect (resize)' },
      { keys: ['Drag ○'], desc: 'Top handle rotates · Shift snaps to 15°' },
      { keys: ['Alt'], desc: 'Drag without snapping to alignment guides' },
      { keys: ['PgDn'], desc: 'Next slide · PgUp previous' },
      { keys: ['Ctrl', 'V'], desc: 'Paste an image straight onto the slide' },
    ],
  },
  {
    title: 'Slides — presenting',
    modes: ['presentation'],
    rows: [
      { keys: ['F5'], desc: 'Present from this slide · Shift+F5 from the start' },
      { keys: ['→', 'Space'], desc: 'Next slide · N same' },
      { keys: ['←'], desc: 'Previous slide · P same' },
      { keys: ['Home'], desc: 'First slide · End last slide' },
      { keys: ['1…9', '⏎'], desc: 'Jump to a slide number' },
      { keys: ['O'], desc: 'Slide overview grid' },
      { keys: ['S'], desc: 'Presenter view — notes, next slide, timer' },
      { keys: ['B'], desc: 'Black screen · W white screen' },
      { keys: ['L'], desc: 'Laser pointer' },
      { keys: ['T'], desc: 'Pause timer · R reset it' },
      { keys: ['F'], desc: 'Toggle fullscreen' },
      { keys: ['Esc'], desc: 'End the presentation' },
    ],
  },
  {
    title: 'Diagram',
    modes: ['diagram'],
    rows: [
      { keys: ['Double-click'], desc: 'New node · on a node, edit its label' },
      { keys: ['Enter'], desc: 'Edit the selected node' },
      { keys: ['Ctrl', 'A'], desc: 'Select all nodes' },
      { keys: ['Ctrl', 'C'], desc: 'Copy · Ctrl+X cut · Ctrl+V paste' },
      { keys: ['Ctrl', 'D'], desc: 'Duplicate selection' },
      { keys: ['Del'], desc: 'Delete selected nodes and their edges' },
      { keys: ['←↑↓→'], desc: 'Nudge selection (Shift = 10×)' },
      { keys: ['Space'], desc: 'Hold to pan · wheel zooms' },
      { keys: ['Esc'], desc: 'Clear selection' },
    ],
  },
  {
    title: 'Document',
    modes: ['doc'],
    rows: [
      { keys: ['Ctrl', 'B'], desc: 'Bold · Ctrl+I italic · Ctrl+U underline' },
      { keys: ['Ctrl', 'Shift', 'S'], desc: 'Strikethrough · Ctrl+E inline code' },
      { keys: ['Ctrl', 'Alt', '1'], desc: 'Heading 1 · 2 / 3 for the others' },
      { keys: ['Ctrl', 'Shift', '8'], desc: 'Bullet list · 7 numbered · 9 task list' },
      { keys: ['Ctrl', 'Shift', 'B'], desc: 'Blockquote' },
      { keys: ['Ctrl', 'Shift', 'L'], desc: 'Align left · E center · R right' },
      { keys: ['Tab'], desc: 'Indent a list item · Shift+Tab outdent' },
      { keys: ['Ctrl', 'Z'], desc: 'Undo your own edits (never a collaborator’s)' },
    ],
  },
  {
    title: 'Code',
    modes: ['code'],
    rows: [
      { keys: ['Ctrl', 'F'], desc: 'Find (replace lives in the same panel)' },
      { keys: ['Ctrl', 'G'], desc: 'Find next · Shift+Ctrl+G previous · F3 same' },
      { keys: ['Ctrl', 'Alt', 'G'], desc: 'Go to line' },
      { keys: ['Ctrl', 'Shift', 'P'], desc: 'Command palette' },
      { keys: ['Ctrl', 'Space'], desc: 'Autocomplete' },
      { keys: ['Ctrl', '/'], desc: 'Toggle line comment' },
      { keys: ['Ctrl', 'D'], desc: 'Select next occurrence' },
      { keys: ['Alt', '↑'], desc: 'Move line up · Alt+↓ down' },
      { keys: ['Tab'], desc: 'Indent · Shift+Tab outdent' },
    ],
  },
  {
    title: 'Audio studio',
    modes: ['audio'],
    rows: [
      { keys: ['Space'], desc: 'Play / pause' },
      { keys: ['R'], desc: 'Record · M metronome · L loop' },
      { keys: ['C'], desc: 'Split selected clips at the playhead' },
      { keys: ['D'], desc: 'Duplicate selected clips' },
      { keys: ['Del'], desc: 'Delete selected clips' },
      { keys: ['←'], desc: 'Nudge playhead back 2s · → forward' },
      { keys: ['Home'], desc: 'Return to the start' },
      { keys: ['Ctrl', 'C'], desc: 'Copy clips · Ctrl+V paste at the playhead' },
    ],
  },
];

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  const mode = useAppStore((s) => s.currentBoard?.mode);
  const [showAll, setShowAll] = useState(false);

  const visible =
    showAll || !mode ? sections : sections.filter((s) => !s.modes || s.modes.includes(mode));
  // Nothing mode-specific to show would leave a lone "Global" card; fall back
  // to everything rather than pretending the board has no shortcuts.
  const shown = visible.length > 1 ? visible : sections;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="max-w-2xl"
    >
      <div className="mb-3 flex items-center gap-1 text-xs">
        <FilterTab active={!showAll} onClick={() => setShowAll(false)}>
          This board
        </FilterTab>
        <FilterTab active={showAll} onClick={() => setShowAll(true)}>
          All modes
        </FilterTab>
      </div>
      <div className="grid max-h-[60vh] gap-6 overflow-y-auto pr-2 sm:grid-cols-2">
        {shown.map((s) => (
          <div key={s.title}>
            <h3 className="panel-title mb-2">{s.title}</h3>
            <ul className="flex flex-col gap-1">
              {s.rows.map((r) => (
                <li key={r.desc} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-text-mid">{r.desc}</span>
                  <span className="flex flex-none gap-1">
                    {r.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-sm border border-border bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] text-text"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md px-2.5 py-1 transition-colors',
        active ? 'bg-accent/20 text-accent' : 'text-text-dim hover:bg-bg-3 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
