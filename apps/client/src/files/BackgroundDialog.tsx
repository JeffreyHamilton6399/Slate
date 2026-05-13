/**
 * Background dialog — pick paper color (and clear background image if any).
 */

import { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useRoom } from '../sync/RoomContext';

interface BackgroundDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

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
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Board background"
      description="Pick a paper color. Imported background images are cleared."
    >
      <div className="flex flex-col gap-3">
        <label className="field-label">Paper color</label>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-9 w-full rounded-sm border border-border bg-transparent"
        />
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
