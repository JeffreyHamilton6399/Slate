/**
 * Tools panel — a dockable grid of every 2D tool with names + shortcuts.
 * Complements the compact left rail: same store, so selecting a tool in
 * either place stays in sync. Tools can be favorited (star), which pins them
 * to a Favorites group at the top.
 *
 * Tiles are icon-over-label, matching the Diagram and Doc tool panels. The
 * previous icon-BESIDE-label rows left roughly 40px for text at the default
 * dock width, which truncated every tool to its first letter ("S…", "P…",
 * "M…") — the panel's entire reason to exist over the icon rail. Column count
 * follows the dock width so widening the dock shows more per row.
 */

import { useEffect, useRef, useState } from 'react';
import {
  MousePointer2,
  Pencil,
  Highlighter,
  Eraser,
  Square,
  Circle,
  Triangle,
  Hexagon,
  Star,
  Slash,
  ArrowUpRight,
  Type as TypeIcon,
  Pipette,
  PaintBucket,
  Hand,
  Brush,
  Pen as PenIcon,
  Wind,
  Heart,
  Cloud,
  MessageCircle,
  Diamond as DiamondIcon,
  Pentagon,
} from 'lucide-react';
import { cn } from '../utils/cn';
import { useCanvasStore, type ToolId } from '../canvas2d/store';

type ToolDef = { id: ToolId; label: string; Icon: typeof Pencil; shortcut: string };

const GROUPS: { title: string; tools: ToolDef[] }[] = [
  {
    title: 'Navigate',
    tools: [
      { id: 'select', label: 'Select', Icon: MousePointer2, shortcut: 'V' },
      { id: 'pan', label: 'Pan', Icon: Hand, shortcut: 'H' },
    ],
  },
  {
    title: 'Draw',
    tools: [
      { id: 'pen', label: 'Pen', Icon: Pencil, shortcut: 'P' },
      { id: 'pencil', label: 'Pencil', Icon: PenIcon, shortcut: 'N' },
      { id: 'marker', label: 'Marker', Icon: Brush, shortcut: 'M' },
      { id: 'calligraphy', label: 'Calligraphy', Icon: Pencil, shortcut: 'C' },
      { id: 'airbrush', label: 'Airbrush', Icon: Wind, shortcut: 'B' },
      { id: 'highlighter', label: 'Highlighter', Icon: Highlighter, shortcut: 'Y' },
      { id: 'eraser', label: 'Eraser', Icon: Eraser, shortcut: 'E' },
    ],
  },
  {
    title: 'Shapes',
    tools: [
      { id: 'rect', label: 'Rectangle', Icon: Square, shortcut: 'R' },
      { id: 'ellipse', label: 'Ellipse', Icon: Circle, shortcut: 'O' },
      { id: 'triangle', label: 'Triangle', Icon: Triangle, shortcut: 'G' },
      { id: 'diamond', label: 'Diamond', Icon: DiamondIcon, shortcut: 'D' },
      { id: 'pentagon', label: 'Pentagon', Icon: Pentagon, shortcut: '5' },
      { id: 'hexagon', label: 'Hexagon', Icon: Hexagon, shortcut: 'U' },
      { id: 'parallelogram', label: 'Parallelogram', Icon: Square, shortcut: 'P' },
      { id: 'trapezoid', label: 'Trapezoid', Icon: Square, shortcut: 'Z' },
      { id: 'cross', label: 'Cross', Icon: Square, shortcut: 'X' },
      { id: 'polygon', label: 'Polygon', Icon: Hexagon, shortcut: 'U' },
      { id: 'star', label: 'Star', Icon: Star, shortcut: 'S' },
      { id: 'heart', label: 'Heart', Icon: Heart, shortcut: 'H' },
      { id: 'cloud', label: 'Cloud', Icon: Cloud, shortcut: 'C' },
      { id: 'speech', label: 'Speech Bubble', Icon: MessageCircle, shortcut: 'B' },
      { id: 'line', label: 'Line', Icon: Slash, shortcut: 'L' },
      { id: 'arrow', label: 'Arrow', Icon: ArrowUpRight, shortcut: 'A' },
      { id: 'text', label: 'Text', Icon: TypeIcon, shortcut: 'T' },
    ],
  },
  {
    title: 'Color',
    tools: [
      { id: 'eyedropper', label: 'Eyedropper', Icon: Pipette, shortcut: 'I' },
      { id: 'fill', label: 'Fill', Icon: PaintBucket, shortcut: 'K' },
    ],
  },
];

