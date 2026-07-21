/**
 * CodeTerminalPanel — a real interactive terminal for 'code' boards.
 *
 * Two roles in one pane:
 *   1. The shell prompt at the bottom. Type a command, hit Enter, the
 *      command + its output append to the log. Up/Down arrows walk command
 *      history (like every shell since ksh). The engine lives in
 *      code/terminalCommands.ts and mutates the shared Yjs doc, so a
 *      `touch foo.js` here shows up in the Files panel and on every peer.
 *   2. The live preview's console. The preview iframe (code/preview.ts)
 *      posts every console.log / warn / error and uncaught exception to the
 *      parent window; this panel still collects them and prints them with
 *      their level color, prefixed with `›`.
 *
 * Commands that the engine flags (clear, run) are interpreted by this
 * component:
 *   - `clear`  → wipes the log
 *   - `run`    → dispatches a `slate:code-refresh-preview` window event,
 *                which the CodeEditor's split-view preview AND the dockable
 *                CodePreviewPanel both listen for and rebuild on.
 *
 * Styling is intentionally "real terminal": near-black background, mono
 * font, accent-green prompt, dim grey for the help/empty hint. The whole
 * thing stays inside the editor's bottom strip and the dockable panel slot,
 * so it inherits the parent's height.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TerminalSquare, Trash2 } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { runTerminalCommand, type TerminalResult } from '../code/terminalCommands';

/** Refresh-preview event name. Dispatched by `run`; listened for in
 *  CodeEditor (split view) and CodePreviewPanel (dockable). Kept as a
 *  shared constant so both sides agree on the string. */
export const SLATE_REFRESH_PREVIEW_EVENT = 'slate:code-refresh-preview';

interface Line {
  /** Discriminator: was this line a typed command, its output, or a
   *  forwarded preview-console message? Drives the prefix + color. */
  kind: 'cmd' | 'out' | 'preview';
  /** For preview lines: 'log' | 'warn' | 'err' | 'info'. Ignored otherwise. */
  level?: string;
  text: string;
  id: number;
}

const MAX_LINES = 500;

export function CodeTerminalPanel() {
  const room = useRoom();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  // Command history: most-recent-first index 0. `histIdx` points at the
  // slot the user is currently viewing; `null` means "live input, not
  // browsing history".
  const [history, setHistory] = useState<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  // Force a re-render when histIdx changes (it's a ref because we don't
  // want a separate state tick on every arrow press to compete with the
  // input state).
  const [, setHistTick] = useState(0);
  const bumpHist = () => setHistTick((n) => n + 1);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const idRef = useRef(0);

  const appendLines = useCallback((newLines: Omit<Line, 'id'>[]) => {
    if (newLines.length === 0) return;
    setLines((prev) => {
      const next = [...prev, ...newLines.map((l) => ({ ...l, id: idRef.current++ }))];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // ---- preview-console bridge (kept from the old version) ----
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; level?: string; text?: string } | null;
      if (!d || d.source !== 'slate-preview' || typeof d.text !== 'string') return;
      appendLines([{ kind: 'preview', level: d.level || 'log', text: d.text }]);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [appendLines]);

  // ---- auto-scroll to bottom on new output ----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const focusInput = () => inputRef.current?.focus();

  // ---- run a typed command ----
  const runCommand = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      // Always echo the command line, even if empty (so Enter on a blank
      // prompt just drops a fresh `$` line, like a real shell).
      appendLines([{ kind: 'cmd', text: trimmed }]);

      if (!trimmed) return;
      // Push into history (dedup consecutive duplicates, like zsh).
      setHistory((prev) => {
        if (prev[0] === trimmed) return prev;
        return [trimmed, ...prev].slice(0, 200);
      });

      const result: TerminalResult = runTerminalCommand(room.slate, trimmed);

      if (result.clear) {
        setLines([]);
        return;
      }
      if (result.output) {
        appendLines([{ kind: 'out', text: result.output }]);
      }
      if (result.refreshPreview) {
        window.dispatchEvent(new Event(SLATE_REFRESH_PREVIEW_EVENT));
      }
    },
    [appendLines, room.slate],
  );

  // ---- input key handling ----
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(input);
      setInput('');
      histIdxRef.current = null;
      bumpHist();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = histIdxRef.current === null ? 0 : Math.min(histIdxRef.current + 1, history.length - 1);
      histIdxRef.current = next;
      setInput(history[next] ?? '');
      bumpHist();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdxRef.current === null) return;
      const next = histIdxRef.current - 1;
      if (next < 0) {
        histIdxRef.current = null;
        setInput('');
      } else {
        histIdxRef.current = next;
        setInput(history[next] ?? '');
      }
      bumpHist();
      return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+L — clear, like every shell.
      e.preventDefault();
      setLines([]);
      return;
    }
    // Any other key means the user is editing — drop out of history-browse
    // mode so further Up/Down starts from the latest entry again.
    if (histIdxRef.current !== null && e.key.length === 1) {
      histIdxRef.current = null;
      bumpHist();
    }
  };

  return (
    <div className="flex h-full flex-col" onClick={focusInput}>
      {/* header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <TerminalSquare size={13} className="text-accent" />
        <span className="text-[11px] font-medium text-text">Terminal</span>
        <span className="font-mono text-[10px] text-text-dim">· interactive · preview console</span>
        <div className="flex-1" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            setLines([]);
          }}
          title="Clear (Ctrl+L)"
          className="grid h-5 w-5 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* output log */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto bg-[#0c0c0e] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[#e6e6e6]"
      >
        {lines.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-text-dim">
            Slate terminal — type <span className="text-accent">help</span> for commands. Open the{' '}
            <span className="text-accent">Preview</span> panel to see its console output too.
          </p>
        ) : (
          lines.map((l) => <TerminalLine key={l.id} line={l} />)
        )}
      </div>

      {/* input row */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-[#0c0c0e] px-2 py-1.5 font-mono text-[11px]">
        <span className="select-none text-[#7ee787]">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Terminal input"
          placeholder="type a command, e.g. ls"
          className="flex-1 min-w-0 bg-transparent text-[#e6e6e6] placeholder:text-[#6a6a6a] caret-[#7ee787] outline-none"
        />
      </div>
    </div>
  );
}

/** A single rendered line. Switches on `kind` to pick the prefix + color. */
function TerminalLine({ line }: { line: Line }) {
  if (line.kind === 'cmd') {
    return (
      <div className="whitespace-pre-wrap break-words">
        <span className="select-none text-[#7ee787]">$</span>{' '}
        <span className="text-[#e6e6e6]">{line.text}</span>
      </div>
    );
  }
  if (line.kind === 'preview') {
    const color =
      line.level === 'err'
        ? 'text-[#ff6b6b]'
        : line.level === 'warn'
          ? 'text-[#ffd166]'
          : line.level === 'info'
            ? 'text-[#79c0ff]'
            : 'text-[#a0a0a0]';
    const prefix = line.level === 'err' ? '✕' : line.level === 'warn' ? '⚠' : '›';
    return (
      <div className={`whitespace-pre-wrap break-words ${color}`}>
        <span className="select-none">{prefix}</span> {line.text}
      </div>
    );
  }
  // command output
  return <div className="whitespace-pre-wrap break-words text-[#d0d0d0]">{line.text}</div>;
}

export default CodeTerminalPanel;
