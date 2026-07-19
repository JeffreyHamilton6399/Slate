import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistSave, listSaves, loadSave, type SavedSnapshot } from './snapshot';

function mkSnap(name: string, bytes: number, savedAt: number): SavedSnapshot {
  return {
    schema: 'slate-v2',
    savedAt,
    boardName: name,
    data: {
      meta: { createdBy: '', createdAt: 0, name, topic: '', visibility: 'public', mode: '2d', paper: '#000', hostId: '' },
      shapes: {}, strokes: {}, layers: [],
      scene3d: { objects: {}, meshes: {}, materials: {} },
      audio: { tracks: [], clips: [], bpm: 120 },
      notes: [], chat: [],
      // pad the payload to `bytes`
      _pad: 'x'.repeat(Math.max(0, bytes)),
    } as unknown as SavedSnapshot['data'],
  };
}

describe('persistSave quota eviction', () => {
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('evicts the oldest saves and retries when localStorage is full', () => {
    // Fake a ~200KB localStorage cap on the blob keys.
    const store = new Map<string, string>();
    let used = 0;
    const CAP = 200_000;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
      const prev = store.get(k)?.length ?? 0;
      const nextUsed = used - prev + v.length;
      if (nextUsed > CAP) {
        const err = new DOMException('quota', 'QuotaExceededError');
        throw err;
      }
      used = nextUsed;
      store.set(k, v);
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k: string) => store.get(k) ?? null);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((k: string) => {
      used -= store.get(k)?.length ?? 0;
      store.delete(k);
    });

    // Fill with three ~70KB saves — the third pushes near the cap.
    persistSave(mkSnap('a', 70_000, 1), 'a', 'a');
    persistSave(mkSnap('b', 70_000, 2), 'b', 'b');
    persistSave(mkSnap('c', 70_000, 3), 'c', 'c');
    // A new ~120KB save can't fit — eviction must drop the oldest ('a', then 'b')
    // and still persist the new one, rather than throwing/failing silently.
    expect(() => persistSave(mkSnap('d', 120_000, 4), 'd', 'd')).not.toThrow();

    const ids = listSaves().map((e) => e.id);
    expect(ids).toContain('d'); // the new save survived
    expect(loadSave('d')).not.toBeNull(); // its blob is really there
    expect(ids).not.toContain('a'); // oldest was evicted
  });
});
