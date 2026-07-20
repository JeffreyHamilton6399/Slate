/**
 * DocOutlinePanel — table of contents for 'doc' boards.
 *
 * Walks the board's shared Y.XmlFragment (the same one TipTap renders) and
 * pulls every heading 1/2/3 in document order, rendering them as a clickable
 * outline indented by level. Clicking a heading scrolls the live editor to
 * that heading and briefly flashes it so the user can spot it.
 *
 * The panel reads Yjs directly (via docTextToJson — the same dependency-free
 * converter the Markdown exporter uses) so it stays in sync without needing
 * a live TipTap editor instance. The jump-to-heading pass is pure DOM: the
 * editor renders each heading as an <h1>/<h2>/<h3> under `.slate-doc`, so we
 * query that subtree and `scrollIntoView` the nth heading.
 */

import { useEffect, useState } from 'react';
import { ListTree } from 'lucide-react';
import * as Y from 'yjs';
import { useRoom } from '../sync/RoomContext';
import { docTextToJson, type PmJsonNode } from '../docs/docTextJson';

interface Heading {
  /** Stable key — the index of this heading among all headings in the doc. */
  index: number;
  /** 1, 2, or 3 (clamped from the node's level attr). */
  level: number;
  /** Flattened text content (inline marks stripped). */
  text: string;
}

export function DocOutlinePanel() {
  const room = useRoom();
  const [headings, setHeadings] = useState<Heading[]>([]);

  useEffect(() => {
    const fragment = room.slate.docText();
    const update = () => setHeadings(extractHeadings(fragment));
    // observeDeep because attrs (heading level) live on the XmlElement while
    // text lives in nested XmlText children — a shallow observe would miss
    // edits inside an existing heading.
    fragment.observeDeep(update);
    update();
    return () => fragment.unobserveDeep(update);
  }, [room]);

  const jumpTo = (index: number) => {
    // TipTap renders headings as <h1>/<h2>/<h3> inside the editor's
    // ProseMirror root. The nth one in document order is the heading at
    // `index` — match the order extractHeadings walked the Yjs tree in.
    const nodes = document.querySelectorAll<HTMLElement>(
      '.slate-doc .ProseMirror h1, .slate-doc .ProseMirror h2, .slate-doc .ProseMirror h3, .slate-doc .ProseMirror h4',
    );
    const target = nodes[index];
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('slate-outline-flash');
    setTimeout(() => target.classList.remove('slate-outline-flash'), 1200);
  };

  if (headings.length === 0) {
    return (
      <div className="flex h-full flex-col gap-2">
        <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">
          <ListTree size={11} className="mr-1 inline-block align-[-1px]" />
          Outline
        </h5>
        <p className="px-2 py-4 text-center text-xs text-text-dim">
          Add a heading (H1/H2/H3) to your document and it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">
        <ListTree size={11} className="mr-1 inline-block align-[-1px]" />
        Outline
        <span className="ml-1 normal-case text-text-dim/70">({headings.length})</span>
      </h5>
      <nav aria-label="Document outline" className="flex-1 overflow-y-auto pr-1">
        <ul className="flex flex-col gap-0.5">
          {headings.map((h) => (
            <li key={h.index}>
              <button
                type="button"
                onClick={() => jumpTo(h.index)}
                title={`Jump to “${h.text}”`}
                className={`block w-full truncate rounded-sm px-2 py-1 text-left text-xs text-text-mid transition-colors hover:bg-bg-3 hover:text-text ${
                  h.level === 1
                    ? 'font-semibold text-text'
                    : h.level === 2
                      ? 'pl-4'
                      : 'pl-7 text-text-dim'
                }`}
              >
                {h.text || '(untitled heading)'}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** Walk the doc's JSON shape and collect heading nodes in document order. */
function extractHeadings(fragment: Y.XmlFragment): Heading[] {
  const json = docTextToJson(fragment);
  const out: Heading[] = [];
  let i = 0;
  for (const node of json.content ?? []) {
    if (node.type === 'heading') {
      const level = clampLevel(Number(node.attrs?.level ?? 1));
      const text = flattenInline(node.content ?? []);
      out.push({ index: i, level, text });
      i++;
    }
  }
  return out;
}

function clampLevel(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.floor(n)));
}

/** Flatten a heading's inline content into a plain string. */
function flattenInline(nodes: PmJsonNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n.text === 'string') {
      out += n.text;
    } else if (n.type === 'hardBreak') {
      out += ' ';
    } else if (n.content) {
      out += flattenInline(n.content);
    }
  }
  return out;
}

export default DocOutlinePanel;
