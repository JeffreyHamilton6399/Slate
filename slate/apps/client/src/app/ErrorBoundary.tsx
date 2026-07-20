/**
 * Root error boundary — a crash anywhere in the tree renders a recovery
 * screen instead of a black page. "Reload app" also unregisters service
 * workers and clears caches, which fixes the classic stale-PWA-after-deploy
 * failure mode.
 */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export async function clearCachesAndReload(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
  } catch {
    /* ignore */
  }
  try {
    const keys = await caches?.keys?.();
    await Promise.all((keys ?? []).map((k) => caches.delete(k)));
  } catch {
    /* ignore */
  }
  window.location.reload();
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 z-[1000] grid place-items-center bg-bg p-6 text-center">
        <div className="flex max-w-md flex-col items-center gap-4">
          <div className="text-lg font-semibold text-text">Something went wrong</div>
          <div className="text-sm leading-relaxed text-text-dim">
            Slate hit an unexpected error. Your boards are stored safely on this
            device — reloading usually fixes it.
          </div>
          <pre className="max-h-48 w-full overflow-auto rounded-md border border-border bg-bg-2 p-2 text-left font-mono text-[11px] text-text-dim">
            {this.state.error.message}
            {this.state.error.stack && (
              '\n\n' + this.state.error.stack.split('\n').slice(0, 8).join('\n')
            )}
          </pre>
          <button
            type="button"
            onClick={() => void clearCachesAndReload()}
            className="rounded-md border border-accent/60 bg-accent/15 px-4 py-1.5 text-sm font-medium text-accent hover:bg-accent/25"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
