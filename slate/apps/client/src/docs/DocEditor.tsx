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
  Indent, Outdent, ChevronDown, Type,
} from 'lucide-react';
import { colorForPeerId } from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { fileToImageShape, isImageFile } from '../canvas2d/importImage';
import { DOC_APPLY_EVENT, DOC_COMMAND_EVENT, type DocApplyDetail } from './docBridge';
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

  // The dockable Doc Tools panel dispatches formatting/insert commands via a
  // window event (it can't reach this editor instance directly).
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const cmd = (e as CustomEvent<{ command: string }>).detail?.command;
      if (!cmd) return;
      const c = editor.chain().focus();
      switch (cmd) {
        // History
        case 'undo': editor.commands.undo(); break;
        case 'redo': editor.commands.redo(); break;
        // Headings
        case 'h1': c.toggleHeading({ level: 1 }).run(); break;
        case 'h2': c.toggleHeading({ level: 2 }).run(); break;
        case 'h3': c.toggleHeading({ level: 3 }).run(); break;
        // Inline formatting
        case 'bold': c.toggleBold().run(); break;
        case 'italic': c.toggleItalic().run(); break;
        case 'underline': c.toggleUnderline().run(); break;
        case 'strike': c.toggleStrike().run(); break;
        case 'code': c.toggleCode().run(); break;
        case 'subscript': c.toggleSubscript().run(); break;
        case 'superscript': c.toggleSuperscript().run(); break;
        case 'highlight': c.toggleHighlight().run(); break;
        case 'clearFormat': c.unsetAllMarks().clearNodes().run(); break;
        // Lists
        case 'bulletList': c.toggleBulletList().run(); break;
        case 'orderedList': c.toggleOrderedList().run(); break;
        case 'taskList': c.toggleTaskList().run(); break;
        // Alignment
        case 'alignLeft': c.setTextAlign('left').run(); break;
        case 'alignCenter': c.setTextAlign('center').run(); break;
        case 'alignRight': c.setTextAlign('right').run(); break;
        case 'indent': c.sinkListItem('listItem').run(); break;
        case 'outdent': c.liftListItem('listItem').run(); break;
        // Insert
        case 'blockquote': c.toggleBlockquote().run(); break;
        case 'codeBlock': c.toggleCodeBlock().run(); break;
        case 'table': c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
        case 'addCol': c.addColumnAfter().run(); break;
        case 'addRow': c.addRowAfter().run(); break;
        case 'delTable': c.deleteTable().run(); break;
        case 'hr': c.setHorizontalRule().run(); break;
        case 'image': imageInputRef.current?.click(); break;
        case 'link': {
          const url = window.prompt('Link URL');
          if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
          break;
        }
        // Actions
        case 'find': findInDoc(); break;
        case 'print': window.print(); break;
        case 'exportMd': exportMarkdown(); break;
        case 'exportHtml': exportHtml(); break;
        default: break;
      }
    };
    window.addEventListener(DOC_COMMAND_EVENT, handler as EventListener);
    return () => window.removeEventListener(DOC_COMMAND_EVENT, handler as EventListener);
  }, [editor]);

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

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* No top toolbar — all tools are in the left dock's DocToolsPanel */}
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

      {/* Word count footer */}
      <div className="flex shrink-0 items-center justify-end border-t border-border px-3 py-0.5 text-[10px] font-mono text-text-dim">
        {words} {words === 1 ? 'word' : 'words'}
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

export default DocEditor;
