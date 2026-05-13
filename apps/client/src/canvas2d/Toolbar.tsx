/**
 * 2D canvas toolbar — left rail of tools + top color/size strip.
 * Self-contained and styled to match the rest of the workspace chrome.
 */

import {
  MousePointer2,
  Pencil,
  Highlighter,
  Eraser,
  Square,
  Circle,
  Triangle,
  Slash,
  ArrowUpRight,
  Type as TypeIcon,
  Pipette,
  PaintBucket,
  Hand,
  Undo2,
  Redo2,
  Trash2,
  Minus,
  Plus,
  Maximize2,
} from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Button } from '../ui/Button';
import { useCanvasStore, type ToolId } from './store';

interface ToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  zoomLabel: string;
}

const TOOLS: { id: ToolId; label: string; Icon: typeof Pencil; shortcut: string }[] = [
  { id: 'select', label: 'Select', Icon: MousePointer2, shortcut: 'V' },
  { id: 'pen', label: 'Pen', Icon: Pencil, shortcut: 'P' },
  { id: 'highlighter', label: 'Highlighter', Icon: Highlighter, shortcut: 'Y' },
  { id: 'eraser', label: 'Eraser', Icon: Eraser, shortcut: 'E' },
  { id: 'rect', label: 'Rectangle', Icon: Square, shortcut: 'R' },
  { id: 'ellipse', label: 'Ellipse', Icon: Circle, shortcut: 'O' },
  { id: 'triangle', label: 'Triangle', Icon: Triangle, shortcut: 'G' },
  { id: 'line', label: 'Line', Icon: Slash, shortcut: 'L' },
  { id: 'arrow', label: 'Arrow', Icon: ArrowUpRight, shortcut: 'A' },
  { id: 'text', label: 'Text', Icon: TypeIcon, shortcut: 'T' },
  { id: 'eyedropper', label: 'Eyedropper', Icon: Pipette, shortcut: 'I' },
  { id: 'fill', label: 'Fill', Icon: PaintBucket, shortcut: 'K' },
  { id: 'pan', label: 'Pan (hold Space)', Icon: Hand, shortcut: 'H' },
];

export function Canvas2DToolbar({
  onUndo,
  onRedo,
  onClear,
  onZoomIn,
  onZoomOut,
  onFit,
  zoomLabel,
}: ToolbarProps) {
  const tool = useCanvasStore((s) => s.tool);
  const setTool = useCanvasStore((s) => s.setTool);
  const stroke = useCanvasStore((s) => s.stroke);
  const fill = useCanvasStore((s) => s.fill);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const strokeOpacity = useCanvasStore((s) => s.strokeOpacity);
  const setStroke = useCanvasStore((s) => s.setStroke);
  const setFill = useCanvasStore((s) => s.setFill);
  const setStrokeWidth = useCanvasStore((s) => s.setStrokeWidth);
  const setStrokeOpacity = useCanvasStore((s) => s.setStrokeOpacity);
  const swapColors = useCanvasStore((s) => s.swapColors);

  return (
    <>
      <aside
        className="absolute left-2 top-2 bottom-2 z-10 flex w-11 flex-col items-center gap-1 rounded-md border border-border bg-bg-2/95 backdrop-blur p-1 shadow-lg"
        role="toolbar"
        aria-label="Canvas tools"
      >
        {TOOLS.map(({ id, label, Icon, shortcut }) => (
          <Tooltip key={id} content={`${label} (${shortcut})`} side="right">
            <button
              type="button"
              onClick={() => setTool(id)}
              aria-pressed={tool === id}
              aria-label={label}
              className={
                'flex h-8 w-8 items-center justify-center rounded-sm border ' +
                (tool === id
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-transparent text-text-mid hover:bg-bg-4 hover:text-text')
              }
            >
              <Icon size={15} />
            </button>
          </Tooltip>
        ))}
      </aside>

      <div
        className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-bg-2/95 backdrop-blur px-2 py-1.5 shadow-lg"
        role="toolbar"
        aria-label="Style"
      >
        <Tooltip content="Stroke color">
          <label className="flex items-center gap-1 cursor-pointer">
            <span className="text-[10px] uppercase tracking-wider text-text-dim">Stroke</span>
            <input
              type="color"
              value={stroke}
              onChange={(e) => setStroke(e.target.value)}
              className="h-6 w-6 rounded border border-border bg-transparent"
              aria-label="Stroke color"
            />
          </label>
        </Tooltip>
        <Tooltip content="Fill color">
          <label className="flex items-center gap-1 cursor-pointer">
            <span className="text-[10px] uppercase tracking-wider text-text-dim">Fill</span>
            <input
              type="color"
              value={fill ?? '#000000'}
              onChange={(e) => setFill(e.target.value)}
              className="h-6 w-6 rounded border border-border bg-transparent"
              aria-label="Fill color"
            />
            <button
              type="button"
              onClick={() => setFill(fill ? null : '#7c6aff')}
              className="text-[10px] text-text-dim hover:text-text"
            >
              {fill ? 'on' : 'off'}
            </button>
          </label>
        </Tooltip>
        <Tooltip content="Swap colors (X)">
          <Button variant="icon" size="none" onClick={swapColors} aria-label="Swap colors">
            <ArrowUpRight size={13} />
          </Button>
        </Tooltip>
        <div className="h-5 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-text-dim">Size</span>
          <input
            type="range"
            min={1}
            max={64}
            value={strokeWidth}
            onChange={(e) => setStrokeWidth(Number(e.target.value))}
            aria-label="Stroke width"
            className="w-20 accent-accent"
          />
          <span className="w-6 text-right font-mono">{strokeWidth}</span>
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-text-dim">Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strokeOpacity}
            onChange={(e) => setStrokeOpacity(Number(e.target.value))}
            aria-label="Stroke opacity"
            className="w-16 accent-accent"
          />
        </label>
      </div>

      <div
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-bg-2/95 backdrop-blur px-2 py-1 shadow-lg"
        role="toolbar"
        aria-label="History & zoom"
      >
        <Tooltip content="Undo (Ctrl+Z)">
          <Button variant="icon" size="none" onClick={onUndo} aria-label="Undo">
            <Undo2 size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="Redo (Ctrl+Shift+Z)">
          <Button variant="icon" size="none" onClick={onRedo} aria-label="Redo">
            <Redo2 size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="Clear board">
          <Button variant="icon" size="none" onClick={onClear} aria-label="Clear board">
            <Trash2 size={14} />
          </Button>
        </Tooltip>
        <div className="mx-1 h-5 w-px bg-border" />
        <Tooltip content="Zoom out (-)">
          <Button variant="icon" size="none" onClick={onZoomOut} aria-label="Zoom out">
            <Minus size={14} />
          </Button>
        </Tooltip>
        <span className="min-w-[3.5rem] text-center font-mono text-xs">{zoomLabel}</span>
        <Tooltip content="Zoom in (+)">
          <Button variant="icon" size="none" onClick={onZoomIn} aria-label="Zoom in">
            <Plus size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="Fit (Ctrl+0)">
          <Button variant="icon" size="none" onClick={onFit} aria-label="Fit">
            <Maximize2 size={14} />
          </Button>
        </Tooltip>
      </div>
    </>
  );
}
