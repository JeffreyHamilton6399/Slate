/**
 * DiagramToolsPanel — tools, node palette, and connector styling for diagram
 * boards, shown in the left dock. Node/edge DATA lives in Yjs; this panel only
 * drives the local diagram store and, for the current selection, dispatches
 * style intents over the diagramBridge window-event channel.
 */

import {
  MousePointer2, Square, Circle, Diamond, StickyNote, Pill, RectangleHorizontal,
  Hexagon, Database, Triangle, Spline, Hand, Minus, Waypoints, Magnet,
  type LucideIcon,
} from 'lucide-react';
import type { DiagramEdgeRouting } from '@slate/sync-protocol';
import { cn } from '../utils/cn';
import { useDiagramStore, DIAGRAM_SWATCHES, type DiagramTool } from '../diagram/store';
import { applyDiagramStyle } from '../diagram/diagramBridge';

const TOOLS: { id: DiagramTool; label: string; key: string; Icon: LucideIcon }[] = [
  { id: 'select', label: 'Select', key: 'V', Icon: MousePointer2 },
  { id: 'rect', label: 'Box', key: 'R', Icon: Square },
  { id: 'pill', label: 'Pill', key: 'P', Icon: Pill },
  { id: 'ellipse', label: 'Ellipse', key: 'O', Icon: Circle },
  { id: 'diamond', label: 'Diamond', key: 'D', Icon: Diamond },
  { id: 'parallelogram', label: 'Data', key: 'G', Icon: RectangleHorizontal },
  { id: 'hexagon', label: 'Hexagon', key: 'X', Icon: Hexagon },
  { id: 'cylinder', label: 'Database', key: 'Y', Icon: Database },
  { id: 'triangle', label: 'Triangle', key: 'I', Icon: Triangle },
  { id: 'note', label: 'Sticky', key: 'N', Icon: StickyNote },
  { id: 'connect', label: 'Connect', key: 'C', Icon: Spline },
  { id: 'pan', label: 'Pan', key: 'H', Icon: Hand },
];

const ROUTINGS: { id: DiagramEdgeRouting; label: string; Icon: LucideIcon }[] = [
  { id: 'straight', label: 'Straight', Icon: Minus },
  { id: 'curved', label: 'Curved', Icon: Spline },
  { id: 'elbow', label: 'Elbow', Icon: Waypoints },
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h5 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">{children}</h5>;
}

export function DiagramToolsPanel() {
  const tool = useDiagramStore((s) => s.tool);
  const setTool = useDiagramStore((s) => s.setTool);
  const fill = useDiagramStore((s) => s.fill);
  const setSwatch = useDiagramStore((s) => s.setSwatch);
  const routing = useDiagramStore((s) => s.routing);
  const setRouting = useDiagramStore((s) => s.setRouting);
  const dashed = useDiagramStore((s) => s.dashed);
  const setDashed = useDiagramStore((s) => s.setDashed);
  const snap = useDiagramStore((s) => s.snap);
  const toggleSnap = useDiagramStore((s) => s.toggleSnap);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <SectionTitle>Tools</SectionTitle>
        <div className="grid grid-cols-3 gap-1">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              onClick={() => setTool(t.id)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md border px-1 py-2',
                tool === t.id
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-border bg-bg-2 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text',
              )}
            >
              <t.Icon size={16} />
              <span className="text-[9px] leading-tight">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Node color</SectionTitle>
        <div className="grid grid-cols-7 gap-1">
          {DIAGRAM_SWATCHES.map((s) => (
            <button
              key={s.fill}
              type="button"
              title="Set node color"
              aria-label="Set node color"
              onClick={() => {
                setSwatch(s);
                // Recolor any current selection too (Figma-style).
                applyDiagramStyle({ fill: s.fill, stroke: s.stroke });
              }}
              className={cn(
                'aspect-square rounded-md border-2 transition-transform hover:scale-105',
                fill === s.fill ? 'border-accent' : 'border-border',
              )}
              style={{ background: s.fill }}
            >
              <span className="block h-full w-full rounded-sm" style={{ boxShadow: `inset 0 0 0 2px ${s.stroke}` }} />
            </button>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle>Connector</SectionTitle>
        <div className="grid grid-cols-3 gap-1">
          {ROUTINGS.map((r) => (
            <button
              key={r.id}
              type="button"
              title={`${r.label} connector`}
              aria-label={`${r.label} connector`}
              aria-pressed={routing === r.id}
              onClick={() => {
                setRouting(r.id);
                // Re-route a selected connector to match.
                applyDiagramStyle({ routing: r.id });
              }}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md border px-1 py-2',
                routing === r.id
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-border bg-bg-2 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text',
              )}
            >
              <r.Icon size={16} />
              <span className="text-[9px] leading-tight">{r.label}</span>
            </button>
          ))}
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-text-mid">
          <input
            type="checkbox"
            checked={dashed}
            onChange={(e) => {
              setDashed(e.target.checked);
              applyDiagramStyle({ dashed: e.target.checked });
            }}
            className="accent-accent"
          />
          Dashed line
        </label>
      </div>

      <div>
        <SectionTitle>Canvas</SectionTitle>
        <button
          type="button"
          onClick={toggleSnap}
          aria-pressed={snap}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-[11px]',
            snap
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-border bg-bg-2 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text',
          )}
        >
          <Magnet size={14} />
          Snap to grid
          <span className="ml-auto font-mono text-[10px] opacity-70">{snap ? 'on' : 'off'}</span>
        </button>
      </div>

      <p className="text-[10px] leading-snug text-text-dim">
        Pick a shape and click the canvas, or double-click empty space to drop a box. Hover a node
        and drag a dot to connect it. Double-click a connector to label it. Select something, then
        pick a color or connector style above to restyle it.
      </p>
    </div>
  );
}

export default DiagramToolsPanel;
