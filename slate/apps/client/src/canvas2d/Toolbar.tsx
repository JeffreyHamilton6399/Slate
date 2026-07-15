/**
 * 2D canvas toolbar — left rail of tools + top color/size strip.
 * Self-contained and styled to match the rest of the workspace chrome.
 */

import {
  MousePointer2,
  Pencil,
  Highlighter,
  Eraser,
  ArrowLeftRight,
  Type as TypeIcon,
  ImagePlus,
  Pipette,
  PaintBucket,
  Hand,
  Undo2,
  Redo2,
  Trash2,
  Minus,
  Plus,
  Maximize2,
  Star,
  Square,
  Circle,
  Triangle,
  Hexagon,
  Slash,
  ArrowUpRight,
  Shapes,
  ChevronDown,
} from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Button } from '../ui/Button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/DropdownMenu';
import { cn } from '../utils/cn';
import { useCanvasStore, type ToolId } from './store';

interface ToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onInsertImage: () => void;
  zoomLabel: string;
}

type ToolDef = { id: ToolId; label: string; Icon: typeof Pencil; shortcut: string };

/** The left rail keeps only the everyday tools; shapes live in the Tools
 *  panel (top-right) where they can also be favorited. Favorited tools are
 *  pinned to the TOP of this rail so they're always one click away — that's
 *  the whole point of favoriting. */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'select', label: 'Select', Icon: MousePointer2, shortcut: 'V' },
    { id: 'pan', label: 'Pan (hold Space)', Icon: Hand, shortcut: 'H' },
  ],
  [
    { id: 'pen', label: 'Pen', Icon: Pencil, shortcut: 'P' },
    { id: 'highlighter', label: 'Highlighter', Icon: Highlighter, shortcut: 'Y' },
    { id: 'eraser', label: 'Eraser', Icon: Eraser, shortcut: 'E' },
    { id: 'text', label: 'Text', Icon: TypeIcon, shortcut: 'T' },
  ],
  [
    { id: 'eyedropper', label: 'Eyedropper', Icon: Pipette, shortcut: 'I' },
    { id: 'fill', label: 'Fill', Icon: PaintBucket, shortcut: 'K' },
  ],
];

/** Every tool definition keyed by id — used to resolve favorited ids (which
 *  may point at shape tools that don't live in the default rail) into the
 *  icon/label/shortcut needed to render them on the left bar. Mirrors the
 *  Tools panel's full tool list so any favorited tool can be pinned here. */

/** Shape tools grouped for the dropdown button (Google Slides style). */
const SHAPE_TOOLS: ToolDef[] = [
  { id: 'rect', label: 'Rectangle', Icon: Square, shortcut: 'R' },
  { id: 'ellipse', label: 'Ellipse', Icon: Circle, shortcut: 'O' },
  { id: 'triangle', label: 'Triangle', Icon: Triangle, shortcut: 'G' },
  { id: 'diamond', label: 'Diamond', Icon: Square, shortcut: 'D' },
  { id: 'pentagon', label: 'Pentagon', Icon: Square, shortcut: '5' },
  { id: 'hexagon', label: 'Hexagon', Icon: Hexagon, shortcut: 'U' },
  { id: 'parallelogram', label: 'Parallelogram', Icon: Square, shortcut: 'P' },
  { id: 'trapezoid', label: 'Trapezoid', Icon: Square, shortcut: 'Z' },
  { id: 'cross', label: 'Cross', Icon: Square, shortcut: 'X' },
  { id: 'polygon', label: 'Polygon', Icon: Hexagon, shortcut: 'U' },
  { id: 'star', label: 'Star', Icon: Star, shortcut: 'S' },
  { id: 'heart', label: 'Heart', Icon: Star, shortcut: 'H' },
  { id: 'cloud', label: 'Cloud', Icon: Star, shortcut: 'C' },
  { id: 'speech', label: 'Speech Bubble', Icon: Star, shortcut: 'B' },
  { id: 'line', label: 'Line', Icon: Slash, shortcut: 'L' },
  { id: 'arrow', label: 'Arrow', Icon: ArrowUpRight, shortcut: 'A' },
];

/** Check if a tool id is a shape (for the dropdown's active state). */
const SHAPE_IDS = new Set(SHAPE_TOOLS.map((t) => t.id));

