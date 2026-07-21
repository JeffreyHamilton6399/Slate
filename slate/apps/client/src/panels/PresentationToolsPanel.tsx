/**
 * PresentationToolsPanel — the complete tools palette for presentation
 * (slides) boards, shown in the left dock. Mirrors DocToolsPanel's layout:
 * grouped tool grids, with two custom-rendered tools (text color → native
 * `<input type="color">`; font size → popover of preset sizes). Every
 * button dispatches a `slate:presentation-command` window event that
 * PresentationEditor listens for.
 *
 * Group breakdown:
 *   - Slide:   add / duplicate / delete / move left / move right
 *   - Text:    H1 / H2 / bold / italic / underline / strike /
 *              text color / clear format
 *   - Lists:   bullet / numbered
 *   - Align:   left / center / right
 *   - Design:  background color (swatches) / font size
 *   - Actions: present / export HTML
 *
 * Slide templates ("blank" / "title" / "title+content" / "two-column" /
 * "section") get their own popover under the "Add slide" button so the user
 * can pick a starting layout.
 */

import { useState, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import {
  Plus, Copy as CopyIcon, Trash2, ChevronLeft, ChevronRight,
  Heading1, Heading2, Bold, Italic, Underline, Strikethrough, Eraser,
  List, ListOrdered, Palette, Type,
  AlignLeft, AlignCenter, AlignRight,
  Play as PlayIcon, FileCode2, FileText, Layout, Square,
  ChevronDown, type LucideIcon,
} from 'lucide-react';
import { runPresentationCommand } from '../presentation/presentationBridge';

interface Tool {
  command: string;
  label: string;
  Icon: LucideIcon;
  /** Optional value payload sent alongside the command (used for swatch
   *  buttons that already know their color/size at render time). */
  value?: string;
}

/** Slide templates offered under the "Add slide" button. The matching HTML
 *  lives in PresentationEditor's applyTemplate() so this panel stays free of
 *  big string blobs. */
const SLIDE_TEMPLATES: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: 'blank', label: 'Blank', Icon: Square },
  { id: 'title', label: 'Title', Icon: Type },
  { id: 'title+content', label: 'Title + Content', Icon: FileText },
  { id: 'two-column', label: 'Two Column', Icon: Layout },
  { id: 'section', label: 'Section Divider', Icon: Heading1 },
];

const FONT_SIZE_PRESETS = [12, 14, 16, 18, 24, 32, 48, 64];

/** Background swatches — solid tones + a couple of gradient hints. The
 *  gradient strings ship straight to PresentationEditor's `setBackground`
 *  handler, which writes them into the slide's `background` field (and
 *  applies them as the slide's `style.backgroundColor`/`backgroundImage`). */
const BG_SWATCHES: { label: string; value: string; gradient?: boolean }[] = [
  { label: 'Near black', value: '#0c0c0e' },
  { label: 'White', value: '#ffffff' },
  { label: 'Slate', value: '#1e293b' },
  { label: 'Cream', value: '#f6f5f0' },
  { label: 'Amber', value: '#fef3c7' },
  { label: 'Sky', value: '#dbeafe' },
  { label: 'Mint', value: '#dcfce7' },
  { label: 'Indigo', value: '#4338ca' },
  { label: 'Emerald', value: '#065f46' },
  { label: 'Purple', value: '#6b21a8' },
  { label: 'Orange', value: '#c2410c' },
  { label: 'Sunset gradient', value: 'linear-gradient(135deg, #f97316 0%, #db2777 100%)', gradient: true },
  { label: 'Ocean gradient', value: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)', gradient: true },
  { label: 'Forest gradient', value: 'linear-gradient(135deg, #065f46 0%, #064e3b 100%)', gradient: true },
];

/** Shared button chrome so every tool — generic or custom — looks the same. */
const TOOL_BUTTON_CLASS =
  'flex flex-col items-center gap-1 rounded-md border border-border bg-bg-2 px-1 py-1.5 text-text-mid hover:border-accent/40 hover:bg-bg-3 hover:text-text';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h5 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">{title}</h5>
      <div className="grid grid-cols-4 gap-1">{children}</div>
    </div>
  );
}

