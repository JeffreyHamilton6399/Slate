/**
 * RecoverBoundary — isolates a subtree so a render/runtime throw inside it
 * shows a small inline recovery card (with Retry) instead of unmounting the
 * whole app via the root ErrorBoundary.
 *
 * Used around each dock panel and around the central board surface, so a crash
 * in one editor or panel leaves the header, docks, and everything else usable.
 */

import { Component, type ReactNode } from 'react';

interface Props {
  /** Human-readable name of what failed, e.g. a panel title or "The editor". */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RecoverBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="text-sm font-medium text-text">{this.props.label} hit an error</div>
        <p className="text-xs text-text-dim">The rest of Slate is still running.</p>
        <pre className="max-h-24 w-full max-w-md overflow-auto rounded border border-border bg-bg-2 p-2 text-left font-mono text-[10px] text-text-dim">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={this.reset}
          className="rounded border border-accent/60 bg-accent/15 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/25"
        >
          Retry
        </button>
      </div>
    );
  }
}
