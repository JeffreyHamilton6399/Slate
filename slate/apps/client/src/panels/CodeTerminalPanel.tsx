/**
 * CodeTerminalPanel — a console/terminal for code boards, à la Z.ai / bolt.
 *
 * Slate runs no server-side shell, so this streams the LIVE PREVIEW's runtime
 * output: the preview iframe (code/preview.ts) posts every console.log / warn /
 * error and uncaught exception to the parent window, and this panel collects
 * them. Open the Preview panel and run your app to see output here.
 */

import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, Trash2 } from 'lucide-react';

interface Line {
  level: string;
  text: string;
  id: number;
}

const MAX_LINES = 500;

export function CodeTerminalPanel() {
  const [lines, setLines] = useState<Line[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; level?: string; text?: string } | null;
      if (!d || d.source !== 'slate-preview' || typeof d.text !== 'string') return;
      setLines((prev) => {
        const next = [...prev, { level: d.level || 'log', text: d.text as string, id: idRef.current++ }];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <TerminalSquare size={13} className="text-accent" />
        <span className="text-[11px] font-medium text-text">Terminal</span>
        <span className="font-mono text-[10px] text-text-dim">· preview console</span>
        <div className="flex-1" />
        <button
          onClick={() => setLines([])}
          title="Clear"
          className="grid h-5 w-5 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-[#0c0c0e] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[#e6e6e6]"
      >
        {lines.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-text-dim">
            No output yet. Open the <span className="text-accent">Preview</span> panel and run your app —
            console logs and errors show up here.
          </p>
        ) : (
          lines.map((l) => (
            <div
              key={l.id}
              className={`whitespace-pre-wrap break-words ${
                l.level === 'err' ? 'text-[#ff6b6b]' : l.level === 'warn' ? 'text-[#ffd166]' : ''
              }`}
            >
              {l.level === 'err' ? '✕ ' : l.level === 'warn' ? '⚠ ' : '› '}
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default CodeTerminalPanel;
