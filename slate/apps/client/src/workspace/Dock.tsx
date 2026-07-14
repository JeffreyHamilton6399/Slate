/**
 * Dock — a single side (left or right) containing a top and bottom zone,
 * each with its own tab strip + body, separated by a draggable splitter.
 *
 * Unity-style tab behavior:
 *   - drag a tab within a strip to reorder
 *   - drag a tab onto any other zone's strip (or body) to move it there
 *   - drag a tab anywhere else to detach it into a floating window
 *   - double-click a tab to float it
 *   - + menu re-opens closed panels
 *
 * The split keeps high-importance panels (Boards, Properties) visible while
 * secondary ones (Hierarchy, Chat, Notes) stack below.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../utils/cn';
import { usePanelRegistry, RenderPanel, panelMatchesMode } from './panelRegistry';
import { useDockStore, bottomZone, type DockSide, type DockZone } from './dockStore';
import { findDropTarget, createDragGhost } from './panelDrag';
import { useAppStore } from '../app/store';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/DropdownMenu';

interface DockProps {
  side: DockSide;
  className?: string;
  width: number;
  onResize: (w: number) => void;
}

export function Dock({ side, className, width, onResize }: DockProps) {
  const panels = usePanelRegistry((s) => s.panels);
  const tabOrder = useDockStore((s) => s.tabOrder);
  const dragging = useDockStore((s) => s.dragging);
  const splitRatio = useDockStore((s) => s.splitRatio[side]);
  const setSplitRatio = useDockStore((s) => s.setSplitRatio);
  const mode = useAppStore((s) => s.currentBoard?.mode ?? '2d');

  const topZone: DockZone = side;
  const botZone = bottomZone(side);
  const visible = (zone: DockZone) =>
    tabOrder[zone].filter((id) => panelMatchesMode(panels[id], mode));
  const topTabs = visible(topZone);
  const botTabs = visible(botZone);
  // Empty zones collapse; during a drag they re-appear as drop targets so a
  // tab can be dropped there to create the split. An all-empty dock keeps
  // the top zone visible as the landing area.
  const showBottom = botTabs.length > 0 || dragging;
  const showTop = topTabs.length > 0 || dragging || !showBottom;
  const split = showTop && showBottom && topTabs.length > 0 && botTabs.length > 0;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      // Root-level drop fallback: releasing a tab over dock chrome that no
      // zone claims (splitter margins, padding) docks into the top zone
      // instead of accidentally detaching into a floating window.
      data-dock-drop={topZone}
      className={cn(
        'relative flex h-full flex-col surface rounded-none border-y-0',
        side === 'left' ? 'border-l-0' : 'border-r-0',
        className,
      )}
      style={{ width }}
      ref={bodyRef}
    >
      {showTop && (
        <DockZoneSection
          zone={topZone}
          tabs={topTabs}
          style={
            split
              ? { flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 1 }
              : topTabs.length > 0
                ? { flex: 1 }
                : undefined
          }
          emptyHint="Drop a tab here"
        />
      )}
      {showBottom && (
        <>
          {split && (
            <ZoneSplitter
              dropZone={botZone}
              onDrag={(clientY) => {
                const r = bodyRef.current?.getBoundingClientRect();
                if (!r || r.height < 1) return;
                setSplitRatio(side, (clientY - r.top) / r.height);
              }}
            />
          )}
          <DockZoneSection
            zone={botZone}
            tabs={botTabs}
            style={botTabs.length > 0 ? { flex: 1 } : undefined}
            emptyHint="Drop a tab here"
          />
        </>
      )}
      <DockResizer side={side} width={width} onResize={onResize} />
    </div>
  );
}

/** One zone: tab strip + active panel body. */
function DockZoneSection({
  zone,
  tabs,
  style,
  emptyHint,
}: {
  zone: DockZone;
  tabs: string[];
  style?: React.CSSProperties;
  emptyHint?: string;
}) {
  const panels = usePanelRegistry((s) => s.panels);
  const activeTab = useDockStore((s) => s.activeTab[zone]);
  const setActiveTab = useDockStore((s) => s.setActiveTab);
  const closePanel = useDockStore((s) => s.closePanel);
  const floatPanel = useDockStore((s) => s.floatPanel);
  const dropHint = useDockStore((s) => s.dropHint);

  // If active tab id no longer exists, pick first.
  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTab !== null) setActiveTab(zone, null);
      return;
    }
    if (!activeTab || !tabs.includes(activeTab)) {
      setActiveTab(zone, tabs[0] ?? null);
    }
  }, [tabs, activeTab, setActiveTab, zone]);

  const empty = tabs.length === 0;
  return (
    <div
      data-dock-drop={zone}
      className={cn('flex min-h-0 flex-col', empty && 'flex-none')}
      style={style}
    >
      <div
        data-tab-strip={zone}
        className={cn(
          'flex items-center gap-0.5 border-b border-border px-1.5 py-1 overflow-x-auto',
          dropHint === zone && 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(124,106,255,0.55)]',
        )}
      >
        {tabs.map((id) => (
          <DraggableTab
            key={id}
            id={id}
            zone={zone}
            title={panels[id]?.title ?? id}
            active={activeTab === id}
            onSelect={() => setActiveTab(zone, id)}
            onClose={() => closePanel(id)}
            onFloat={(x, y) => floatPanel(id, { x, y })}
          />
        ))}
        {empty && (
          <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-dim">
            {emptyHint ?? 'Empty'}
          </span>
        )}
        <AddTabMenu zone={zone} />
      </div>
      {!empty && (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {activeTab ? <RenderPanel id={activeTab} /> : <EmptyDock />}
        </div>
      )}
    </div>
  );
}

