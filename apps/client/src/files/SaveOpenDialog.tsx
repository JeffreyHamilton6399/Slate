/**
 * Save / Open dialog — picks a labeled snapshot to write to or restore
 * from localStorage. "Save" writes a fresh snapshot under a generated id;
 * "Save as…" prompts for a label; "Open…" lists existing saves.
 */

import { useEffect, useState } from 'react';
import { Save, Trash2, RotateCcw } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useRoom } from '../sync/RoomContext';
import { toast } from '../ui/Toast';
import { applySnapshot, deleteSave, listSaves, loadSave, persistSave, snapshotDoc } from './snapshot';

interface SaveOpenDialogProps {
  mode: 'save-as' | 'open' | null;
  onClose: () => void;
}

export function SaveOpenDialog({ mode, onClose }: SaveOpenDialogProps) {
  const room = useRoom();
  const [label, setLabel] = useState('');
  const [entries, setEntries] = useState(() => listSaves());

  useEffect(() => {
    if (mode) setEntries(listSaves());
  }, [mode]);

  const onSaveAs = () => {
    const snap = snapshotDoc(room);
    persistSave(snap, label || undefined);
    toast({ title: 'Saved' });
    setLabel('');
    onClose();
  };

  const onOpen = (id: string) => {
    const snap = loadSave(id);
    if (!snap) {
      toast({ title: 'Save not found', variant: 'error' });
      return;
    }
    if (
      !window.confirm(
        'This will overwrite the current board with the saved snapshot. Continue?',
      )
    )
      return;
    applySnapshot(room, snap);
    toast({ title: 'Snapshot restored' });
    onClose();
  };

  const onDelete = (id: string) => {
    if (!window.confirm('Delete this saved snapshot?')) return;
    deleteSave(id);
    setEntries(listSaves());
  };

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(v) => !v && onClose()}
      title={mode === 'save-as' ? 'Save snapshot' : 'Open snapshot'}
      description={
        mode === 'save-as'
          ? 'Store the current board state to a labeled snapshot. You can restore it later via Open.'
          : 'Pick a saved snapshot to restore into the current board. This overwrites live state.'
      }
    >
      <div className="flex flex-col gap-3">
        {mode === 'save-as' && (
          <div>
            <label className="field-label">Label</label>
            <Input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Auto-generated if blank"
              maxLength={120}
            />
          </div>
        )}
        {mode === 'open' && (
          <ul className="max-h-72 flex-1 overflow-y-auto flex flex-col gap-1">
            {entries.length === 0 ? (
              <li className="text-center text-xs text-text-dim py-6">No saves yet.</li>
            ) : (
              entries.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-2 rounded-sm border border-border bg-bg-3 p-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{e.label}</p>
                    <p className="text-[10px] font-mono uppercase text-text-dim">
                      {e.mode.toUpperCase()} • {new Date(e.savedAt).toLocaleString()} • {Math.round(e.approxBytes / 1024)}KB
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => onOpen(e.id)} aria-label="Open snapshot">
                    <RotateCcw size={12} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDelete(e.id)} aria-label="Delete snapshot">
                    <Trash2 size={12} />
                  </Button>
                </li>
              ))
            )}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {mode === 'save-as' && (
            <Button variant="primary" onClick={onSaveAs}>
              <Save size={13} />
              <span className="ml-1.5">Save</span>
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