const ALL_TOOL_DEFS: ToolDef[] = [
  { id: 'select', label: 'Select', Icon: MousePointer2, shortcut: 'V' },
  { id: 'pan', label: 'Pan', Icon: Hand, shortcut: 'H' },
  { id: 'pen', label: 'Pen', Icon: Pencil, shortcut: 'P' },
  { id: 'pencil', label: 'Pencil', Icon: Pencil, shortcut: 'N' },
  { id: 'marker', label: 'Marker', Icon: Pencil, shortcut: 'M' },
  { id: 'calligraphy', label: 'Calligraphy', Icon: Pencil, shortcut: 'C' },
  { id: 'airbrush', label: 'Airbrush', Icon: Pencil, shortcut: 'B' },
  { id: 'highlighter', label: 'Highlighter', Icon: Highlighter, shortcut: 'Y' },
  { id: 'eraser', label: 'Eraser', Icon: Eraser, shortcut: 'E' },
  { id: 'rect', label: 'Rectangle', Icon: Square, shortcut: 'R' },
  { id: 'ellipse', label: 'Ellipse', Icon: Circle, shortcut: 'O' },
  { id: 'triangle', label: 'Triangle', Icon: Triangle, shortcut: 'G' },
  { id: 'diamond', label: 'Diamond', Icon: Square, shortcut: 'D' },
  { id: 'pentagon', label: 'Pentagon', Icon: Square, shortcut: '5' },
  { id: 'hexagon', label: 'Hexagon', Icon: Hexagon, shortcut: 'U' },
  { id: 'parallelogram', label: 'Parallelogram', Icon: Square, shortcut: 'P' },
  { id: 'trapezoid', label: 'Trapezoid', Icon: Square, shortcut: 'Z' },
  { id: 'cross', label: 'Cross', Icon: Square, shortcut: 'X' },
  { id: 'polygon', label: 'Polygon', Icon: Hexagon, shortcut: 'U' },
  { id: 'star', label: 'Star', Icon: Star, shortcut: 'S' },
  { id: 'heart', label: 'Heart', Icon: Star, shortcut: 'H' },
  { id: 'cloud', label: 'Cloud', Icon: Star, shortcut: 'C' },
  { id: 'speech', label: 'Speech Bubble', Icon: Star, shortcut: 'B' },
  { id: 'line', label: 'Line', Icon: Slash, shortcut: 'L' },
  { id: 'arrow', label: 'Arrow', Icon: ArrowUpRight, shortcut: 'A' },
  { id: 'text', label: 'Text', Icon: TypeIcon, shortcut: 'T' },
  { id: 'eyedropper', label: 'Eyedropper', Icon: Pipette, shortcut: 'I' },
  { id: 'fill', label: 'Fill', Icon: PaintBucket, shortcut: 'K' },
];
const TOOL_BY_ID: Record<string, ToolDef> = Object.fromEntries(
  ALL_TOOL_DEFS.map((t) => [t.id, t]),
);

