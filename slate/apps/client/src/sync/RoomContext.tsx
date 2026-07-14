/**
 * Provides the active SlateRoom to descendants. Panels read it via
 * useRoom() instead of being passed props from Workspace.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { SlateRoom } from './provider';

const RoomContext = createContext<SlateRoom | null>(null);

export function RoomProvider({
  room,
  children,
}: {
  room: SlateRoom;
  children: ReactNode;
}) {
  return <RoomContext.Provider value={room}>{children}</RoomContext.Provider>;
}

export function useRoom(): SlateRoom {
  const r = useContext(RoomContext);
  if (!r) throw new Error('useRoom must be used inside RoomProvider');
  return r;
}

export function useOptionalRoom(): SlateRoom | null {
  return useContext(RoomContext);
}
