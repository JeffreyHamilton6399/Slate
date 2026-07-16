/**
 * BoardsPanel — recent projects + live public boards. Click a row to jump.
 * "Recent" replaces the old "Current" section — shows the most recently
 * saved boards from localStorage snapshots.
 */
import { useEffect, useState } from 'react';
import { Users, ArrowRight, Clock } from 'lucide-react';
import { useAppStore } from '../app/store';
import { pollRooms, type PublicRoom } from '../sync/rooms';
import { useRoom } from '../sync/RoomContext';
import { listSaves, type SaveIndexEntry } from '../files/snapshot';

export function BoardsPanel() {
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [recents, setRecents] = useState<SaveIndexEntry[]>([]);
  const room = useRoom();
  const enterBoard = useAppStore((s) => s.enterBoard);

  useEffect(() => pollRooms(setRooms, 5000), []);
  useEffect(() => {
    const update = () => setRecents(listSaves().slice(0, 8));
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, []);

  // Deduplicate recents by board name (keep the newest save per board).
  const recentByBoard = new Map<string, SaveIndexEntry>();
  for (const r of recents) {
    const cur = recentByBoard.get(r.boardName);
    if (!cur || r.savedAt > cur.savedAt) recentByBoard.set(r.boardName, r);
  }
  // Boards tab shows only the three most-recent projects (the homepage lists
  // more). Keeps the panel compact and focused on "jump back in".
  const recentList = [...recentByBoard.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, 3);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Recent projects */}
      <div>
        <h4 className="panel-title mb-2">Recent</h4>
        {recentList.length === 0 ? (
          <p className="text-xs text-text-dim text-center py-2">No saved projects yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recentList.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() =>
                    enterBoard({
                      name: r.boardName,
                      mode: r.mode,
                      visibility: 'public',
                      iAmCreator: false,
                      joinedAt: Date.now(),
                    })
                  }
                  className="w-full flex items-center gap-2 rounded-sm bg-bg-3 hover:bg-bg-4 px-2 py-1.5 text-sm text-left transition-colors"
                >
                  <Clock size={12} className="text-text-dim shrink-0" />
                  <span className="font-mono truncate flex-1">{r.boardName}</span>
                  <span className="text-text-dim text-[9px] font-mono uppercase">{r.mode}</span>
                  <ArrowRight size={11} className="text-text-dim shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Live public boards */}
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
    </div>
  );
}
