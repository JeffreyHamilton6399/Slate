/**
 * DocEditor — collaborative rich-text document surface for 'doc' boards.
 *
 * TipTap (ProseMirror) bound to the board's shared Y.XmlFragment via the
 * Collaboration extension (y-prosemirror underneath), so every keystroke
 * merges through the same Yjs pipeline as the other modes — offline edits
 * included. CollaborationCursor broadcasts carets/selections over the room's
 * existing Hocuspocus awareness, colored with the same per-peer palette as
 * the People widget.
 *
 * Undo/redo is the Collaboration extension's Yjs undo manager (scoped to
 * YOUR edits — undoing won't revert a collaborator's typing), deliberately
 * separate from the room-level UndoManager which tracks the other modes'
 * containers.
 *
 * Node set: headings 1-3, bold/italic/strike/underline/inline code, links,
 * text color + highlight, bullet/ordered/task lists, blockquote, syntax-
 * highlighted code blocks (lowlight/common grammars), images (downscaled to
 * a data URL small enough for a single Yjs update — same importer the 2D
 * canvas uses), horizontal rule, alignment (left/center/right), tables
 * (insert/add-row/add-col/delete). Export to Markdown from the toolbar
 * (and the Export dialog). Find via prompt + ProseMirror text search.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { DocImage } from './imageExtension';
import LinkExt from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Underline from '@tiptap/extension-underline';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TextSelection } from '@tiptap/pm/state';
import { createLowlight, common } from 'lowlight';
import {
  Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3,
  List, ListOrdered, ListTodo, TextQuote, SquareCode, ImagePlus, Link2,
  Minus, Undo2, Redo2, FileDown, FileCode2,
  Underline as UnderlineIcon, Highlighter, Palette, AlignLeft, AlignCenter,
  AlignRight, Table as TableIcon, Plus, Trash2, Search, X,
  Subscript as SubscriptIcon, Superscript as SuperscriptIcon, Eraser, Printer,
  Indent, Outdent, ChevronDown, Type, RotateCcw, RotateCw,
} from 'lucide-react';
import { colorForPeerId } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { fileToImageShape, isImageFile } from '../canvas2d/importImage';
import { DOC_APPLY_EVENT, type DocApplyDetail } from './docBridge';
import { docFragmentToMarkdown } from './exportMarkdown';
import { toast } from '../ui/Toast';
import './docEditor.css';

// One lowlight instance for the module (grammar registry is stateless).
const lowlight = createLowlight(common);

export function DocEditor() {
  const room = useRoom();
  const boardName = useAppStore((s) => s.currentBoard?.name) ?? 'document';
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);

  // Font size presets (in px). The first option (default) clears the inline
  // style so the doc falls back to the page CSS — picks the rest by hand.
  const FONT_SIZES = [12, 14, 16, 18, 24, 32];

  const user = useMemo(
    () => ({ name: room.identity.name, color: colorForPeerId(room.identity.peerId) }),
    [room],
  );

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // TipTap v3 splits history out of StarterKit as `undoRedu`. The
          // Collaboration extension brings its own (Yjs-based) history;
          // two histories fight over Ctrl+Z, so the local one must be off.
          undoRedo: false,
          // Replaced by the lowlight-highlighted code block below.
          codeBlock: false,
          // Underline is bundled with StarterKit in v3 — turn it off here so
          // the explicit Underline extension below owns it (keeps the config
          // self-documenting and lets us extend it later if needed).
          underline: false,
        }),
        // Guard: the Y.XmlFragment returned by doc.getXmlFragment() is
        // auto-created but may not be integrated into the doc on very fresh
        // boards. The Collaboration extension accesses fragment.doc internally
        // — if it's undefined, the editor crashes. Force-integrate by touching
        // the fragment's parent doc.
        Collaboration.configure({
          fragment: (() => {
            const frag = room.slate.docText();
            // Accessing the doc property forces Yjs to integrate the fragment
            // if it hasn't been yet. If doc is null, the fragment is detached
            // — we can't use Collaboration, so return a new integrated one.
            if (!frag.doc) {
              // Create a new fragment and integrate it into the doc
              room.slate.doc.getXmlFragment('doc:text');
              return room.slate.docText();
            }
            return frag;
          })(),
        }),
        CollaborationCaret.configure({ provider: room.provider, user }),
        TaskList,
        TaskItem.configure({ nested: true }),
        // Images live as data URLs INSIDE the Yjs doc (bounded by the same
        // downscaler the 2D canvas uses), so they sync/offline like text.
        DocImage.configure({ allowBase64: true }),
        LinkExt.configure({ openOnClick: false, autolink: true }),
        Placeholder.configure({ placeholder: 'Start writing — everyone on this board sees it live.' }),
        CodeBlockLowlight.configure({ lowlight }),
        // Inline formatting additions.
        Underline,
        Subscript,
        Superscript,
        // TextStyle carries the inline `style` attribute; FontSize layers a
        // `fontSize` style + setFontSize/unsetFontSize commands on top.
        TextStyle,
        FontSize,
        Color,
        Highlight,
        // Block-level alignment on paragraphs + headings.
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        // Tables (with header row, borders come from docEditor.css).
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
      ],
      editorProps: {
        attributes: {
          'aria-label': 'Document editor',
        },
      },
    },
    [room],
  );

  // The AI assistant edits this document by dispatching a window event with the
  // full new HTML (it can't reach the editor instance directly). Replacing the
  // content applies as a Yjs transaction, so the rewrite syncs to every peer.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DocApplyDetail>).detail;
      if (!detail?.html) return;
      editor.commands.setContent(detail.html, { emitUpdate: true });
    };
    window.addEventListener(DOC_APPLY_EVENT, handler as EventListener);
    return () => window.removeEventListener(DOC_APPLY_EVENT, handler as EventListener);
  }, [editor]);

  // Image controls (enabled only when an image node is selected). Width is a
  // CSS width string; rotation is degrees; align uses auto margins.
  const setImageWidth = (w: string | null) =>
    editor?.chain().focus().updateAttributes('image', { width: w }).run();
  const rotateImage = (delta: number) => {
    const cur = (editor?.getAttributes('image').rotation as number) || 0;
    editor?.chain().focus().updateAttributes('image', { rotation: ((cur + delta) % 360 + 360) % 360 }).run();
  };
  const setImageAlign = (a: 'left' | 'center' | 'right') =>
    editor?.chain().focus().updateAttributes('image', { align: a }).run();

  const addImage = async (file: File) => {
    if (!editor) return;
    try {
      const img = await fileToImageShape(file);
      editor.chain().focus().setImage({ src: img.src, alt: file.name }).run();
    } catch (err) {
      toast({ title: 'Image import failed', description: err instanceof Error ? err.message : String(err) });
    }
  };

  const setLink = () => {
    if (!editor) return;
    const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
    // eslint-disable-next-line no-alert
    const url = window.prompt('Link URL (empty to remove)', prev);
    if (url === null) return;
    if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const exportMarkdown = () => {
    const md = docFragmentToMarkdown(room.slate.docText());
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${boardName}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  };

  // Export the doc as a standalone HTML file: the editor's rendered HTML
  // wrapped in a minimal document with inline CSS that mirrors the on-screen
  // look (page tokens become literal values so the file is self-contained).
  const exportHtml = () => {
    if (!editor) return;
    const body = editor.getHTML();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${boardName.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] ?? c))}</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; color: #1a1a1a; background: #fff; max-width: 780px; margin: 2rem auto; padding: 0 1.5rem; font-size: 15px; line-height: 1.65; }
  h1, h2, h3 { font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; margin-top: 1.1em; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
  a { color: #6366f1; text-decoration: underline; }
  code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.88em; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 3px; padding: 0.1em 0.35em; }
  pre { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.85em; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.75rem 1rem; overflow-x: auto; }
  pre code { background: none; border: none; padding: 0; font-size: inherit; }
  blockquote { border-left: 3px solid #6366f1; padding-left: 1rem; color: #4b5563; }
  ul, ol { padding-left: 1.5rem; } ul { list-style: disc; } ol { list-style: decimal; }
  ul[data-type='taskList'] { list-style: none; padding-left: 0.25rem; }
  ul[data-type='taskList'] li { display: flex; gap: 0.5rem; align-items: baseline; }
  ul[data-type='taskList'] li[data-checked='true'] > div { color: #9ca3af; text-decoration: line-through; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.25rem 0; }
  img { max-width: 100%; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  th, td { border: 1px solid #e5e7eb; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  mark { background: #fde68a; border-radius: 2px; padding: 0.05em 0.1em; }
  u { text-decoration: underline; }
</style>
</head>
<body>
${body}
</body>
</html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${boardName}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  };

  // Print: hand the page to the browser's print dialog. The doc lives in
  // `.slate-doc .ProseMirror`, so a print stylesheet scopes the output to it
  // (added in docEditor.css under @media print — strips the toolbar, file
  // rail, and other chrome so only the page body lands on paper).
  const printDoc = () => window.print();

  // Clear formatting: drop every mark + reset every block to a plain
  // paragraph. Useful for pasting in styled content and stripping it back.
  const clearFormatting = () => {
    if (!editor) return;
    editor.chain().focus().unsetAllMarks().clearNodes().run();
  };

  // Indent/Outdent: in lists, sink/lift the list item. Outside lists TipTap
  // has no built-in paragraph indent — these no-op gracefully there.
  const indent = () => editor?.chain().focus().sinkListItem('listItem').run();
  const outdent = () => editor?.chain().focus().liftListItem('listItem').run();

  // Minimal Find: prompt for a term, walk every text node in the doc, select
  // the first occurrence (case-insensitive) so the browser highlights it and
  // scrolls it into view. A "no matches" toast covers the empty case.
  const findInDoc = () => {
    if (!editor) return;
    // eslint-disable-next-line no-alert
    const term = window.prompt('Find in document');
    if (term === null || term === '') return;
    const needle = term.toLowerCase();
    let found = false;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false; // stop walking once we've landed on a match
      // Non-text nodes (paragraphs, list items, table cells, …) — descend
      // into their children so the search reaches text nested anywhere.
      if (!node.isText || !node.text) return;
      const idx = node.text.toLowerCase().indexOf(needle);
      if (idx === -1) return;
      const from = pos + idx;
      const to = from + term.length;
      // Replace the selection with a TextSelection over the match — ProseMirror
      // draws the native selection highlight, and scrollIntoView() on the tr
      // asks the view to bring the new selection into view.
      const tr = editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, from, to))
        .scrollIntoView();
      editor.view.dispatch(tr);
      editor.view.focus();
      found = true;
      return false;
    });
    if (!found) toast({ title: 'No matches', description: `“${term}” not found in this document.` });
  };

  if (!editor) return null;

  const words = editor.state.doc.textContent.trim().split(/\s+/).filter(Boolean).length;
  const inTable = editor.isActive('table');
  const imageSelected = editor.isActive('image');
  const imageWidth = (editor.getAttributes('image').width as string | null) ?? null;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-bg-2 px-2 py-1">
        <ToolButton editor={editor} label="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={14} /></ToolButton>
        <ToolButton editor={editor} label="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={14} /></ToolButton>
        <ToolButton editor={editor} label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={14} /></ToolButton>
        <ToolButton editor={editor} label="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={14} /></ToolButton>
        <ToolButton editor={editor} label="Subscript" active={editor.isActive('subscript')} onClick={() => editor.chain().focus().toggleSubscript().run()}><SubscriptIcon size={14} /></ToolButton>
        <ToolButton editor={editor} label="Superscript" active={editor.isActive('superscript')} onClick={() => editor.chain().focus().toggleSuperscript().run()}><SuperscriptIcon size={14} /></ToolButton>
        <ToolButton editor={editor} label="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={14} /></ToolButton>
        <ToolButton editor={editor} label="Highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter size={14} /></ToolButton>
        <ToolButton editor={editor} label="Link" active={editor.isActive('link')} onClick={setLink}><Link2 size={14} /></ToolButton>
        {/* Text color — Palette button opens a small popover with a native color
            input plus a "clear" affordance. The popover auto-closes on pick. */}
        <div className="relative">
          <button
            type="button"
            title="Text color"
            aria-label="Text color"
            aria-haspopup="dialog"
            aria-expanded={colorOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setColorOpen((o) => !o)}
            className={`grid h-7 w-7 place-items-center rounded transition-colors ${
              colorOpen ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'
            }`}
          >
            <Palette size={14} />
          </button>
          {colorOpen && (
            <>
              {/* Click-away backdrop. */}
              <div className="fixed inset-0 z-40" onClick={() => setColorOpen(false)} />
              <div
                role="dialog"
                aria-label="Text color"
                className="absolute left-0 top-full z-50 mt-1 flex items-center gap-2 rounded-md border border-border bg-bg-2 p-2 shadow-lg"
              >
                <input
                  type="color"
                  aria-label="Pick text color"
                  // Live-apply as the user drags through the swatch grid.
                  onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
                  className="h-6 w-6 cursor-pointer rounded border border-border bg-transparent p-0"
                />
                <button
                  type="button"
                  title="Clear color"
                  aria-label="Clear color"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor.chain().focus().unsetColor().run();
                    setColorOpen(false);
                  }}
                  className="grid h-6 w-6 place-items-center rounded text-text-mid hover:bg-bg-3 hover:text-text"
                >
                  <X size={12} />
                </button>
              </div>
            </>
          )}
        </div>
        {/* Font size — small dropdown that applies/removes an inline
            font-size style mark. The "Default" entry clears the override. */}
        <div className="relative">
          <button
            type="button"
            title="Font size"
            aria-label="Font size"
            aria-haspopup="dialog"
            aria-expanded={fontSizeOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFontSizeOpen((o) => !o)}
            className={`flex h-7 items-center gap-0.5 rounded px-1.5 text-text-mid transition-colors ${
              fontSizeOpen ? 'bg-accent/15 text-accent' : 'hover:bg-bg-3 hover:text-text'
            }`}
          >
            <Type size={14} />
            <ChevronDown size={10} />
          </button>
          {fontSizeOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFontSizeOpen(false)} />
              <div
                role="dialog"
                aria-label="Font size"
                className="absolute left-0 top-full z-50 mt-1 w-28 rounded-md border border-border bg-bg-2 p-1 shadow-lg"
              >
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor.chain().focus().unsetFontSize().run();
                    setFontSizeOpen(false);
                  }}
                  className="block w-full rounded px-2 py-1 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
                >
                  Default
                </button>
                {FONT_SIZES.map((px) => (
                  <button
                    key={px}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      editor.chain().focus().setFontSize(`${px}px`).run();
                      setFontSizeOpen(false);
                    }}
                    className="block w-full rounded px-2 py-1 text-left text-xs text-text-mid hover:bg-bg-3 hover:text-text"
                    style={{ fontSize: `${px}px` }}
                  >
                    {px}px
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <Divider />
        <ToolButton editor={editor} label="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={14} /></ToolButton>
        <Divider />
        <ToolButton editor={editor} label="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft size={14} /></ToolButton>
        <ToolButton editor={editor} label="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter size={14} /></ToolButton>
        <ToolButton editor={editor} label="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight size={14} /></ToolButton>
        <ToolButton editor={editor} label="Outdent (in a list)" onClick={outdent}><Outdent size={14} /></ToolButton>
        <ToolButton editor={editor} label="Indent (in a list)" onClick={indent}><Indent size={14} /></ToolButton>
        <Divider />
        <ToolButton editor={editor} label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={14} /></ToolButton>
        <ToolButton editor={editor} label="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={14} /></ToolButton>
        <ToolButton editor={editor} label="Task list" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListTodo size={14} /></ToolButton>
        <Divider />
        <ToolButton editor={editor} label="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><TextQuote size={14} /></ToolButton>
        <ToolButton editor={editor} label="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><SquareCode size={14} /></ToolButton>
        <ToolButton editor={editor} label="Image…" onClick={() => imageInputRef.current?.click()}><ImagePlus size={14} /></ToolButton>
        <ToolButton editor={editor} label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={14} /></ToolButton>
        <Divider />
        {/* Table group — insert a 3×3 with header row, then mutate the table
            the caret currently sits inside. The mutation buttons stay enabled
            (TipTap no-ops gracefully when there's no table) but get a hint via
            `inTable` so the user knows why nothing happens outside a table. */}
        <ToolButton editor={editor} label="Insert table (3×3)" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={14} /></ToolButton>
        <ToolButton editor={editor} label={inTable ? 'Add column after' : 'Add column (click inside a table first)'} active={inTable} onClick={() => editor.chain().focus().addColumnAfter().run()}><Plus size={14} className="rotate-90" /></ToolButton>
        <ToolButton editor={editor} label={inTable ? 'Add row after' : 'Add row (click inside a table first)'} active={inTable} onClick={() => editor.chain().focus().addRowAfter().run()}><Plus size={14} /></ToolButton>
        <ToolButton editor={editor} label={inTable ? 'Delete table' : 'Delete table (click inside a table first)'} active={inTable} onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 size={14} /></ToolButton>
        <Divider />
        <ToolButton editor={editor} label="Undo (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()}><Undo2 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Redo (Ctrl+Shift+Z)" onClick={() => editor.chain().focus().redo().run()}><Redo2 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Clear formatting" onClick={clearFormatting}><Eraser size={14} /></ToolButton>
        <div className="flex-1" />
        <ToolButton editor={editor} label="Find…" onClick={findInDoc}><Search size={14} /></ToolButton>
        <span className="hidden font-mono text-[10px] text-text-dim sm:inline">{words} {words === 1 ? 'word' : 'words'}</span>
        <ToolButton editor={editor} label="Print" onClick={printDoc}><Printer size={14} /></ToolButton>
        <ToolButton editor={editor} label="Export HTML" onClick={exportHtml}><FileCode2 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Export Markdown" onClick={exportMarkdown}><FileDown size={14} /></ToolButton>
      </div>

      {/* Contextual image toolbar — only while an image node is selected. */}
      {imageSelected && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-bg-2/60 px-2 py-1">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">Image</span>
          <span className="text-[10px] text-text-dim">Size</span>
          {(['25%', '50%', '75%', '100%'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setImageWidth(w)}
              className={`rounded px-1.5 py-0.5 text-[11px] ${
                imageWidth === w ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'
              }`}
            >
              {w}
            </button>
          ))}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setImageWidth(null)}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              imageWidth === null ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'
            }`}
          >
            Auto
          </button>
          <Divider />
          <ToolButton editor={editor} label="Rotate left 90°" onClick={() => rotateImage(-90)}><RotateCcw size={14} /></ToolButton>
          <ToolButton editor={editor} label="Rotate right 90°" onClick={() => rotateImage(90)}><RotateCw size={14} /></ToolButton>
          <Divider />
          <ToolButton editor={editor} label="Align image left" onClick={() => setImageAlign('left')}><AlignLeft size={14} /></ToolButton>
          <ToolButton editor={editor} label="Align image center" onClick={() => setImageAlign('center')}><AlignCenter size={14} /></ToolButton>
          <ToolButton editor={editor} label="Align image right" onClick={() => setImageAlign('right')}><AlignRight size={14} /></ToolButton>
        </div>
      )}

      {/* Page — a paper sheet on a desk, with page-break guide lines. */}
      <div className="slate-doc flex-1" onMouseDown={(e) => {
        // Clicking the desk around the page focuses the editor at the end —
        // the whole surface should feel like the document.
        if (e.target === e.currentTarget && editor) {
          e.preventDefault();
          editor.chain().focus('end').run();
        }
      }}>
        <div className="slate-doc-page">
          <EditorContent editor={editor} />
        </div>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && isImageFile(f)) void addImage(f);
        }}
      />
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}

function ToolButton({ label, active, onClick, children }: {
  editor: Editor; // kept in props so buttons re-render with editor state
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // preventDefault so the editor keeps focus/selection through the click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded transition-colors ${
        active ? 'bg-accent/15 text-accent' : 'text-text-mid hover:bg-bg-3 hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

export default DocEditor;
