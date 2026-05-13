/**
 * Import dialog — pick a file from disk and route it to the appropriate
 * importer. 2D boards accept images (added as background); 3D boards accept
 * model files (.obj / .stl / .ply / .gltf / .glb / .fbx).
 */

import { useCallback, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { toast } from '../ui/Toast';
import { importModel } from './import3d';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const is3d = board?.mode === '3d';
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = is3d ? '.obj,.stl,.ply,.gltf,.glb,.fbx' : 'image/*';

  const onPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        if (is3d) {
          const n = await importModel(room, file);
          toast({ title: 'Import complete', description: `${n} object${n === 1 ? '' : 's'} imported` });
        } else {
          // 2D: load as background image — saved in meta.paperImage (data URL).
          // Kept simple: convert to data URL and set on meta.
          const dataUrl = await fileToDataUrl(file);
          room.slate.doc.transact(() => {
            const meta = room.slate.meta();
            meta.set('paperImage', dataUrl);
          });
          toast({ title: 'Background updated' });
        }
        onOpenChange(false);
      } catch (err) {
        console.error(err);
        toast({ title: 'Import failed', description: (err as Error).message, variant: 'error' });
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [is3d, room, onOpenChange],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import"
      description={
        is3d
          ? 'Import a 3D model (.obj / .stl / .ply / .gltf / .glb / .fbx) into the current scene.'
          : 'Import an image to use as the board background.'
      }
    >
      <div className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={onPick}
          className="block w-full text-sm text-text-mid file:mr-3 file:rounded-sm file:border-0 file:bg-bg-3 file:px-3 file:py-2 file:text-text file:hover:bg-bg-4 file:cursor-pointer"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <Upload size={13} />
            <span className="ml-1.5">{busy ? 'Importing…' : 'Choose file'}</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}
