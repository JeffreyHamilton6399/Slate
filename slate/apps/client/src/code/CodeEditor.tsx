/**
 * CodeEditor — collaborative multi-file code surface for 'code' boards.
 *
 * CodeMirror 6 bound to one shared Y.Text per file via y-codemirror.next
 * (yCollab): concurrent typing merges through Yjs, remote peers' carets and
 * selections render inline with their presence color/name, and undo is a
 * per-file Y.UndoManager scoped to YOUR edits (yUndoManagerKeymap — CM's own
 * history is deliberately not installed, two histories would fight Ctrl+Z).
 *
 * Files live in the `code:files` Y.Map (id → { name }); each file's content
 * is a top-level Y.Text (`code:text:<id>`) so every client resolves the same
 * shared type. The creator seeds `main.js` on an empty board. Language is
 * auto-detected from the filename via @codemirror/language-data, which
 * dynamically imports only the grammars actually used.
 *
 * Code does NOT execute — this is a shared editor, not a runtime.
 */

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { FileCode2, FilePlus2, Pencil, Trash2, Download, Archive } from 'lucide-react';
import { colorForPeerId } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { listCodeFiles, codeZipBlob } from './exportCode';
import { toast } from '../ui/Toast';
import './codeEditor.css';

export function CodeEditor() {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const [, bump] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [langName, setLangName] = useState('Plain text');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Re-render on file map changes (add/rename/delete, local or remote).
  useEffect(() => {
    const files = room.slate.codeFiles();
    const fn = () => bump((v) => v + 1);
    files.observeDeep(fn);
    return () => files.unobserveDeep(fn);
  }, [room]);

  // Creator seeds the first file on an empty board (IndexedDB is hydrated
  // before the workspace mounts, so an existing board never looks empty).
  useEffect(() => {
    const files = room.slate.codeFiles();
    if (files.size === 0 && board?.iAmCreator) {
      const meta = new Y.Map<unknown>();
      meta.set('name', 'main.js');
      files.set(nanoid(8), meta);
    }
  }, [room, board?.iAmCreator]);

  const files = listCodeFiles(room.slate);
  const activeId = files.some((f) => f.id === selectedId) ? selectedId : files[0]?.id ?? null;
  const activeName = files.find((f) => f.id === activeId)?.name ?? '';

  // Mount CodeMirror for the active file. Recreated on file switch/rename
  // (rename can change the language) — cheap, and Yjs owns the content.
  useEffect(() => {
    const host = hostRef.current;
    const awareness = room.provider.awareness;
    if (!host || !activeId || !awareness) return;

    const ytext = room.slate.codeText(activeId);
    const undoManager = new Y.UndoManager(ytext);
    // y-codemirror reads the awareness `user` field for caret labels/colors —
    // same palette the People widget and doc-mode cursors use.
    const color = colorForPeerId(room.identity.peerId);
    awareness.setLocalStateField('user', { name: room.identity.name, color, colorLight: `${color}33` });

    const languageConf = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          languageConf.of([]),
          // yUndoManagerKeymap first: Mod-z must hit the Yjs undo manager
          // (CM's history extension is intentionally absent).
          keymap.of([...yUndoManagerKeymap, ...closeBracketsKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
          yCollab(ytext, awareness, { undoManager }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;

    const desc = LanguageDescription.matchFilename(languages, activeName);
    setLangName(desc?.name ?? 'Plain text');
    if (desc) {
      void desc
        .load()
        .then((support) => view.dispatch({ effects: languageConf.reconfigure(support) }))
        .catch(() => {/* grammar failed to load — plain text is fine */});
    }

    return () => {
      view.destroy();
      viewRef.current = null;
      undoManager.destroy();
    };
  }, [room, activeId, activeName]);

  const addFile = () => {
    // eslint-disable-next-line no-alert
    const name = window.prompt('File name', 'untitled.js')?.trim();
    if (!name) return;
    const meta = new Y.Map<unknown>();
    meta.set('name', name);
    const id = nanoid(8);
    room.slate.codeFiles().set(id, meta);
    setSelectedId(id);
  };

  const renameFile = (id: string, current: string) => {
    // eslint-disable-next-line no-alert
    const name = window.prompt('Rename file', current)?.trim();
    if (!name || name === current) return;
    room.slate.codeFiles().get(id)?.set('name', name);
  };

  const deleteFile = (id: string, name: string) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${name}? The file disappears for everyone on this board.`)) return;
    room.slate.codeFiles().delete(id);
    if (selectedId === id) setSelectedId(null);
  };

  const downloadFile = () => {
    if (!activeId) return;
    const blob = new Blob([room.slate.codeText(activeId).toString()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = activeName || 'file.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  };

  const downloadZip = () => {
    if (files.length === 0) {
      toast({ title: 'Nothing to export', description: 'Add a file first.' });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(codeZipBlob(room.slate));
    a.download = `${board?.name ?? 'slate-code'}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  };

  const lineCount = activeId ? room.slate.codeText(activeId).toString().split('\n').length : 0;

  return (
    <div className="flex h-full bg-bg text-text">
      {/* File rail */}
      <div className="flex w-48 shrink-0 flex-col border-r border-border bg-bg-2">
        {/* Zip lives up here, not at the rail's bottom — the floating People
            widget hovers over the bottom-left corner and would cover it. */}
        <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">Files</span>
          <span className="flex gap-0.5">
            <button type="button" title="Download all as .zip" aria-label="Download all as .zip" onClick={downloadZip} className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text">
              <Archive size={13} />
            </button>
            <button type="button" title="New file" aria-label="New file" onClick={addFile} className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text">
              <FilePlus2 size={13} />
            </button>
          </span>
        </div>
        <ul className="flex-1 overflow-y-auto p-1">
          {files.map((f) => (
            <li key={f.id} className="group relative">
              <button
                type="button"
                onClick={() => setSelectedId(f.id)}
                onDoubleClick={() => renameFile(f.id, f.name)}
                title={f.name}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs ${
                  f.id === activeId ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'
                }`}
              >
                <FileCode2 size={12} className="shrink-0" />
                <span className="truncate">{f.name}</span>
              </button>
              <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex">
                <button type="button" title={`Rename ${f.name}`} onClick={() => renameFile(f.id, f.name)} className="grid h-5 w-5 place-items-center rounded bg-bg-2/90 text-text-dim hover:text-text">
                  <Pencil size={10} />
                </button>
                <button type="button" title={`Delete ${f.name}`} onClick={() => deleteFile(f.id, f.name)} className="grid h-5 w-5 place-items-center rounded bg-bg-2/90 text-text-dim hover:text-danger">
                  <Trash2 size={10} />
                </button>
              </span>
            </li>
          ))}
          {files.length === 0 && (
            <li className="px-2 py-4 text-center text-[11px] text-text-dim">No files yet.</li>
          )}
        </ul>
      </div>

      {/* Editor column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-bg-2 px-3 py-1.5">
          <span className="truncate font-mono text-xs text-text">{activeName || '—'}</span>
          <div className="flex-1" />
          <button type="button" title="Download this file" aria-label="Download this file" onClick={downloadFile} disabled={!activeId} className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40">
            <Download size={13} />
          </button>
        </div>
        {activeId ? (
          <div ref={hostRef} className="slate-code-host flex-1" />
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-text-dim">
            <button type="button" onClick={addFile} className="rounded border border-border px-3 py-1.5 hover:bg-bg-3">
              Create a file to start coding together
            </button>
          </div>
        )}
        <div className="flex items-center gap-3 border-t border-border bg-bg-2 px-3 py-1 font-mono text-[10px] text-text-dim">
          <span>{langName}</span>
          <span>{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
          <div className="flex-1" />
          <span>shared · every keystroke syncs</span>
        </div>
      </div>
    </div>
  );
}

export default CodeEditor;
