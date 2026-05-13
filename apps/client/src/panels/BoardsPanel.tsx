/**
 * BoardsPanel — list of live public boards + a "saved boards" section
 * (snapshots persisted in IndexedDB by board name). Click a row to jump.
 */
import { useEffect, useState } from 'react';
import { Folder, Users, ArrowRight } from 'lucide-react';
import { useAppStore } from '../app/store';
import { pollRooms, type PublicRoom } from '../sync/rooms';
import { useRoom } from '../sync/RoomContext';
import { Button } from '../ui/Button';

export function BoardsPanel() {
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const room = useRoom();
  const enterBoard = useAppStore((s) => s.enterBoard);

  useEffect(() => pollRooms(setRooms, 5000), []);

  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <h4 className="panel-title mb-2">Current</h4>
        <div className="rounded-sm bg-bg-3 px-2 py-1.5 text-sm flex items-center gap-2">
          <Folder size={14} className="text-accent" />
          <span className="font-mono truncate flex-1">{room.room}</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <h4 className="panel-title mb-2">Live public</h4>
        <ul className="flex-1 overflow-y-auto flex flex-col gap-1">
          {rooms
            .filter((r) => r.name !== room.room)
            .map((r) => (
              <li key={r.name}>
                <button
                  type="button"
                  onClick={() =>
                    enterBoard({
                      name: r.name,
                      mode: r.mode,
                      visibility: r.visibility,
                      iAmCreator: false,
                      joinedAt: Date.now(),
                    })
                  }
                  className="w-full flex items-center gap-2 rounded-sm bg-bg-3 hover:bg-bg-4 px-2 py-1.5 text-sm text-left transition-colors"
                >
                  <span className="font-mono truncate flex-1">{r.name}</span>
                  <span className="text-text-dim text-[10px] font-mono uppercase tracking-wider">
                    {r.mode}
                  </span>
                  <Users size={12} className="text-text-dim" />
                  <span className="text-xs font-mono text-text-mid">{r.members}</span>
                  <ArrowRight size={12} className="text-text-dim" />
                </button>
              </li>
            ))}
          {rooms.filter((r) => r.name !== room.room).length === 0 && (
            <li className="text-xs text-text-dim text-center pt-4">No other live boards.</li>
          )}
        </ul>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => useAppStore.getState().leaveBoard()}
        className="mt-1"
      >
        Back to onboarding
      </Button>
    </div>
  );
}
