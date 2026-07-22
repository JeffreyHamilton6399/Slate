/**
 * PresentationToolsPanel — the dockable tools palette for presentation
 * (slides) boards. Organized into 5 minimal groups:
 *
 *   - Slide:   New / Duplicate / Delete / Move Left / Move Right
 *   - Text:    Bold / Italic / Underline / Text Color /
 *              Bullet List / Numbered List / Align Left/Center/Right
 *   - Insert:  Rectangle / Circle / Image
 *   - Design:  Background (swatches) + Theme (Dark / Light / Blue / Sunset)
 *   - Present: Present / Export HTML
 *
 * Every button dispatches a `slate:presentation-command` window event that
 * PresentationEditor listens for. The command names match what the editor's
 * switch statement handles: `newSlide` / `duplicateSlide` / `deleteSlide` /
 * `moveLeft` / `moveRight` / `bold` / `italic` / `underline` / `textColor` /
 * `bulletList` / `orderedList` / `alignLeft` / `alignCenter` / `alignRight` /
 * `shapeRect` / `shapeCircle` / `image` / `background` (with color value) /
 * `theme` (with id value) / `present` / `exportHtml`.
 *
 * Removed (per ROUND37-A spec): Animation picker, Font Size presets (the
 * toolbar has a Text Size dropdown), Clear Format, Clear Color,
 * Strikethrough, Code, Shapes beyond rect/circle, Section Divider template.
 */

import { type ReactNode } from 'react';
import {
  Plus, Copy as CopyIcon, Trash2, ChevronLeft, ChevronRight,
  Bold, Italic, Underline, Palette,
  List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight,
  Square, Circle as CircleIcon, Image as ImageIcon,
  Play as PlayIcon, FileCode2,
  type LucideIcon,
} from 'lucide-react';
import { runPresentationCommand } from '../presentation/presentationBridge';

interface Tool {
  command: string;
  label: string;
  Icon: LucideIcon;
  /** Optional value payload sent alongside the command (used for swatch
   *  buttons that already know their color at render time). */
  value?: string;
}

/** Theme presets — each sets the slide background AND default text color
 *  in one tap. The id strings are matched against the THEMES table in
 *  PresentationEditor.tsx. Limited to Dark / Light / Blue / Sunset per
 *  ROUND37-A spec. */
const THEME_PRESETS: { id: string; label: string; bg: string; color: string }[] = [
  { id: 'dark', label: 'Dark', bg: '#0c0c0e', color: '#f5f5f7' },
  { id: 'light', label: 'Light', bg: '#ffffff', color: '#1a1a1d' },
  { id: 'blue', label: 'Blue', bg: '#1e3a8a', color: '#ffffff' },
  { id: 'sunset', label: 'Sunset', bg: 'linear-gradient(135deg, #f97316 0%, #db2777 100%)', color: '#ffffff' },
];

/** Background swatches — solid tones + a couple of gradient hints. The
 *  gradient strings ship straight to PresentationEditor's `background`
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
  // Text color: a label-wrapped native color input. Clicking the label opens
  // the OS color picker; picking a color dispatches `textColor` with the hex.
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

const SLIDE_TOOLS: Tool[] = [
  { command: 'newSlide', label: 'New', Icon: Plus },
  { command: 'duplicateSlide', label: 'Duplicate', Icon: CopyIcon },
  { command: 'deleteSlide', label: 'Delete', Icon: Trash2 },
  { command: 'moveLeft', label: 'Move Left', Icon: ChevronLeft },
  { command: 'moveRight', label: 'Move Right', Icon: ChevronRight },
];

const TEXT_TOOLS: Tool[] = [
  { command: 'bold', label: 'Bold', Icon: Bold },
  { command: 'italic', label: 'Italic', Icon: Italic },
  { command: 'underline', label: 'Underline', Icon: Underline },
  { command: 'textColor', label: 'Color', Icon: Palette },
  { command: 'bulletList', label: 'Bullets', Icon: List },
  { command: 'orderedList', label: 'Numbered', Icon: ListOrdered },
  { command: 'alignLeft', label: 'Left', Icon: AlignLeft },
  { command: 'alignCenter', label: 'Center', Icon: AlignCenter },
  { command: 'alignRight', label: 'Right', Icon: AlignRight },
];

/** Insert tools — Rectangle, Circle, Image only. Shapes dispatch the
 *  `shapeRect` / `shapeCircle` commands (the editor inserts an absolutely-
 *  positioned `.slate-shape` div that can be dragged + resized). Image
 *  opens the hidden file picker. */
const INSERT_TOOLS: Tool[] = [
  { command: 'shapeRect', label: 'Rect', Icon: Square },
  { command: 'shapeCircle', label: 'Circle', Icon: CircleIcon },
  { command: 'image', label: 'Image', Icon: ImageIcon },
];

const PRESENT_TOOLS: Tool[] = [
  { command: 'present', label: 'Present', Icon: PlayIcon },
  { command: 'exportHtml', label: 'Export HTML', Icon: FileCode2 },
];

/** Background-swatch grid. Renders solid swatches with the actual color, and
 *  gradient swatches with the gradient as `backgroundImage` so the hint is
 *  visible at a glance. Each click dispatches `background` with the value. */
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
            onClick={() => runPresentationCommand('background', s.value)}
            className="aspect-square rounded-md border-2 border-border transition-transform hover:scale-105"
            style={s.gradient ? { backgroundImage: s.value } : { backgroundColor: s.value }}
          />
        ))}
      </div>
    </div>
  );
}

/** Themes section — quick one-tap presets that set both the slide background
 *  AND the default text color. Each preset renders as a small swatch with
 *  the theme's bg + the theme label colored with the theme's text color, so
 *  the user can see the contrast at a glance. */
function ThemePresets() {
  return (
    <div>
      <h5 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-dim">Themes</h5>
      <div className="grid grid-cols-2 gap-1">
        {THEME_PRESETS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={`Apply ${t.label} theme`}
            aria-label={`Apply ${t.label} theme`}
            onClick={() => runPresentationCommand('theme', t.id)}
            className="flex h-12 items-center justify-center rounded-md border-2 border-border text-sm font-semibold transition-transform hover:scale-105"
            style={t.bg.startsWith('linear-gradient')
              ? { backgroundImage: t.bg, color: t.color }
              : { backgroundColor: t.bg, color: t.color }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

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
      <Group title="Insert">
        {INSERT_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <BackgroundSwatches />
      <ThemePresets />
      <Group title="Present">
        {PRESENT_TOOLS.map((t) => (
          <ToolButton key={t.command} t={t} />
        ))}
      </Group>
      <p className="text-[10px] leading-snug text-text-dim">
        Use the toolbar above the slide for Bold/Italic/Underline, Text Size,
        Text Color, Bullet List, Add Slide, and Background swatches. Shapes
        (Rectangle, Circle) insert as draggable, resizable elements — click to
        select, drag to move, drag a corner handle to resize, Delete to
        remove. ←/→ navigate, Ctrl+Shift+N new slide, Ctrl+Shift+P present.
      </p>
    </div>
  );
}

export default PresentationToolsPanel;
