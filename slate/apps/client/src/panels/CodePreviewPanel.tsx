/**
 * CodePreviewPanel — live preview for 'code' boards, à la Base44 / Z.ai.
 *
 * Builds a self-contained HTML document from the board's files (see
 * code/preview.ts) and renders it in a sandboxed <iframe srcdoc>. Auto-refreshes
 * as files change (debounced), with a manual Refresh and an auto toggle. The
 * frame runs with `allow-scripts` but NOT `allow-same-origin`, so previewed code
 * executes in a null origin and can't touch the Slate app or its storage.
 *
 * Preview is optional and non-collaborative: what you see is your local render
 * of the shared files. It doesn't execute anything until you open this panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Play, Pause, ExternalLink, Eye } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { listCodeFiles } from '../code/exportCode';
import { buildPreview, type PreviewFile } from '../code/preview';

export function CodePreviewPanel() {
  const room = useRoom();
  const [auto, setAuto] = useState(true);
  const [nonce, setNonce] = useState(0); // bumped to force a rebuild
  const [entry, setEntry] = useState<string | undefined>();
  const [reason, setReason] = useState<string | undefined>();
  const [srcDoc, setSrcDoc] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebuild = useCallback(() => {
    const files: PreviewFile[] = listCodeFiles(room.slate).map((f) => ({
      name: f.name,
      content: room.slate.codeText(f.id).toString(),
    }));
    const result = buildPreview(files);
    setEntry(result.entry);
    setReason(result.html ? undefined : result.reason);
    setSrcDoc(result.html ?? '');
  }, [room]);

  // Rebuild on mount and whenever the user forces it (nonce).
  useEffect(() => {
    rebuild();
  }, [rebuild, nonce]);

  // Auto-refresh: watch the file map + text; debounce so a burst of keystrokes
  // (or an AI writing several files) collapses into one rebuild.
  useEffect(() => {
    if (!auto) return;
    const files = room.slate.codeFiles();
    const onChange = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(rebuild, 400);
    };
    files.observeDeep(onChange);
    // Text lives in separate top-level Y.Texts; observe the doc for any update
    // so edits to file *contents* also trigger a refresh.
    room.slate.doc.on('update', onChange);
    return () => {
      files.unobserveDeep(onChange);
      room.slate.doc.off('update', onChange);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [auto, room, rebuild]);

  const openInTab = () => {
    if (!srcDoc) return;
    const blob = new Blob([srcDoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Eye size={13} className="text-accent" />
        <span className="text-[11px] font-medium text-text">Preview</span>
        {entry && <span className="truncate font-mono text-[10px] text-text-dim">· {entry}</span>}
        <div className="flex-1" />
        <button
          onClick={() => setAuto((v) => !v)}
          title={auto ? 'Auto-refresh on' : 'Auto-refresh off'}
          aria-pressed={auto}
          className={`grid h-6 w-6 place-items-center rounded ${auto ? 'text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'}`}
        >
          {auto ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <button
          onClick={() => setNonce((n) => n + 1)}
          title="Refresh preview"
          className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={openInTab}
          disabled={!srcDoc}
          title="Open preview in a new tab"
          className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40"
        >
          <ExternalLink size={12} />
        </button>
      </div>
      <div className="relative flex-1 min-h-0 bg-white">
        {srcDoc ? (
          <iframe
            key={nonce}
            title="Code preview"
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-xs text-text-dim">
            {reason ?? 'Nothing to preview yet.'}
          </div>
        )}
      </div>
    </div>
  );
}

export default CodePreviewPanel;
