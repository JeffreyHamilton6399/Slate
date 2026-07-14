/**
 * Board settings — options that belong to THIS board and are shared with
 * everyone in it (stored in the board doc), as opposed to the global,
 * device-level preferences in the top-right Settings. Covers the board
 * background and 3D units / measurement.
 */

import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { FieldLabel } from '../ui/Input';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from './store';
import { useBoardUnits, useBoardCadSnap } from '../sync/useBoardSettings';
import { LENGTH_UNITS, type LengthUnit } from '../viewport3d/units';

export function BoardSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const setBackgroundOpen = useAppStore((s) => s.setBackgroundOpen);
  const [units, setUnits] = useBoardUnits(room);
  const [cadSnap, setCadSnap] = useBoardCadSnap(room);
  const is3d = board?.mode === '3d';

  const visibility = (() => {
    const meta = room.slate.meta();
    return (meta.get('visibility') as 'public' | 'private' | undefined) ?? 'public';
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Board settings"
      description="These apply to this board and everyone working in it."
    >
      <div className="flex flex-col gap-4">
        <div>
          <FieldLabel>Visibility</FieldLabel>
          <div className="flex rounded-sm bg-bg-3 p-0.5">
            {(['public', 'private'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  const meta = room.slate.meta();
                  meta.set('visibility', v);
                }}
                className={
                  'flex-1 rounded-sm py-1.5 text-xs font-medium capitalize ' +
                  (visibility === v ? 'bg-accent text-white' : 'text-text-dim hover:text-text')
                }
              >
                {v}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-text-dim">
            {visibility === 'public'
              ? 'Anyone with the link can discover and join this board.'
              : 'Only people you share the link with can join this board.'}
          </p>
        </div>

        <div className="border-t border-border pt-4">
          <FieldLabel>Background</FieldLabel>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              setBackgroundOpen(true);
            }}
          >
            Board background…
          </Button>
          <p className="mt-1 text-xs text-text-dim">
            A shared background color or image for this board.
          </p>
        </div>

        {is3d && (
          <div className="border-t border-border pt-4">
            <FieldLabel>Units &amp; measurement</FieldLabel>
            <div className="flex items-center gap-2">
              <select
                value={units}
                onChange={(e) => setUnits(e.target.value as LengthUnit)}
                className="rounded-sm border border-border bg-bg-4 px-2 py-1.5 text-sm outline-none focus:border-accent"
                aria-label="Board display units"
              >
                {LENGTH_UNITS.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label} ({u.id})
                  </option>
                ))}
              </select>
              <span className="text-xs text-text-dim">1 grid unit = 1 m</span>
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-text-mid">
              <input
                type="checkbox"
                checked={cadSnap}
                onChange={(e) => setCadSnap(e.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span>
                CAD snapping — transforms snap by default
                <span className="block text-text-dim">
                  Move/rotate/scale land on precise increments; hold Ctrl to move freely.
                  Off = Blender-style (free by default, Ctrl snaps).
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
    </Dialog>
  );
}
