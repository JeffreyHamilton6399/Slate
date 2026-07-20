/**
 * DocToolsPanel — the complete tools palette for doc boards, shown in the
 * left dock. All formatting/insert/export actions live here — there is no
 * top toolbar in the DocEditor itself. Buttons dispatch commands via the
 * `slate:doc-command` window event.
 */

import {
  Heading1, Heading2, Heading3, Bold, Italic, Underline, Strikethrough,
  Code, Subscript, Superscript, Highlighter, Eraser,
  List, ListOrdered, ListTodo, TextQuote, SquareCode, Table as TableIcon,
  Minus, ImagePlus, Link2,
  AlignLeft, AlignCenter, AlignRight, Indent, Outdent,
  Undo2, Redo2, Search, Printer, FileDown, FileCode2,
  Plus, Trash2,
  type LucideIcon,
} from 'lucide-react';
import { runDocCommand } from '../docs/docBridge';

interface Tool {
  command: string;
  label: string;
  Icon: LucideIcon;
}

const GROUPS: { title: string; tools: Tool[] }[] = [
  {
    title: 'History',
    tools: [
      { command: 'undo', label: 'Undo', Icon: Undo2 },
      { command: 'redo', label: 'Redo', Icon: Redo2 },
    ],
  },
  {
    title: 'Text',
    tools: [
      { command: 'h1', label: 'Heading 1', Icon: Heading1 },
      { command: 'h2', label: 'Heading 2', Icon: Heading2 },
      { command: 'h3', label: 'Heading 3', Icon: Heading3 },
      { command: 'bold', label: 'Bold', Icon: Bold },
      { command: 'italic', label: 'Italic', Icon: Italic },
      { command: 'underline', label: 'Underline', Icon: Underline },
      { command: 'strike', label: 'Strikethrough', Icon: Strikethrough },
      { command: 'code', label: 'Inline code', Icon: Code },
      { command: 'subscript', label: 'Subscript', Icon: Subscript },
      { command: 'superscript', label: 'Superscript', Icon: Superscript },
      { command: 'highlight', label: 'Highlight', Icon: Highlighter },
      { command: 'clearFormat', label: 'Clear format', Icon: Eraser },
    ],
  },
  {
    title: 'Lists',
    tools: [
      { command: 'bulletList', label: 'Bullet list', Icon: List },
      { command: 'orderedList', label: 'Numbered', Icon: ListOrdered },
      { command: 'taskList', label: 'Checklist', Icon: ListTodo },
    ],
  },
  {
    title: 'Align',
    tools: [
      { command: 'alignLeft', label: 'Align left', Icon: AlignLeft },
      { command: 'alignCenter', label: 'Center', Icon: AlignCenter },
      { command: 'alignRight', label: 'Align right', Icon: AlignRight },
      { command: 'indent', label: 'Indent', Icon: Indent },
      { command: 'outdent', label: 'Outdent', Icon: Outdent },
    ],
  },
  {
    title: 'Insert',
    tools: [
      { command: 'blockquote', label: 'Quote', Icon: TextQuote },
      { command: 'codeBlock', label: 'Code block', Icon: SquareCode },
      { command: 'table', label: 'Table', Icon: TableIcon },
      { command: 'addCol', label: 'Add column', Icon: Plus },
      { command: 'addRow', label: 'Add row', Icon: Plus },
      { command: 'delTable', label: 'Delete table', Icon: Trash2 },
      { command: 'hr', label: 'Divider', Icon: Minus },
      { command: 'image', label: 'Image', Icon: ImagePlus },
      { command: 'link', label: 'Link', Icon: Link2 },
    ],
  },
  {
    title: 'Actions',
    tools: [
      { command: 'find', label: 'Find', Icon: Search },
      { command: 'print', label: 'Print', Icon: Printer },
      { command: 'exportMd', label: 'Export .md', Icon: FileDown },
      { command: 'exportHtml', label: 'Export .html', Icon: FileCode2 },
    ],
  },
];

export function DocToolsPanel() {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      {GROUPS.map((g) => (
        <div key={g.title}>
          <h5 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">{g.title}</h5>
          <div className="grid grid-cols-3 gap-1">
            {g.tools.map((t) => (
              <button
                key={t.command}
                type="button"
                title={t.label}
                aria-label={t.label}
                onClick={() => runDocCommand(t.command)}
                className="flex flex-col items-center gap-1 rounded-md border border-border bg-bg-2 px-1 py-2 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text"
              >
                <t.Icon size={16} />
                <span className="text-[9px] leading-tight">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default DocToolsPanel;
