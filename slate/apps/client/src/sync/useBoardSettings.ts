/**
 * Board-scoped settings live in the board's shared meta map, so they persist
 * with the board and are the same for everyone in it — unlike the global,
 * device-level preferences in the app store. Currently: 3D display units and
 * CAD snapping (board background already lives in meta.paper / meta.paperImage).
 */

import { useCallback, useEffect, useState } from 'react';
import type { SlateRoom } from './provider';
import type { LengthUnit } from '../viewport3d/units';

function useMetaField<T>(room: SlateRoom, key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => (room.slate.meta().get(key) as T) ?? fallback);
  useEffect(() => {
    const meta = room.slate.meta();
    const apply = () => setValue((meta.get(key) as T) ?? fallback);
    apply();
    meta.observe(apply);
    return () => meta.unobserve(apply);
    // fallback is a primitive literal at call sites; key is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, key]);
  const set = useCallback((v: T) => room.slate.meta().set(key, v), [room, key]);
  return [value, set];
}

export function useBoardUnits(room: SlateRoom): [LengthUnit, (u: LengthUnit) => void] {
  return useMetaField<LengthUnit>(room, 'units', 'm');
}

export function useBoardCadSnap(room: SlateRoom): [boolean, (v: boolean) => void] {
  return useMetaField<boolean>(room, 'cadSnap', false);
}
