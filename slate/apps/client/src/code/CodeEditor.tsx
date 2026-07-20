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
 * Polish (ROUND14-B):
 *   - Fold gutter + indent-on-input + indent unit (2 spaces) so nested code
 *     shows structure at a glance.
 *   - Light/dark theme toggle. oneDark by default; the light theme is a CM
 *     `EditorView.theme({ dark: false })` that lets the page tokens through.
 *   - Tab strip above the editor: any file you click becomes a tab, middle-
 *     click or the × on the tab closes it. The editor body always reflects
 *     the active tab — clicking the same file in the rail is idempotent.
 *   - A Find button in the toolbar that dispatches a synthetic Ctrl+F so
 *     CM's built-in search panel (already bound via searchKeymap) opens.
 *
 * Code does NOT execute — this is a shared editor, not a runtime.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle,
  foldGutter, indentUnit, LanguageDescription,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import {
  FileCode2, FilePlus2, Pencil, Trash2, Download, Archive, Search, Sun, Moon, X,
} from 'lucide-react';
import { colorForPeerId } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { listCodeFiles, codeZipBlob } from './exportCode';
import { toast } from '../ui/Toast';
import './codeEditor.css';

/**
 * Light theme — an empty rule set marked `{ dark: false }`. CM treats this as
 * "light mode": it skips oneDark and lets the page tokens (via the
 * `.slate-code-host .cm-editor { background: var(--bg) }` rules in
 * codeEditor.css) carry the surface. Syntax tokens fall back to
 * `defaultHighlightStyle` (already installed below), which has its own light
 * palette. Together they read well on both light and dark app themes.
 */
const lightTheme = EditorView.theme({}, { dark: false });

