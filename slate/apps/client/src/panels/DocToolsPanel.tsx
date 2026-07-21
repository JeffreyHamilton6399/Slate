/**
 * DocToolsPanel — the complete tools palette for doc boards, shown in the
 * left dock. All formatting/insert/export actions live here — there is no
 * top toolbar in the DocEditor itself. Buttons dispatch commands via the
 * `slate:doc-command` window event.
 *
 * Two tools need a value payload alongside the command (the picked color for
 * `textColor`, the picked pixel size for `fontSize`). They render custom
 * controls (a native `<input type="color">` and a popover list respectively)
 * instead of the generic button — see `ToolButton` below.
 */

import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import {
  Heading1, Heading2, Heading3, Bold, Italic, Underline, Strikethrough,
  Code, Subscript, Superscript, Highlighter, Eraser,
  List, ListOrdered, ListTodo, TextQuote, SquareCode, Table as TableIcon,
  Minus, ImagePlus, Link2,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Indent, Outdent,
  Undo2, Redo2, Search, Printer, FileDown, FileCode2,
  Plus, Trash2, X, Palette, Type, ChevronDown,
  Rows3, Columns3, SquareCheck, Languages,
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
      { command: 'textColor', label: 'Text color', Icon: Palette },
      { command: 'clearColor', label: 'Clear color', Icon: X },
      { command: 'fontSize', label: 'Font size', Icon: Type },
      { command: 'clearFontSize', label: 'Reset size', Icon: Eraser },
      { command: 'clearFormat', label: 'Clear format', Icon: Eraser },
    ],
  },
  {
    title: 'Lists',
    tools: [
      { command: 'bulletList', label: 'Bullet list', Icon: List },
      { command: 'orderedList', label: 'Numbered', Icon: ListOrdered },
      { command: 'taskList', label: 'Checklist', Icon: ListTodo },
      { command: 'toggleTask', label: 'Toggle item', Icon: SquareCheck },
    ],
  },
  {
    title: 'Align',
    tools: [
      { command: 'alignLeft', label: 'Align left', Icon: AlignLeft },
      { command: 'alignCenter', label: 'Center', Icon: AlignCenter },
      { command: 'alignRight', label: 'Align right', Icon: AlignRight },
      { command: 'alignJustify', label: 'Justify', Icon: AlignJustify },
      { command: 'indent', label: 'Indent', Icon: Indent },
      { command: 'outdent', label: 'Outdent', Icon: Outdent },
    ],
  },
  {
    title: 'Insert',
    tools: [
      { command: 'blockquote', label: 'Quote', Icon: TextQuote },
      { command: 'codeBlock', label: 'Code block', Icon: SquareCode },
      { command: 'codeLang', label: 'Code language', Icon: Languages },
      { command: 'table', label: 'Table', Icon: TableIcon },
      { command: 'addCol', label: 'Add column', Icon: Plus },
      { command: 'addRow', label: 'Add row', Icon: Plus },
      { command: 'delCol', label: 'Delete column', Icon: Columns3 },
      { command: 'delRow', label: 'Delete row', Icon: Rows3 },
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

const FONT_SIZE_PRESETS = [12, 14, 16, 18, 24, 32];

/** Shared button chrome so every tool — generic or custom — looks the same. */
const TOOL_BUTTON_CLASS =
  'flex flex-col items-center gap-1 rounded-md border border-border bg-bg-2 px-1 py-1.5 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text';

function ToolButton({ t }: { t: Tool }) {
  // Text color: a label-wrapped native color input. Clicking anywhere on the
  // label opens the OS color picker; picking a color dispatches `textColor`
  // with the hex value. Invisible input sits behind the icon so the grid cell
  // looks identical to its neighbours.
  if (t.command === 'textColor') {
    return (
      <label title={t.label} aria-label={t.label} className={`${TOOL_BUTTON_CLASS} relative cursor-pointer`}>
        <t.Icon size={16} />
        <span className="text-[9px] leading-tight">{t.label}</span>
        <input
          type="color"
          aria-label={t.label}
          // The input is visually hidden but still receives clicks via the
          // wrapping label — the label forwards the click to its associated
          // control, which opens the OS color dialog.
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => runDocCommand('textColor', e.target.value)}
          // Default to the paper ink color so the picker opens on something
          // sensible rather than pure black or pure white.
          defaultValue="#1f2328"
        />
      </label>
    );
  }

  // Font size: a button that toggles a small popover of preset sizes plus a
  // "Default" entry that clears the size. Click-away closes the popover.
  if (t.command === 'fontSize') {
    return <FontSizeButton t={t} />;
  }

  return (
    <button
      type="button"
      title={t.label}
      aria-label={t.label}
      onClick={() => runDocCommand(t.command)}
      className={TOOL_BUTTON_CLASS}
    >
      <t.Icon size={16} />
      <span className="text-[9px] leading-tight">{t.label}</span>
    </button>
  );
}

function FontSizeButton({ t }: { t: Tool }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={t.label}
        aria-label={t.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={TOOL_BUTTON_CLASS}
      >
        <t.Icon size={16} />
        <span className="flex items-center text-[9px] leading-tight">
          {t.label}
          <ChevronDown size={10} className="ml-0.5 opacity-70" />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Font size"
          // Anchored to the right edge of the button so the menu doesn't
          // overflow the panel's left dock.
          className="absolute bottom-full right-0 z-30 mb-1 grid w-24 grid-cols-2 gap-0.5 rounded-md border border-border bg-bg-2 p-1 shadow-lg"
        >
          <SizeOption label="Default" onClick={() => { runDocCommand('clearFontSize'); setOpen(false); }} />
          {FONT_SIZE_PRESETS.map((px) => (
            <SizeOption
              key={px}
              label={`${px}`}
              // Visual preview: render the number at its own size so the
              // menu doubles as a sample of how the picked size reads.
              style={{ fontSize: `${Math.min(px, 16)}px` }}
              onClick={() => { runDocCommand('fontSize', String(px)); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SizeOption({ label, onClick, style }: { label: string; onClick: () => void; style?: CSSProperties }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={style}
      className="rounded px-1 py-1 text-center text-text-mid hover:bg-bg-3 hover:text-text"
    >
      {label}
    </button>
  );
}

/** Wrapper that lets the group header + grid render with arbitrary children. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h5 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">{title}</h5>
      <div className="grid grid-cols-4 gap-1">{children}</div>
    </div>
  );
}

export function DocToolsPanel() {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      {GROUPS.map((g) => (
        <Group key={g.title} title={g.title}>
          {g.tools.map((t) => (
            <ToolButton key={t.command} t={t} />
          ))}
        </Group>
      ))}
    </div>
  );
}

export default DocToolsPanel;
