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

import { useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import ImageExt from '@tiptap/extension-image';
import LinkExt from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
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
  Minus, Undo2, Redo2, FileDown,
  Underline as UnderlineIcon, Highlighter, Palette, AlignLeft, AlignCenter,
  AlignRight, Table as TableIcon, Plus, Trash2, Search, X,
} from 'lucide-react';
import { colorForPeerId } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { fileToImageShape, isImageFile } from '../canvas2d/importImage';
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

  const user = useMemo(
    () => ({ name: room.identity.name, color: colorForPeerId(room.identity.peerId) }),
    [room],
  );

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // TipTap v3 splits history out of StarterKit as `undoRedo`. The
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
        Collaboration.configure({ fragment: room.slate.docText() }),
        CollaborationCursor.configure({ provider: room.provider, user }),
        TaskList,
        TaskItem.configure({ nested: true }),
        // Images live as data URLs INSIDE the Yjs doc (bounded by the same
        // downscaler the 2D canvas uses), so they sync/offline like text.
        ImageExt.configure({ allowBase64: true }),
        LinkExt.configure({ openOnClick: false, autolink: true }),
        Placeholder.configure({ placeholder: 'Start writing — everyone on this board sees it live.' }),
        CodeBlockLowlight.configure({ lowlight }),
        // Inline formatting additions.
        Underline,
        TextStyle,
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

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-bg-2 px-2 py-1">
        <ToolButton editor={editor} label="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={14} /></ToolButton>
        <ToolButton editor={editor} label="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={14} /></ToolButton>
        <ToolButton editor={editor} label="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={14} /></ToolButton>
        <ToolButton editor={editor} label="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={14} /></ToolButton>
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
        <Divider />
        <ToolButton editor={editor} label="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={14} /></ToolButton>
        <ToolButton editor={editor} label="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={14} /></ToolButton>
        <Divider />
        <ToolButton editor={editor} label="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft size={14} /></ToolButton>
        <ToolButton editor={editor} label="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter size={14} /></ToolButton>
        <ToolButton editor={editor} label="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight size={14} /></ToolButton>
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
        <div className="flex-1" />
        <ToolButton editor={editor} label="Find…" onClick={findInDoc}><Search size={14} /></ToolButton>
        <span className="hidden font-mono text-[10px] text-text-dim sm:inline">{words} {words === 1 ? 'word' : 'words'}</span>
        <ToolButton editor={editor} label="Export Markdown" onClick={exportMarkdown}><FileDown size={14} /></ToolButton>
      </div>

      {/* Page */}
      <div className="slate-doc flex-1" onMouseDown={(e) => {
        // Clicking the empty margin below/around the page focuses the editor
        // at the end — the whole surface should feel like the document.
        if (e.target === e.currentTarget && editor) {
          e.preventDefault();
          editor.chain().focus('end').run();
        }
      }}>
        <div className="mx-auto w-full max-w-[780px] px-6 py-8 sm:px-10">
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