/** Horizontal splitter between the two zones of a dock. */
function ZoneSplitter({
  onDrag,
  dropZone,
}: {
  onDrag: (clientY: number) => void;
  dropZone: DockZone;
}) {
  const active = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-dock-drop={dropZone}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        active.current = true;
      }}
      onPointerMove={(e) => {
        if (active.current) onDrag(e.clientY);
      }}
      onPointerUp={(e) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        active.current = false;
      }}
      className="relative z-10 -my-0.5 h-1.5 shrink-0 cursor-row-resize hover:bg-accent/40"
    />
  );
}

const DRAG_THRESHOLD = 6;

function DraggableTab({
  id,
  zone,
  title,
  active,
  onSelect,
  onClose,
  onFloat,
}: {
  id: string;
  zone: DockZone;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onFloat: (x: number, y: number) => void;
}) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
    ghost: ReturnType<typeof createDragGhost> | null;
  } | null>(null);

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    d.ghost?.destroy();
    const store = useDockStore.getState();
    store.setDropHint(null);
    store.setDragging(false);
    if (!d.dragging) {
      if (commit) onSelect();
      return;
    }
    if (!commit) return;
    const target = findDropTarget(e.clientX, e.clientY);
    if (target) {
      if (target.zone === zone) {
        // Reorder within this strip, adjusting for our own removal.
        const order = store.tabOrder[zone].filter((x) => x !== id);
        const oldIdx = store.tabOrder[zone].indexOf(id);
        let at = Math.min(target.index, order.length);
        if (Number.isFinite(target.index) && target.index > oldIdx) at = target.index - 1;
        order.splice(Math.min(at, order.length), 0, id);
        store.reorderTab(zone, order);
        store.setActiveTab(zone, id);
      } else {
        store.dockPanel(id, target.zone, Number.isFinite(target.index) ? target.index : undefined);
      }
    } else {
      onFloat(e.clientX - 60, e.clientY - 14);
    }
  };

  return (
    <div
      data-tab-id={id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, dragging: false, ghost: null };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        if (!d.dragging) {
          if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
          d.dragging = true;
          d.ghost = createDragGhost(title);
          useDockStore.getState().setDragging(true);
        }
        d.ghost?.move(e.clientX, e.clientY);
        const target = findDropTarget(e.clientX, e.clientY);
        useDockStore.getState().setDropHint(target?.zone ?? null);
      }}
      onPointerUp={(e) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        endDrag(e, true);
      }}
      onPointerCancel={(e) => endDrag(e, false)}
      onDoubleClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onFloat(r.left, r.bottom + 8);
      }}
      className={cn(
        'group flex items-center gap-1 cursor-grab active:cursor-grabbing rounded-sm px-2 py-1 text-xs font-medium whitespace-nowrap select-none',
        active ? 'bg-bg-4 text-text' : 'text-text-mid hover:text-text hover:bg-bg-3',
      )}
    >
      <span>{title}</span>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={`Close ${title}`}
        className="opacity-0 group-hover:opacity-100 text-text-dim hover:text-text rounded-sm p-0.5"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/** "+" menu listing registered panels that are currently closed. */
function AddTabMenu({ zone }: { zone: DockZone }) {
  const panels = usePanelRegistry((s) => s.panels);
  const tabOrder = useDockStore((s) => s.tabOrder);
  const panelSide = useDockStore((s) => s.panelSide);
  const openPanel = useDockStore((s) => s.openPanel);
  const mode = useAppStore((s) => s.currentBoard?.mode ?? '2d');

  const available = useMemo(
    () =>
      Object.values(panels)
        .filter((p) => panelMatchesMode(p, mode))
        .filter(
          (p) =>
            !Object.values(tabOrder).some((ids) => ids.includes(p.id)) &&
            panelSide[p.id] !== 'floating',
        )
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [panels, tabOrder, panelSide, mode],
  );

  if (available.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add panel"
          className="ml-0.5 rounded-sm p-1 text-text-dim hover:bg-bg-3 hover:text-text"
        >
          <Plus size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {available.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => openPanel(p.id, zone)}>
            {p.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyDock() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-text-dim text-center px-4">
      <span>Drag a tab here, or use the + menu to add panels.</span>
    </div>
  );
}

function DockResizer({
  side,
  width,
  onResize,
}: {
  side: DockSide;
  width: number;
  onResize: (w: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startW: width };
      }}
      onPointerMove={(e) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const next = side === 'left' ? dragRef.current.startW + dx : dragRef.current.startW - dx;
        onResize(next);
      }}
      onPointerUp={(e) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        dragRef.current = null;
      }}
      className={cn(
        'absolute top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/40',
        side === 'left' ? 'right-[-3px]' : 'left-[-3px]',
      )}
    />
  );
}
