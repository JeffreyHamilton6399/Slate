import { describe, expect, it } from 'vitest';
import { boardToScreen, screenToBoard, zoomAtScreen } from './transform';

describe('boardToScreen / screenToBoard', () => {
  it('round-trips a point', () => {
    const t = { zoom: 2, panX: 100, panY: -50 };
    const board = { x: 10, y: 20 };
    const screen = boardToScreen(t, board);
    const back = screenToBoard(t, screen);
    expect(back.x).toBeCloseTo(board.x, 6);
    expect(back.y).toBeCloseTo(board.y, 6);
  });
});

describe('zoomAtScreen', () => {
  it('keeps the focused board point under the cursor', () => {
    const t = { zoom: 1, panX: 0, panY: 0 };
    const screen = { x: 100, y: 100 };
    const before = screenToBoard(t, screen);
    const t2 = zoomAtScreen(t, screen, 1.5);
    const after = screenToBoard(t2, screen);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps within min/max', () => {
    const t = { zoom: 1, panX: 0, panY: 0 };
    const t2 = zoomAtScreen(t, { x: 0, y: 0 }, 1000, 0.1, 10);
    expect(t2.zoom).toBe(10);
    const t3 = zoomAtScreen(t, { x: 0, y: 0 }, 0.0001, 0.1, 10);
    expect(t3.zoom).toBe(0.1);
  });
});
