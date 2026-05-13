/**
 * Dock — a single side (left or right) containing tabs + body.
 *
 * Tab drag uses dnd-kit; dragging a tab off the dock (vertical or to the
 * other side) detaches/redocks via dockStore.setPanelSide.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';
import { usePanelRegistry, RenderPanel, type DockSide } from './panelRegistry';
import { useDockStore } from './dockStore';

interface DockProps {
  side: DockSide;
  className?: string;
  width: number;
  onResize: (w: number) => void;
}

export function Dock({ side, className, width, onResize }: DockProps) {
  const panels = usePanelRegistry((s) => s.panels);
  const tabOrder = useDockStore((s) => s.tabOrder[side]);
  const activeTab = useDockStore((s) => s.activeTab[side]);
  const setActiveTab = useDockStore((s) => s.setActiveTab);
  const removeTab = useDockStore((s) => s.removeTab);
  const reorderTab = useDockStore((s) => s.reorderTab);
  const setPanelSide = useDockStore((s) => s.setPanelSide);

  const visibleTabs = useMemo(
    () => tabOrder.filter((id) => panels[id]),
    [tabOrder, panels],
  );

  // If active tab id no longer exists, pick first.
  useEffect(() => {
    if (visibleTabs.length === 0) {
      if (activeTab !== null) setActiveTab(side, null);
      return;
    }
    if (!activeTab || !visibleTabs.includes(activeTab)) {
      setActiveTab(side, visibleTabs[0] ?? null);
    }
  }, [visibleTabs, activeTab, setActiveTab, side]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = visibleTabs.indexOf(String(active.id));
    const newIdx = visibleTabs.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    reorderTab(side, arrayMove(visibleTabs, oldIdx, newIdx));
  };

  return (
    <div
      className={cn(
        'relative flex h-full flex-col surface rounded-none border-y-0',
        side === 'left' ? 'border-l-0' : 'border-r-0',
        className,
      )}
      style={{ width }}
    >
      <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1 overflow-x-auto">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleTabs} strategy={horizontalListSortingStrategy}>
            {visibleTabs.map((id) => (
              <SortableTab
                key={id}
                id={id}
                title={panels[id]?.title ?? id}
                active={activeTab === id}
                onSelect={() => setActiveTab(side, id)}
                onClose={() => removeTab(side, id)}
                onDetach={() => {
                  // Move to other side as a quick stand-in for floating.
                  const other: DockSide = side === 'left' ? 'right' : 'left';
                  setPanelSide(id, other);
                  removeTab(side, id);
                  useDockStore.getState().ensureTab(other, id);
                  useDockStore.getState().setActiveTab(other, id);
                }}
              />
            ))}
          </SortableContext>
          <DragOverlay />
        </DndContext>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {activeTab ? <RenderPanel id={activeTab} /> : <EmptyDock />}
      </div>
      <DockResizer side={side} width={width} onResize={onResize} />
    </div>
  );
}

function SortableTab({
  id,
  title,
  active,
  onSelect,
  onClose,
  onDetach,
}: {
  id: string;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDetach: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onDoubleClick={onDetach}
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-1 cursor-grab active:cursor-grabbing rounded-sm px-2 py-1 text-xs font-medium whitespace-nowrap select-none',
        active ? 'bg-bg-4 text-text' : 'text-text-mid hover:text-text hover:bg-bg-3',
      )}
    >
      <span>{title}</span>
      <button
        type="button"
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

function EmptyDock() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-text-dim text-center px-4">
      <span>Drag panels here, or right-click a panel id in settings.</span>
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
