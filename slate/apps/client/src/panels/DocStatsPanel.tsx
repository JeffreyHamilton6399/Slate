/**
 * DocStatsPanel — live document statistics for 'doc' boards.
 *
 * Reads the shared Y.XmlFragment and reports:
 *   - word count (whitespace-split, empty trimmed)
 *   - character count (visible characters only, no markup)
 *   - paragraph count (top-level paragraph nodes)
 *   - heading count (H1/H2/H3)
 *   - estimated reading time (200 wpm, rounded up to the nearest minute, min 1)
 *
 * All derived from the same dependency-free JSON converter the Markdown
 * exporter uses, so this panel works without a live TipTap editor instance
 * (e.g. while the editor is still mounting or in a headless test).
 */

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { useRoom } from '../sync/RoomContext';
import { docTextToJson } from '../docs/docTextJson';
import { docFragmentToText } from '../docs/exportMarkdown';

interface Stats {
  words: number;
  chars: number;
  paragraphs: number;
  headings: number;
  readingMinutes: number;
}

const WORDS_PER_MINUTE = 200;

export function DocStatsPanel() {
  const room = useRoom();
  const fragment = useMemo(() => room.slate.docText(), [room]);
  const [stats, setStats] = useState<Stats>(() => computeStats(fragment));

  useEffect(() => {
    const update = () => setStats(computeStats(fragment));
    fragment.observeDeep(update);
    update();
    return () => fragment.unobserveDeep(update);
  }, [fragment]);

  return (
    <div className="flex h-full flex-col gap-3">
      <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">
        Document Stats
      </h5>

      <dl className="grid grid-cols-2 gap-2">
        <Stat label="Words" value={stats.words} />
        <Stat label="Characters" value={stats.chars} />
        <Stat label="Paragraphs" value={stats.paragraphs} />
        <Stat label="Headings" value={stats.headings} />
      </dl>

      <div className="rounded-sm border border-border bg-bg-3 px-3 py-2 text-center">
        <p className="font-mono text-2xl font-semibold text-text">{stats.readingMinutes}</p>
        <p className="mt-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim">
          min read
        </p>
      </div>

      <p className="mt-auto text-[10px] leading-snug text-text-dim">
        Reading time assumes {WORDS_PER_MINUTE} words per minute. Counts update live as you and
        your collaborators type.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-sm border border-border bg-bg-3 px-2 py-1.5">
      <p className="font-mono text-lg font-semibold text-text">{value.toLocaleString()}</p>
      <p className="text-[10px] font-mono uppercase tracking-wider text-text-dim">{label}</p>
    </div>
  );
}

function computeStats(fragment: Y.XmlFragment): Stats {
  const json = docTextToJson(fragment);
  const blocks = json.content ?? [];

  let paragraphs = 0;
  let headings = 0;
  for (const node of blocks) {
    if (node.type === 'paragraph') paragraphs++;
    else if (node.type === 'heading') headings++;
  }

  // docFragmentToText returns one line per textual block — the plain-text
  // representation already strips every mark, so the length is the visible
  // character count and the whitespace-split is the word count.
  const text = docFragmentToText(fragment);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.replace(/\s+/g, '').length;
  const readingMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));

  return { words, chars, paragraphs, headings, readingMinutes };
}

export default DocStatsPanel;
