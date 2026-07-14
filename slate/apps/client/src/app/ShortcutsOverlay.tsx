/**
 * Compact, searchable keyboard-shortcuts cheatsheet.
 */
import { Dialog } from '../ui/Dialog';

interface ShortcutsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShortcutRow {
  keys: string[];
  desc: string;
}

const sections: { title: string; rows: ShortcutRow[] }[] = [
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
    rows: [
      { keys: ['Ctrl', 'A'], desc: 'Select all' },
      { keys: ['Ctrl', 'C'], desc: 'Copy' },
      { keys: ['Ctrl', 'X'], desc: 'Cut' },
      { keys: ['Ctrl', 'V'], desc: 'Paste' },
      { keys: ['Ctrl', 'D'], desc: 'Duplicate' },
      { keys: [']'], desc: 'Bring to front' },
      { keys: ['['], desc: 'Send to back' },
      { keys: ['Del'], desc: 'Delete selected' },
      { keys: ['Shift'], desc: 'Uniform resize / rotate snap (handles)' },
      { keys: ['Ctrl', '0'], desc: 'Fit view · + / − zoom' },
    ],
  },
  {
    title: '3D viewport',
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
];

export function ShortcutsOverlay({ open, onOpenChange }: ShortcutsOverlayProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      className="max-w-2xl"
    >
      <div className="grid gap-6 sm:grid-cols-2 max-h-[60vh] overflow-y-auto pr-2">
        {sections.map((s) => (
          <div key={s.title}>
            <h3 className="panel-title mb-2">{s.title}</h3>
            <ul className="flex flex-col gap-1">
              {s.rows.map((r) => (
                <li key={r.desc} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-text-mid">{r.desc}</span>
                  <span className="flex gap-1">
                    {r.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-sm border border-border bg-bg-3 px-1.5 py-0.5 text-[10px] font-mono text-text"
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
