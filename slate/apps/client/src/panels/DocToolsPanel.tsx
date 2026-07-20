/**
 * DocToolsPanel — a dockable "tools" palette for doc boards (the 2D-style left
 * bar, but for writing). Buttons dispatch formatting/insert commands to the
 * central DocEditor via the `slate:doc-command` window event, so the panel
 * doesn't need a handle on the editor instance.
 *
 * The top editor toolbar still has inline formatting + everything else; this is
 * a quick-access palette for structure and inserts.
 */

import {
  Heading1, Heading2, Heading3, Bold, Italic, Underline,
  List, ListOrdered, ListTodo, TextQuote, SquareCode, Table as TableIcon,
  Minus, ImagePlus, Link2, type LucideIcon,
} from 'lucide-react';
import { runDocCommand } from '../docs/docBridge';

interface Tool {
  command: string;
  label: string;
  Icon: LucideIcon;
}

const GROUPS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Text',
    tools: [
      { command: 'h1', label: 'Heading 1', Icon: Heading1 },
      { command: 'h2', label: 'Heading 2', Icon: Heading2 },
      { command: 'h3', label: 'Heading 3', Icon: Heading3 },
      { command: 'bold', label: 'Bold', Icon: Bold },
      { command: 'italic', label: 'Italic', Icon: Italic },
      { command: 'underline', label: 'Underline', Icon: Underline },
    ],
  },
  {
    title: 'Lists',
    tools: [
      { command: 'bulletList', label: 'Bullet list', Icon: List },
      { command: 'orderedList', label: 'Numbered list', Icon: ListOrdered },
      { command: 'taskList', label: 'Checklist', Icon: ListTodo },
    ],
  },
  {
    title: 'Insert',
    tools: [
      { command: 'blockquote', label: 'Quote', Icon: TextQuote },
      { command: 'codeBlock', label: 'Code block', Icon: SquareCode },
      { command: 'table', label: 'Table', Icon: TableIcon },
      { command: 'hr', label: 'Divider', Icon: Minus },
      { command: 'image', label: 'Image', Icon: ImagePlus },
      { command: 'link', label: 'Link', Icon: Link2 },
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