function ToolButton({ t }: { t: Tool }) {
  // Text color: a label-wrapped native color input (same pattern as
  // DocToolsPanel). Clicking the label opens the OS color picker; picking a
  // color dispatches `textColor` with the hex value.
  if (t.command === 'textColor') {
    return (
      <label title={t.label} aria-label={t.label} className={`${TOOL_BUTTON_CLASS} relative cursor-pointer`}>
        <Palette size={16} />
        <span className="text-[9px] leading-tight">{t.label}</span>
        <input
          type="color"
          aria-label={t.label}
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => runPresentationCommand('textColor', e.target.value)}
          defaultValue="#ffffff"
        />
      </label>
    );
  }

  // Font size: a button that toggles a small popover of preset sizes.
  if (t.command === 'fontSize') {
    return <FontSizeButton t={t} />;
  }

  // Add slide: a button that toggles a templates popover.
  if (t.command === 'addSlideTemplate') {
    return <AddSlideButton t={t} />;
  }

  return (
    <button
      type="button"
      title={t.label}
      aria-label={t.label}
      onClick={() => runPresentationCommand(t.command, t.value)}
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
          className="absolute bottom-full right-0 z-30 mb-1 grid w-24 grid-cols-2 gap-0.5 rounded-md border border-border bg-bg-2 p-1 shadow-lg"
        >
          <SizeOption label="Default" onClick={() => { runPresentationCommand('clearFontSize'); setOpen(false); }} />
          {FONT_SIZE_PRESETS.map((px) => (
            <SizeOption
              key={px}
              label={`${px}`}
              style={{ fontSize: `${Math.min(px, 16)}px` }}
              onClick={() => { runPresentationCommand('fontSize', String(px)); setOpen(false); }}
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

function AddSlideButton({ t }: { t: Tool }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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
        title="Add slide (choose a template)"
        aria-label="Add slide"
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
          aria-label="Slide templates"
          className="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-border bg-bg-2 p-1 shadow-lg"
        >
          {SLIDE_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              role="menuitem"
              onClick={() => {
                runPresentationCommand('addSlideTemplate', tpl.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-[11px] text-text-mid hover:bg-bg-3 hover:text-text"
            >
              <tpl.Icon size={14} />
              {tpl.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Background-swatch grid. Renders solid swatches with the actual color, and
 *  gradient swatches with a checkerboard-ish two-tone fill so the gradient
 *  hint is visible at a glance. */
function BackgroundSwatches() {
  return (
    <div>
      <h5 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">Background</h5>
      <div className="grid grid-cols-7 gap-1">
        {BG_SWATCHES.map((s) => (
          <button
            key={s.label}
            type="button"
            title={s.label}
            aria-label={s.label}
            onClick={() => runPresentationCommand('setBackground', s.value)}
            className="aspect-square rounded-md border-2 border-border transition-transform hover:scale-105"
            style={s.gradient ? { backgroundImage: s.value } : { backgroundColor: s.value }}
          />
        ))}
      </div>
    </div>
  );
}

const SLIDE_TOOLS: Tool[] = [
  { command: 'addSlideTemplate', label: 'Add Slide', Icon: Plus },
  { command: 'duplicateSlide', label: 'Duplicate', Icon: CopyIcon },
  { command: 'deleteSlide', label: 'Delete', Icon: Trash2 },
  { command: 'moveSlideLeft', label: 'Move Left', Icon: ChevronLeft },
  { command: 'moveSlideRight', label: 'Move Right', Icon: ChevronRight },
];

const TEXT_TOOLS: Tool[] = [
  { command: 'h1', label: 'H1', Icon: Heading1 },
  { command: 'h2', label: 'H2', Icon: Heading2 },
  { command: 'bold', label: 'Bold', Icon: Bold },
  { command: 'italic', label: 'Italic', Icon: Italic },
  { command: 'underline', label: 'Underline', Icon: Underline },
  { command: 'strike', label: 'Strike', Icon: Strikethrough },
  { command: 'textColor', label: 'Color', Icon: Palette },
  { command: 'clearFormat', label: 'Clear', Icon: Eraser },
];

const LIST_TOOLS: Tool[] = [
  { command: 'bulletList', label: 'Bullets', Icon: List },
  { command: 'orderedList', label: 'Numbered', Icon: ListOrdered },
];

const ALIGN_TOOLS: Tool[] = [
  { command: 'alignLeft', label: 'Left', Icon: AlignLeft },
  { command: 'alignCenter', label: 'Center', Icon: AlignCenter },
  { command: 'alignRight', label: 'Right', Icon: AlignRight },
];

const DESIGN_TOOLS: Tool[] = [
  { command: 'fontSize', label: 'Font Size', Icon: Type },
];

const ACTION_TOOLS: Tool[] = [
  { command: 'present', label: 'Present', Icon: PlayIcon },
  { command: 'exportHtml', label: 'Export HTML', Icon: FileCode2 },
];

export function PresentationToolsPanel() {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <Group title="Slide">
        {SLIDE_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <Group title="Text">
        {TEXT_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <Group title="Lists">
        {LIST_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <Group title="Align">
        {ALIGN_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <BackgroundSwatches />
      <Group title="Design">
        {DESIGN_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <Group title="Actions">
        {ACTION_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <p className="text-[10px] leading-snug text-text-dim">
        Pick a slide template to add a pre-built layout, then edit in the
        canvas. Drag thumbnails in the navigator to reorder. ←/→ navigate,
        Ctrl+Shift+N adds a slide, Ctrl+Shift+P presents.
      </p>
    </div>
  );
}

export default PresentationToolsPanel;