export function Canvas2DToolbar({
  onUndo,
  onRedo,
  onClear,
  onZoomIn,
  onZoomOut,
  onFit,
  onInsertImage,
  zoomLabel,
}: ToolbarProps) {
  const tool = useCanvasStore((s) => s.tool);
  const polySides = useCanvasStore((s) => s.polySides);
  const setPolySides = useCanvasStore((s) => s.setPolySides);
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
  const favorites = useCanvasStore((s) => s.favorites);
  // Resolve favorited ids (which may include shape tools not on the default
  // rail) to their full definitions so they render with the right icon here.
  const favTools = favorites
    .map((id) => TOOL_BY_ID[id])
    .filter((t): t is ToolDef => Boolean(t));

  return (
    <>
      <aside
        className="absolute left-2 top-2 bottom-16 z-10 flex w-11 flex-col items-center gap-1 overflow-y-auto rounded-md border border-border bg-bg-2/95 backdrop-blur p-1 shadow-lg sm:bottom-2"
        role="toolbar"
        aria-label="Canvas tools"
      >
        {favTools.length > 0 && (
          <div className="flex flex-col items-center gap-0.5">
            {favTools.map(({ id, label, Icon, shortcut }) => (
              <Tooltip key={`fav-${id}`} content={`${label} (${shortcut}) ★`} side="right">
                <button
                  type="button"
                  onClick={() => setTool(id)}
                  aria-pressed={tool === id}
                  aria-label={label}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-sm border',
                    tool === id
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-transparent text-text-mid hover:bg-bg-4 hover:text-text',
                  )}
                >
                  <Icon size={15} />
                </button>
              </Tooltip>
            ))}
            <div className="my-1 h-px w-6 bg-border" />
          </div>
        )}
        {TOOL_GROUPS.map((group, gi) => (
          <div key={gi} className="flex flex-col items-center gap-0.5">
            {gi > 0 && <div className="my-1 h-px w-6 bg-border" />}
            {group.map(({ id, label, Icon, shortcut }) => (
              <Tooltip key={id} content={`${label} (${shortcut})`} side="right">
                <button
                  type="button"
                  onClick={() => setTool(id)}
                  aria-pressed={tool === id}
                  aria-label={label}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-sm border',
                    tool === id
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-transparent text-text-mid hover:bg-bg-4 hover:text-text',
                  )}
                >
                  <Icon size={15} />
                </button>
              </Tooltip>
            ))}
            {/* Insert the shapes dropdown after the pen group (gi===1). */}
            {gi === 1 && (
              <DropdownMenu>
                <Tooltip content="Shapes — click to pick" side="right">
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Shapes"
                      aria-pressed={SHAPE_IDS.has(tool)}
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-sm border',
                        SHAPE_IDS.has(tool)
                          ? 'border-accent/60 bg-accent/15 text-accent'
                          : 'border-transparent text-text-mid hover:bg-bg-4 hover:text-text',
                      )}
                    >
                      {SHAPE_IDS.has(tool) && tool !== 'line' && tool !== 'arrow'
                        ? (() => {
                            const def = SHAPE_TOOLS.find((t) => t.id === tool);
                            return def ? <def.Icon size={15} /> : <Shapes size={15} />;
                          })()
                        : <Shapes size={15} />}
                    </button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="start">
                  {SHAPE_TOOLS.map(({ id, label, Icon }) => (
                    <DropdownMenuItem key={id} onSelect={() => setTool(id)}>
                      <Icon size={12} />
                      <span className="ml-2">{label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
        <div className="my-1 h-px w-6 bg-border" />
        <Tooltip content="Insert image… (or drag & drop / paste)" side="right">
          <button
            type="button"
            onClick={onInsertImage}
            aria-label="Insert image"
            className="flex h-8 w-8 items-center justify-center rounded-sm border border-transparent text-text-mid hover:bg-bg-4 hover:text-text"
          >
            <ImagePlus size={15} />
          </button>
        </Tooltip>
      </aside>

      <div
        className="absolute bottom-2 left-2 right-2 z-10 flex items-center gap-2 overflow-x-auto rounded-md border border-border bg-bg-2/95 px-2 py-1.5 shadow-lg backdrop-blur sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-2 sm:-translate-x-1/2 sm:overflow-visible"
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
              className={cn('h-6 w-6 rounded border border-border bg-transparent', !fill && 'opacity-40')}
              aria-label="Fill color"
            />
          </label>
        </Tooltip>
        <Tooltip content={fill ? 'Disable fill' : 'Enable fill'}>
          <button
            type="button"
            onClick={() => setFill(fill ? null : '#7c6aff')}
            aria-pressed={!!fill}
            className={cn(
              'rounded-sm border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider',
              fill
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-border text-text-dim hover:text-text',
            )}
          >
            {fill ? 'On' : 'Off'}
          </button>
        </Tooltip>
        <Tooltip content="Swap colors (X)">
          <Button variant="icon" size="none" onClick={swapColors} aria-label="Swap colors">
            <ArrowLeftRight size={13} />
          </Button>
        </Tooltip>
        <div className="h-5 w-px bg-border" />
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
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
        {(tool === 'polygon' || tool === 'star') && (
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <span className="text-text-dim">{tool === 'star' ? 'Points' : 'Sides'}</span>
            <input
              type="number"
              min={3}
              max={24}
              value={polySides}
              onChange={(e) => setPolySides(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              aria-label="Polygon sides"
              className="w-12 rounded-sm border border-border bg-bg-4 px-1 py-0.5 text-center font-mono outline-none focus:border-accent"
            />
          </label>
        )}
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
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

      {/* History & zoom stays top-right on every viewport. The bottom is
          reserved for the Timeline2D overlay (and the mobile style strip),
          so the two never overlap. */}
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
