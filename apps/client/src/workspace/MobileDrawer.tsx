/**
 * MobileDrawer — bottom sheet that replaces both docks on narrow screens.
 * Tabs are presented as a horizontal scroll strip; the body is the panel.
 */

import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';
import { usePanelRegistry, RenderPanel } from './panelRegistry';
import { useDockStore } from './dockStore';

export function MobileDrawer() {
  const open = useDockStore((s) => s.mobileDrawerOpen);
  const setMobileDrawer = useDockStore((s) => s.setMobileDrawer);
  const activeTab = useDockStore((s) => s.mobileDrawerTab);
  const panels = usePanelRegistry((s) => s.panels);
  const leftOrder = useDockStore((s) => s.tabOrder.left);
  const rightOrder = useDockStore((s) => s.tabOrder.right);

  const allTabs = useMemo(
    () => [...leftOrder, ...rightOrder].filter((id) => panels[id]),
    [leftOrder, rightOrder, panels],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setMobileDrawer]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[200] bg-black/40 animate-fade-in"
        onClick={() => setMobileDrawer(false)}
        aria-hidden
      />
      <div
        className="fixed inset-x-0 bottom-0 z-[201] flex max-h-[80vh] flex-col surface rounded-t-lg rounded-b-none border-b-0 animate-slide-up shadow-2xl"
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
        <div className="flex-1 overflow-auto p-3">
          {activeTab ? <RenderPanel id={activeTab} /> : (
            <p className="text-xs text-text-dim text-center pt-6">No panels open.</p>
          )}
        </div>
      </div>
    </>
  );
}