const ALL_TOOLS: Record<string, ToolDef> = Object.fromEntries(
  GROUPS.flatMap((g) => g.tools).map((t) => [t.id, t]),
);

/** Tile columns by available panel width. Tiles want ~62px each. */
function columnsFor(width: number): number {
  return Math.max(2, Math.min(6, Math.floor(width / 62)));
}

export function ToolsPanel() {
  const tool = useCanvasStore((s) => s.tool);
  const setTool = useCanvasStore((s) => s.setTool);
  const favorites = useCanvasStore((s) => s.favorites);
  const toggleFavorite = useCanvasStore((s) => s.toggleFavorite);

  const favTools = favorites.map((id) => ALL_TOOLS[id]).filter(Boolean) as ToolDef[];

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width;
      if (w) setCols(columnsFor(w));
    });
    ro.observe(el);
    setCols(columnsFor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const ToolButton = ({ id, label, Icon, shortcut }: ToolDef) => {
    const fav = favorites.includes(id);
    return (
      <div className="group relative">
        <button
          type="button"
          onClick={() => setTool(id)}
          aria-pressed={tool === id}
          title={`${label} (${shortcut})`}
          className={cn(
            'flex w-full flex-col items-center gap-1 rounded-md border px-1 py-2',
            tool === id
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-border bg-bg-2 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text',
          )}
        >
          <Icon size={16} />
          {/* Two lines max: "Parallelogram" and "Speech Bubble" don't fit one. */}
          <span className="line-clamp-2 text-center text-[9px] leading-tight">{label}</span>
        </button>
        <kbd className="pointer-events-none absolute left-1 top-1 font-mono text-[8px] text-text-dim">
          {shortcut}
        </kbd>
        <button
          type="button"
          onClick={() => toggleFavorite(id)}
          aria-label={fav ? `Unfavorite ${label}` : `Favorite ${label}`}
          aria-pressed={fav}
          title={fav ? 'Remove from favorites' : 'Add to favorites'}
          className={cn(
            'absolute right-0.5 top-0.5 rounded p-0.5 transition-opacity',
            fav
              ? 'text-warn opacity-100'
              : 'text-text-dim opacity-0 hover:text-text group-hover:opacity-100',
          )}
        >
          <Star size={11} fill={fav ? 'currentColor' : 'none'} />
        </button>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="flex h-full flex-col gap-3 overflow-y-auto p-2">
      {favTools.length > 0 && (
        <div>
          <h5 className="panel-title mb-1.5 flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
            <Star size={9} className="text-warn" fill="currentColor" /> Favorites
          </h5>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {favTools.map((t) => (
              <ToolButton key={`fav-${t.id}`} {...t} />
            ))}
          </div>
        </div>
      )}
      {GROUPS.map((group) => (
        <div key={group.title}>
          <h5 className="panel-title mb-1.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
            {group.title}
          </h5>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {group.tools.map((t) => (
              <ToolButton key={t.id} {...t} />
            ))}
          </div>
        </div>
      ))}
      {favTools.length === 0 && (
        <p className="mt-1 text-[10px] text-text-dim">
          Tip: hover a tool and tap the <Star size={9} className="inline" /> to pin it to Favorites.
        </p>
      )}
    </div>
  );
}
