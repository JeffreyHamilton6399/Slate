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
      { keys: ['Ctrl', 'P'], desc: 'Print' },
      { keys: ['Esc'], desc: 'Cancel modal / dismiss panel' },
    ],
  },
  {
    title: '2D canvas',
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
      { keys: ['T'], desc: 'Text' },
      { keys: ['I'], desc: 'Eyedropper' },
      { keys: ['K'], desc: 'Fill' },
      { keys: ['H'], desc: 'Pan' },
      { keys: ['X'], desc: 'Swap stroke/fill colors' },
      { keys: ['Space'], desc: 'Hold to pan' },
      { keys: ['Ctrl', 'Z'], desc: 'Undo' },
      { keys: ['Ctrl', 'Shift', 'Z'], desc: 'Redo' },
      { keys: ['Ctrl', '0'], desc: 'Fit to screen' },
      { keys: ['+', '−'], desc: 'Zoom in / out' },
      { keys: ['Del'], desc: 'Delete selected' },
    ],
  },
  {
    title: '3D viewport',
    rows: [
      { keys: ['Tab'], desc: 'Toggle object / edit mode' },
      { keys: ['1', '2', '3'], desc: 'Vertex / edge / face select' },
      { keys: ['G'], desc: 'Grab (translate)' },
      { keys: ['R'], desc: 'Rotate' },
      { keys: ['S'], desc: 'Scale' },
      { keys: ['X', 'Y', 'Z'], desc: 'Axis lock (during G/R/S)' },
      { keys: ['E'], desc: 'Extrude' },
      { keys: ['I'], desc: 'Inset' },
      { keys: ['Ctrl', 'B'], desc: 'Bevel' },
      { keys: ['Ctrl', 'R'], desc: 'Loop cut' },
      { keys: ['K'], desc: 'Knife' },
      { keys: ['M'], desc: 'Merge' },
      { keys: ['F'], desc: 'Frame selected / make face (edit)' },
      { keys: ['Shift', 'D'], desc: 'Duplicate' },
      { keys: ['H'], desc: 'Hide selected' },
      { keys: ['Alt', 'H'], desc: 'Unhide all' },
      { keys: ['X', 'Del'], desc: 'Delete selected' },
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
