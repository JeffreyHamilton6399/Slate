/**
 * MobileDrawer — bottom sheet that replaces both docks on narrow screens.
 * Tabs are presented as a horizontal scroll strip; the body is the panel.
 *
 * It also owns the button that OPENS it. Nothing else in the app called
 * setMobileDrawer(true), so on a phone every dock panel — Layers, Tools,
 * Properties, Hierarchy, Files, Preview, the AI assistant, Chat, Notes,
 * Friends, the audio racks, the slide layouts — was unreachable.
 */

import { useEffect, useMemo } from 'react';
import { PanelsTopLeft, X } from 'lucide-react';
import { cn } from '../utils/cn';
import { usePanelRegistry, RenderPanel, panelMatchesMode } from './panelRegistry';
import { useDockStore } from './dockStore';
import { useAppStore } from '../app/store';

export function MobileDrawer() {
  const open = useDockStore((s) => s.mobileDrawerOpen);
  const setMobileDrawer = useDockStore((s) => s.setMobileDrawer);
  const activeTab = useDockStore((s) => s.mobileDrawerTab);
  const panels = usePanelRegistry((s) => s.panels);
  const tabOrder = useDockStore((s) => s.tabOrder);

  const mode = useAppStore((s) => s.currentBoard?.mode ?? '2d');
  const allTabs = useMemo(
    () =>
      [
        ...tabOrder.left,
        ...tabOrder['left-bottom'],
        ...tabOrder.right,
        ...tabOrder['right-bottom'],
      ].filter((id) => panelMatchesMode(panels[id], mode)),
    [tabOrder, panels, mode],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setMobileDrawer]);

  // Opening with no (or a now-hidden) active tab would show an empty sheet —
  // auto-select the first available panel so there's always content.
  useEffect(() => {
    if (!open) return;
    if (!activeTab || !allTabs.includes(activeTab)) {
      if (allTabs.length) setMobileDrawer(true, allTabs[0]);
    }
  }, [open, activeTab, allTabs, setMobileDrawer]);

  // Closed: show the launcher. Bottom-RIGHT, clear of the People widget
  // (bottom-left) and raised above each editor's bottom status strip.
  if (!open) {
    if (allTabs.length === 0) return null;
    return (
      <button
        type="button"
        aria-label="Open panels"
        title="Panels"
        onClick={() => setMobileDrawer(true, activeTab ?? allTabs[0] ?? null)}
        className="fixed bottom-16 right-3 z-[150] grid h-12 w-12 place-items-center rounded-full border border-border bg-bg-2/95 text-text-mid shadow-xl backdrop-blur transition-transform active:scale-95"
        style={{ marginBottom: 'var(--safe-bottom, 0px)' }}
      >
        <PanelsTopLeft size={20} />
      </button>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[200] bg-black/40 animate-fade-in"
        onClick={() => setMobileDrawer(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Panels"
        data-mobile-drawer
        className="fixed inset-x-0 bottom-0 z-[201] flex max-h-[80vh] flex-col surface rounded-t-lg rounded-b-none border-b-0 shadow-2xl"
        style={{ paddingBottom: 'var(--safe-bottom, 0px)' }}
      >
        <div className="flex items-center gap-1 border-b border-border px-2 py-2 overflow-x-auto">
          {allTabs.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setMobileDrawer(true, id)}
              className={cn(
                'rounded-sm px-3 py-1.5 text-xs font-medium whitespace-nowrap',
                activeTab === id ? 'bg-bg-4 text-text' : 'text-text-mid hover:text-text hover:bg-bg-3',
              )}
            >
              {panels[id]?.title ?? id}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Close panels"
            onClick={() => setMobileDrawer(false)}
            className="p-1.5 text-text-dim hover:text-text"
          >
            <X size={16} />
          </button>
        </div>
        <div key={activeTab ?? 'empty'} data-panel-content className="flex-1 overflow-auto p-3">
          {activeTab ? <RenderPanel id={activeTab} /> : (
            <p className="text-xs text-text-dim text-center pt-6">No panels open.</p>
          )}
        </div>
      </div>
    </>
  );
}