export function CodeEditor() {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const [, bump] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [langName, setLangName] = useState('Plain text');
  const [darkMode, setDarkMode] = useState(true);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The rail/host wrapper — used by the Find button so it can dispatch a
  // synthetic Ctrl+F into the editor regardless of which child has focus.
  const editorWrapperRef = useRef<HTMLDivElement | null>(null);

  // Tab strip state: every file the user has clicked becomes a tab. Clicking
  // the same file in the rail is a no-op for openFiles; closing a tab removes
  // it but does NOT delete the file from Yjs (use the rail's trash icon for
  // that). activeFileId drives which Y.Text the editor binds to.
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

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

  // Drop tabs whose files were deleted remotely (or that never existed). The
  // rail's click handler is the sole entry point for adding tabs, so this
  // pass only ever shrinks `openFiles`.
  const validOpenFiles = useMemo(
    () => openFiles.filter((id) => files.some((f) => f.id === id)),
    [openFiles, files],
  );
  if (validOpenFiles.length !== openFiles.length) {
    // Schedule the state update — mutating during render is illegal.
    setTimeout(() => setOpenFiles(validOpenFiles), 0);
  }

  // activeFileId falls back to selectedId (legacy single-file click), then to
  // the first open tab, then to the first file in the rail. Keeping the
  // selectedId fallback means existing call sites that only call setSelectedId
  // still do the right thing.
  const activeId =
    (activeFileId && files.some((f) => f.id === activeFileId) && activeFileId) ||
    (selectedId && files.some((f) => f.id === selectedId) && selectedId) ||
    validOpenFiles[0] ||
    files[0]?.id ||
    null;
  const activeName = files.find((f) => f.id === activeId)?.name ?? '';

  /** Open a file: add to tabs (if not already) and set active. Idempotent.
   *  Wrapped in useCallback so the open-file event listener below doesn't
   *  re-bind on every render — the state setters are stable across renders,
   *  so the callback identity stays put. */
  const openFile = useCallback((id: string) => {
    setSelectedId(id);
    setActiveFileId(id);
    setOpenFiles((cur) => (cur.includes(id) ? cur : [...cur, id]));
  }, []);

  // Listen for open-file events from the dockable CodeFilesPanel and
  // CodeSearchPanel — they only know the file id and ask the editor (which
  // owns the tab/active state) to actually open it. Window-level so the
  // panel doesn't need to import the editor or be a child of it.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ id: string }>;
      if (!ev.detail?.id) return;
      // Make sure the file still exists before opening — a stale event for
      // a deleted file would otherwise create a phantom tab.
      if (!room.slate.codeFiles().has(ev.detail.id)) return;
      openFile(ev.detail.id);
    };
    window.addEventListener('slate:code-open-file', handler as EventListener);
    return () => window.removeEventListener('slate:code-open-file', handler as EventListener);
  }, [room, openFile]);

  /** Close a tab. If it was active, fall through to the previous tab. */
  const closeTab = (id: string) => {
    setOpenFiles((cur) => {
      const idx = cur.indexOf(id);
      const next = cur.filter((x) => x !== id);
      // Only re-assign the active tab if we closed the active one — closing a
      // background tab should never jump the editor.
      if (id === activeFileId) {
        const fallback = next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? null;
        setActiveFileId(fallback);
        setSelectedId(fallback);
      }
      return next;
    });
  };

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
    const themeConf = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          dropCursor(),
          // indentUnit BEFORE indentOnInput so the latter knows what to insert
          // on a fresh line (2 spaces — matches what most grammars expect for
          // JS/TS/CSS/etc., and what pressing Tab produces via indentWithTab).
          indentUnit.of('  '),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // Fold gutter lives in the gutter column to the right of line
          // numbers; clicking a marker toggles the fold for that block.
          foldGutter({
            markerDOM: (open) => {
              const el = document.createElement('span');
              el.textContent = open ? '▾' : '▸';
              el.style.cursor = 'pointer';
              el.style.opacity = '0.6';
              el.style.fontSize = '10px';
              el.style.padding = '0 2px';
              return el;
            },
          }),
          themeConf.of(darkMode ? oneDark : lightTheme),
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
  }, [room, activeId, activeName, darkMode]);

  const addFile = () => {
    const name = window.prompt('File name', 'untitled.js')?.trim();
    if (!name) return;
    const meta = new Y.Map<unknown>();
    meta.set('name', name);
    const id = nanoid(8);
    room.slate.codeFiles().set(id, meta);
    openFile(id);
  };

  const renameFile = (id: string, current: string) => {
    const name = window.prompt('Rename file', current)?.trim();
    if (!name || name === current) return;
    room.slate.codeFiles().get(id)?.set('name', name);
  };

  const deleteFile = (id: string, name: string) => {
    if (!window.confirm(`Delete ${name}? The file disappears for everyone on this board.`)) return;
    room.slate.codeFiles().delete(id);
    if (selectedId === id) setSelectedId(null);
    if (activeFileId === id) setActiveFileId(null);
    setOpenFiles((cur) => cur.filter((x) => x !== id));
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

  /** Trigger CM's built-in search panel by synthesizing a Ctrl+F keydown on
   *  the editor's host. searchKeymap is already bound, so CM handles the rest
   *  (open panel, find next/prev, replace, close on Esc). Dispatching on the
   *  wrapper rather than the view's DOM root keeps the event bubbling inside
   *  the editor surface so CM's own listener catches it. */
  const openSearch = () => {
    const target = viewRef.current?.contentDOM ?? editorWrapperRef.current;
    if (!target) return;
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
  };

  const toggleTheme = () => setDarkMode((v) => !v);

  const lineCount = activeId ? room.slate.codeText(activeId).toString().split('\n').length : 0;

  // Tab strip rows — only files that are actually open as tabs. Clicking a
  // file in the rail calls openFile, which appends to this list.
  const tabRows = validOpenFiles
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is { id: string; name: string } => Boolean(f));

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
                onClick={() => openFile(f.id)}
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
        {/* Tab strip — one button per open file. Active tab lifts to the
            surface so the border under it merges into the editor's chrome. */}
        {tabRows.length > 0 && (
          <div className="flex items-stretch gap-0 overflow-x-auto border-b border-border bg-bg-2">
            {tabRows.map((f) => {
              const isActive = f.id === activeId;
              return (
                <div
                  key={f.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActive}
                  onClick={() => openFile(f.id)}
                  // Middle-click closes the tab — matches the IDE convention.
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(f.id);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openFile(f.id);
                    } else if (e.key === 'Delete' || (e.key === 'w' && (e.ctrlKey || e.metaKey))) {
                      e.preventDefault();
                      closeTab(f.id);
                    }
                  }}
                  title={f.name}
                  className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs ${
                    isActive
                      ? 'bg-bg text-text'
                      : 'bg-bg-2 text-text-mid hover:bg-bg-3 hover:text-text'
                  }`}
                >
                  <FileCode2 size={11} className="shrink-0 opacity-70" />
                  <span className="max-w-[160px] truncate font-mono">{f.name}</span>
                  <button
                    type="button"
                    aria-label={`Close ${f.name} tab`}
                    title="Close tab (Ctrl+W)"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(f.id);
                    }}
                    className="grid h-4 w-4 shrink-0 place-items-center rounded text-text-dim hover:bg-bg-3 hover:text-text"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-border bg-bg-2 px-3 py-1.5">
          <span className="truncate font-mono text-xs text-text">{activeName || '—'}</span>
          <div className="flex-1" />
          <button type="button" title="Find (Ctrl+F)" aria-label="Find" onClick={openSearch} disabled={!activeId} className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40">
            <Search size={13} />
          </button>
          <button
            type="button"
            title={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Toggle editor theme"
            onClick={toggleTheme}
            className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
          >
            {darkMode ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          <button type="button" title="Download this file" aria-label="Download this file" onClick={downloadFile} disabled={!activeId} className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40">
            <Download size={13} />
          </button>
        </div>
        <div ref={editorWrapperRef} className="relative flex-1 min-h-0">
          {activeId ? (
            <div ref={hostRef} className="slate-code-host h-full" />
          ) : (
            <div className="grid h-full place-items-center text-sm text-text-dim">
              <button type="button" onClick={addFile} className="rounded border border-border px-3 py-1.5 hover:bg-bg-3">
                Create a file to start coding together
              </button>
            </div>
          )}
        </div>
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
