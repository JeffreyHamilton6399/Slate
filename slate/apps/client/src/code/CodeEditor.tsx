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
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, ViewPlugin, Decoration, type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab, indentSelection } from '@codemirror/commands';
import {
  bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle,
  foldGutter, indentUnit, LanguageDescription,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import {
  FileCode2, FilePlus2, Pencil, Trash2, Download, Archive, Search, Sun, Moon, X,
  WrapText, Plus, Minus, Wand2, Command as CommandIcon, CornerDownLeft,
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

/**
 * Indent guides — a tiny ViewPlugin that adds a `cm-indent-guide` line
 * decoration to every visible line whose leading whitespace crosses one or
 * more 2-space boundaries, and stashes the count in a `--cm-indent` CSS
 * variable. codeEditor.css then paints vertical guides via a clipped
 * `repeating-linear-gradient` background sized to that count.
 *
 * `@codemirror/view` shipped an official `indentationMarkers()` helper in a
 * later 6.4x release; we're on 6.43.6 (latest published), so this is the
 * local equivalent. Empty lines render with no guides — the trade-off is
 * a few pixels of visual gap, but the implementation stays in one file.
 */
const indentGuides = ViewPlugin.fromClass(
  class {
    decos: DecorationSet;
    constructor(view: EditorView) {
      this.decos = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decos = this.build(u.view);
      }
    }
    build(view: EditorView) {
      const items: { from: number; value: ReturnType<typeof Decoration.line> }[] = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          // Count leading whitespace in 2-space units — a leading tab counts
          // as one guide so mixed-indent files still get something useful.
          const m = /^([ \t]+)/.exec(line.text);
          const spaces = m?.[1] ? m[1].replace(/\t/g, '  ').length : 0;
          const levels = Math.floor(spaces / 2);
          if (levels > 0) {
            items.push({
              from: line.from,
              value: Decoration.line({
                class: 'cm-indent-guide',
                attributes: { style: `--cm-indent: ${levels}` },
              }),
            });
          }
          pos = line.to + 1;
        }
      }
      return Decoration.set(
        items.map((i) => i.value.range(i.from)),
        true,
      );
    }
  },
  { decorations: (v) => v.decos },
);

/** Default editor font size (matches the old hard-coded `.cm-editor { font-size: 13px }`
 *  rule; the +/- buttons step in 1px increments and clamp to [10, 24]). */
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

/** Build a CM theme extension that sets the editor + gutter font size. */
function fontTheme(px: number): Extension {
  return EditorView.theme({
    '.cm-content': { fontSize: `${px}px` },
    '.cm-gutters': { fontSize: `${px}px` },
    '&': { fontSize: `${px}px` },
  });
}

