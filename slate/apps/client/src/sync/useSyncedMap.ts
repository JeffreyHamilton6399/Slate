/**
 * Tiny hook that subscribes to a Y.Map / Y.Array and re-renders on any
 * deep change. For perf-sensitive surfaces (canvas, viewport) prefer
 * subscribing directly to avoid React reconciliation.
 */
import { useEffect, useState } from 'react';
import * as Y from 'yjs';

export function useYMapVersion(map: Y.AbstractType<unknown> | null | undefined): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!map) return;
    const bump = () => setVersion((v) => v + 1);
    map.observeDeep(bump);
    return () => map.unobserveDeep(bump);
  }, [map]);
  return version;
}

export function useYArrayValues<T>(arr: Y.Array<T> | null | undefined): T[] {
  const [items, setItems] = useState<T[]>(() => (arr ? arr.toArray() : []));
  useEffect(() => {
    if (!arr) return;
    const update = () => setItems(arr.toArray());
    arr.observeDeep(update);
    update();
    return () => arr.unobserveDeep(update);
  }, [arr]);
  return items;
}
