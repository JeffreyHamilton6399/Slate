/**
 * Background dialog — pick the board's paper color (synced for everyone in
 * the room, unlike the app theme which is per-device). Presets cover the
 * common dark/light papers; a custom picker handles the rest.
 */

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { cn } from '../utils/cn';

interface BackgroundDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const PRESETS: { color: string; label: string }[] = [
  { color: '#0c0c0e', label: 'Slate' },
  { color: '#16161d', label: 'Graphite' },
  { color: '#101623', label: 'Midnight' },
  { color: '#132015', label: 'Forest' },
  { color: '#f6f5f0', label: 'Paper' },
  { color: '#ffffff', label: 'White' },
  { color: '#fdf6e3', label: 'Solarized' },
  { color: '#e8eef7', label: 'Blueprint' },
];

export function BackgroundDialog({ open, onOpenChange }: BackgroundDialogProps) {
  const room = useRoom();
  const [color, setColor] = useState('#0c0c0e');

  useEffect(() => {
    if (!open) return;
    const meta = room.slate.meta();
    setColor((meta.get('paper') as string) || '#0c0c0e');
  }, [open, room]);

  const apply = () => {
    const meta = room.slate.meta();
    room.slate.doc.transact(() => {
      meta.set('paper', color);
      meta.delete('paperImage');
    });
    // The per-device "canvas follows theme" default would hide this change —
    // picking an explicit background means the user wants to see it.
    useAppStore.getState().setPaperFollowsTheme(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Board background"
      description="Shared with everyone on this board. Imported background images are cleared."
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-4 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.color}
              type="button"
              onClick={() => setColor(p.color)}
              aria-pressed={color.toLowerCase() === p.color}
              className={cn(
                'group flex flex-col items-center gap-1 rounded-sm border p-1.5 text-[10px]',
                color.toLowerCase() === p.color
                  ? 'border-accent text-text'
                  : 'border-border text-text-dim hover:border-border-2 hover:text-text',
              )}
            >
              <span
                className="relative block h-8 w-full rounded-sm border border-text-dim/30"
                style={{ backgroundColor: p.color }}
              >
                {color.toLowerCase() === p.color && (
                  <Check
                    size={13}
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-accent drop-shadow"
                  />
                )}
              </span>
              {p.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-text-mid">
          <span className="field-label m-0">Custom</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 flex-1 rounded-sm border border-border bg-transparent"
          />
          <span className="font-mono text-text-dim">{color}</span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