export function CodeEditor() {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const [, bump] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [langName, setLangName] = useState('Plain text');
  const [darkMode, setDarkMode] = useState(true);
  // Word-wrap + font-size live behind CM Compartments so toggling them never
  // tears down the editor (which would lose scroll/selection/cursor). The
  // compartment refs are populated by the mount effect and read by the
  // reconfigure effects below.
  const [lineWrap, setLineWrap] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  // Command palette: a Ctrl+Shift+P popover with a filterable list of actions.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The rail/host wrapper — used by the Find button so it can dispatch a
  // synthetic Ctrl+F into the editor regardless of which child has focus.
  const editorWrapperRef = useRef<HTMLDivElement | null>(null);
  // Compartment refs — stashed by the mount effect so the wrap/font
  // reconfigure effects can dispatch into the live view without rebuilding it.
  const wrapConfRef = useRef<Compartment | null>(null);
  const fontConfRef = useRef<Compartment | null>(null);

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

  // Listen for open-file events from the dockable CodeFilesPanel — it only
  // knows the file id and asks the editor (which owns the tab/active state)
  // to actually open it. Window-level so the
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
    const wrapConf = new Compartment();
    const fontConf = new Compartment();
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
          // Autocomplete: language grammars expose completion sources through
          // `@codemirror/language`'s `LanguageDescription`. autocompletion()
          // wires the UI; completionKeymap adds Ctrl-Space / Enter / arrow keys.
          autocompletion(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // Indent guides — see the `indentGuides` ViewPlugin above. Painted by
          // CSS using the `--cm-indent` variable the plugin sets per line.
          indentGuides,
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
          // wrap + font are behind Compartments so the toolbar buttons can
          // toggle them via `reconfigure()` without rebuilding the editor.
          wrapConf.of(lineWrap ? EditorView.lineWrapping : []),
          fontConf.of(fontTheme(fontSize)),
          languageConf.of([]),
          // yUndoManagerKeymap first: Mod-z must hit the Yjs undo manager
          // (CM's history extension is intentionally absent).
          // completionKeymap lives between searchKeymap and defaultKeymap so
          // Enter accepts a completion before falling through to newline.
          // searchKeymap already binds Mod-d → selectNextOccurrence (Ctrl+D
          // multi-cursor), Mod-f → open search panel, etc.
          keymap.of([
            ...yUndoManagerKeymap,
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          yCollab(ytext, awareness, { undoManager }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    wrapConfRef.current = wrapConf;
    fontConfRef.current = fontConf;

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
      wrapConfRef.current = null;
      fontConfRef.current = null;
      undoManager.destroy();
    };
    // Mount effect intentionally does NOT depend on `lineWrap` or `fontSize`:
    // those live behind Compartments and are reconfigured via their own
    // effects below, so toggling them never tears down the editor (which
    // would lose scroll/selection/cursor). darkMode DOES recreate — the
    // oneDark/lightTheme swap is a full theme replacement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, activeId, activeName, darkMode]);

  // Reconfigure word-wrap when the toolbar toggle flips — keeps scroll,
  // selection, and remote-cursor positions intact (a full remount would lose
  // them). The mount effect seeds the compartment with the current value, so
  // this only fires on actual toggles.
  useEffect(() => {
    const view = viewRef.current;
    const conf = wrapConfRef.current;
    if (!view || !conf) return;
    view.dispatch({ effects: conf.reconfigure(lineWrap ? EditorView.lineWrapping : []) });
  }, [lineWrap]);

  // Reconfigure font size on +/- clicks. Same compartment pattern as wrap so
  // the editor survives a font change without losing its place.
  useEffect(() => {
    const view = viewRef.current;
    const conf = fontConfRef.current;
    if (!view || !conf) return;
    view.dispatch({ effects: conf.reconfigure(fontTheme(fontSize)) });
  }, [fontSize]);

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
  const toggleWrap = () => setLineWrap((v) => !v);
  const bumpFont = (delta: number) =>
    setFontSize((px) => Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, px + delta)));
  const resetFont = () => setFontSize(DEFAULT_FONT_SIZE);

  /** Format code: re-indent the lines covered by the current selection (or
   *  just the active line when there's no selection) using the active
   *  language's indentation rules. For a whole-file reformat, the user can
   *  Ctrl+A first — `indentSelection` handles arbitrarily large ranges. */
  const formatCode = () => {
    const view = viewRef.current;
    if (!view) return;
    // `indentSelection` is a CM command: it returns true if it did something.
    // Wrapping in `focus` keeps the editor focused after the toolbar click.
    view.focus();
    indentSelection(view);
  };

  /** Open the command palette via the toolbar button or Ctrl+Shift+P. */
  const openPalette = useCallback(() => {
    setPaletteQuery('');
    setPaletteIndex(0);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // The command palette's command list + its filtered view. Built in one
  // useMemo so the array identity stays stable across renders when nothing
  // relevant has changed — without this the filter useMemo would recompute
  // every render (which works, but trips the exhaustive-deps lint and burns
  // cycles on each keystroke).
  type PaletteCommand = { id: string; label: string; hint?: string; run: () => void };
  const { filteredCommands } = useMemo(() => {
    const cmds: PaletteCommand[] = [
      { id: 'find', label: 'Find', hint: 'Ctrl+F', run: () => { closePalette(); setTimeout(openSearch, 0); } },
      { id: 'theme', label: darkMode ? 'Switch to light theme' : 'Switch to dark theme', run: () => { closePalette(); toggleTheme(); } },
      { id: 'wrap', label: lineWrap ? 'Disable word wrap' : 'Enable word wrap', run: () => { closePalette(); toggleWrap(); } },
      { id: 'format', label: 'Format selection (re-indent)', hint: 'auto-indent', run: () => { closePalette(); formatCode(); } },
      { id: 'font-up', label: 'Increase font size', run: () => { closePalette(); bumpFont(1); } },
      { id: 'font-down', label: 'Decrease font size', run: () => { closePalette(); bumpFont(-1); } },
      { id: 'font-reset', label: 'Reset font size', run: () => { closePalette(); resetFont(); } },
      { id: 'new-file', label: 'New file', run: () => { closePalette(); setTimeout(addFile, 0); } },
      { id: 'download-file', label: 'Download this file', run: () => { closePalette(); setTimeout(downloadFile, 0); } },
      { id: 'download-zip', label: 'Download all as .zip', run: () => { closePalette(); setTimeout(downloadZip, 0); } },
    ];
    const q = paletteQuery.trim().toLowerCase();
    const filtered = q
      ? cmds.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q))
      : cmds;
    return { filteredCommands: filtered };
    // The inline handlers (toggleTheme, formatCode, …) are recreated every
    // render — listing them is exhaustive but the memo recomputes anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, darkMode, lineWrap, closePalette]);

  // Reset the highlighted index whenever the filter changes (so Enter always
  // hits a visible row).
  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery]);

  // Focus the palette input when it opens + select-all on the value.
  useEffect(() => {
    if (!paletteOpen) return;
    const id = window.setTimeout(() => {
      paletteInputRef.current?.focus();
      paletteInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [paletteOpen]);

  // Global Ctrl+Shift+P opens the palette from anywhere in the code board.
  // Bound on `window` so it works whether the editor or a panel has focus.
  useEffect(() => {
    if (paletteOpen) return; // palette binds its own keys while open
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, openPalette]);

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
          {/* Word wrap toggle — behind a Compartment so the editor survives
              the toggle without losing scroll/selection/cursor. */}
          <button
            type="button"
            title={lineWrap ? 'Disable word wrap' : 'Enable word wrap'}
            aria-label="Toggle word wrap"
            aria-pressed={lineWrap}
            onClick={toggleWrap}
            className={`grid h-6 w-6 place-items-center rounded ${
              lineWrap ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'
            }`}
          >
            <WrapText size={13} />
          </button>
          {/* Font size − / + — clamps to [10,24]. The badge shows the current
              px so the user has feedback without a dropdown. */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              title="Decrease font size"
              aria-label="Decrease font size"
              onClick={() => bumpFont(-1)}
              disabled={fontSize <= MIN_FONT_SIZE}
              className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40"
            >
              <Minus size={13} />
            </button>
            <span className="min-w-[1.5rem] text-center font-mono text-[10px] text-text-dim" title={`${fontSize}px (click +/− to change)`}>
              {fontSize}
            </span>
            <button
              type="button"
              title="Increase font size"
              aria-label="Increase font size"
              onClick={() => bumpFont(1)}
              disabled={fontSize >= MAX_FONT_SIZE}
              className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40"
            >
              <Plus size={13} />
            </button>
          </div>
          {/* Format: re-indent the current selection (or active line) using
              the language's indentation rules. Tip onto a small timeout so
              the click doesn't fight the editor's focus management. */}
          <button
            type="button"
            title="Format selection (re-indent)"
            aria-label="Format selection"
            onClick={formatCode}
            disabled={!activeId}
            className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text disabled:opacity-40"
          >
            <Wand2 size={13} />
          </button>
          {/* Command palette (Ctrl+Shift+P) — opens a filterable list of every
              toolbar action so a keyboard user never has to mouse around. */}
          <button
            type="button"
            title="Command palette (Ctrl+Shift+P)"
            aria-label="Command palette"
            onClick={openPalette}
            className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
          >
            <CommandIcon size={13} />
          </button>
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
          {paletteOpen && (
            // Command palette overlay — anchored to the editor column, modal
            // enough that Escape closes it and Enter runs the highlighted row.
            // No backdrop click-away (Ctrl+Shift+P users expect a keystroke to
            // dismiss), but a click on the empty footer area closes it.
            <div
              role="dialog"
              aria-label="Command palette"
              className="absolute inset-x-0 top-0 z-50 mx-auto mt-2 w-[min(28rem,90%)] overflow-hidden rounded-md border border-border bg-bg-2 shadow-xl"
            >
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <CommandIcon size={14} className="shrink-0 text-text-dim" />
                <input
                  ref={paletteInputRef}
                  type="text"
                  value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      closePalette();
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const cmd = filteredCommands[paletteIndex];
                      if (cmd) cmd.run();
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPaletteIndex((i) => Math.min(filteredCommands.length - 1, i + 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPaletteIndex((i) => Math.max(0, i - 1));
                    }
                  }}
                  placeholder="Type a command…"
                  className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-dim"
                />
                <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-dim">Esc</span>
              </div>
              <ul className="max-h-72 overflow-y-auto py-1">
                {filteredCommands.length === 0 && (
                  <li className="px-3 py-3 text-center text-xs text-text-dim">No matching commands</li>
                )}
                {filteredCommands.map((cmd, i) => (
                  <li key={cmd.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setPaletteIndex(i)}
                      onClick={() => cmd.run()}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs ${
                        i === paletteIndex ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3'
                      }`}
                    >
                      <span>{cmd.label}</span>
                      {cmd.hint && <span className="font-mono text-[10px] text-text-dim">{cmd.hint}</span>}
                      {i === paletteIndex && <CornerDownLeft size={10} className="text-text-dim" />}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                aria-label="Close command palette"
                onClick={closePalette}
                className="block w-full border-t border-border bg-bg-3/40 py-1 text-center font-mono text-[10px] text-text-dim hover:bg-bg-3"
              >
                Ctrl+Shift+P to open · ↑↓ to navigate · Enter to run
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
