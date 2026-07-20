/**
 * CodeSearchPanel — project-wide text search across every file in a 'code'
 * board.
 *
 * Reads each Y.Text snapshot (cheap — no Yjs observe), runs a case-sensitive
 * or case-insensitive plain-text/regex match line by line, and groups hits
 * by file. Clicking a hit opens the file in the central CodeEditor (via the
 * same `slate:code-open-file` window event the file tree uses) — the editor
 * owns the cursor/scroll, this panel only triggers navigation.
 *
 * Re-runs the search when the query changes, the case-sensitivity toggle
 * flips, or any file's content changes (a deep observe on the files map
 * catches edits, renames, add/delete — the actual content lives in
 * top-level Y.Texts so the search pass reads them lazily on each refresh).
 */

import { useEffect, useMemo, useState } from 'react';
import { Search, CaseSensitive, Regex, FileCode2, ChevronRight } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { listCodeFiles } from '../code/exportCode';
import { openCodeFile } from './CodeFilesPanel';

interface Hit {
  /** 1-based line number. */
  line: number;
  /** The full text of the matching line. */
  text: string;
  /** Indexes within `text` of each match (so we can highlight them). */
  ranges: { from: number; to: number }[];
}
interface FileHits {
  id: string;
  name: string;
  hits: Hit[];
}

export function CodeSearchPanel() {
  const room = useRoom();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [, bump] = useState(0);

  // Re-render on file map changes (add/rename/delete, local or remote). The
  // actual content lives in top-level Y.Texts that are read lazily during
  // the search pass, so we don't need to observe them individually.
  useEffect(() => {
    const files = room.slate.codeFiles();
    const fn = () => bump((v) => v + 1);
    files.observeDeep(fn);
    return () => files.unobserveDeep(fn);
  }, [room]);

  const files = listCodeFiles(room.slate);

  // Run the search whenever the inputs change OR whenever the file list
  // changes (the `files` array identity flips on every observeDeep callback
  // because listCodeFiles builds a fresh array — that's our re-render signal).
  const results = useMemo<FileHits[]>(() => {
    const q = query;
    if (!q) return [];
    let matcher: (line: string) => { from: number; to: number }[];
    try {
      if (useRegex) {
        const flags = caseSensitive ? 'g' : 'gi';
        const re = new RegExp(q, flags);
        matcher = (line) => {
          const out: { from: number; to: number }[] = [];
          // reset lastIndex in case the regex was used before (sticky 'g').
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(line)) !== null) {
            if (m[0].length === 0) {
              // Zero-width match: advance manually to avoid an infinite loop.
              re.lastIndex++;
              continue;
            }
            out.push({ from: m.index, to: m.index + m[0].length });
          }
          return out;
        };
      } else {
        const needle = caseSensitive ? q : q.toLowerCase();
        matcher = (line) => {
          const hay = caseSensitive ? line : line.toLowerCase();
          const out: { from: number; to: number }[] = [];
          let i = 0;
          while (i <= hay.length) {
            const idx = hay.indexOf(needle, i);
            if (idx === -1) break;
            out.push({ from: idx, to: idx + needle.length });
            i = idx + needle.length;
          }
          return out;
        };
      }
    } catch {
      // Invalid regex — surface no results rather than throwing in render.
      return [];
    }

    const out: FileHits[] = [];
    for (const f of files) {
      const text = room.slate.codeText(f.id).toString();
      const lines = text.split('\n');
      const hits: Hit[] = [];
      lines.forEach((line, i) => {
        const ranges = matcher(line);
        if (ranges.length > 0) hits.push({ line: i + 1, text: line, ranges });
      });
      if (hits.length > 0) out.push({ id: f.id, name: f.name, hits });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, useRegex, files]);

  const totalHits = results.reduce((n, f) => n + f.hits.length, 0);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter is a no-op — search is already live. Prevent form submit noise.
    if (e.key === 'Enter') e.preventDefault();
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <h5 className="panel-title text-[10px] font-mono uppercase tracking-wider text-text-dim">
        <Search size={11} className="mr-1 inline-block align-[-1px]" />
        Search Code
      </h5>

      <div className="flex flex-col gap-1.5">
        <div className="relative">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-dim" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={useRegex ? '/pattern/' : 'Find in files…'}
            aria-label="Search query"
            className="w-full rounded-sm border border-border bg-bg-3 py-1 pl-6 pr-2 text-xs text-text outline-none focus:border-accent/50"
          />
        </div>
        <div className="flex items-center gap-1">
          <Toggle active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} label="Case sensitive">
            <CaseSensitive size={11} />
          </Toggle>
          <Toggle active={useRegex} onClick={() => setUseRegex((v) => !v)} label="Regular expression">
            <Regex size={11} />
          </Toggle>
          {query && (
            <span className="ml-auto font-mono text-[10px] text-text-dim">
              {totalHits} {totalHits === 1 ? 'match' : 'matches'} in {results.length}{' '}
              {results.length === 1 ? 'file' : 'files'}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {!query ? (
          <p className="px-2 py-4 text-center text-xs text-text-dim">
            Type above to search every file on this board.
          </p>
        ) : results.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-text-dim">No matches.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((f) => (
              <li key={f.id}>
                <div className="flex items-center gap-1 px-1 text-[11px] font-mono text-text-mid">
                  <FileCode2 size={11} className="opacity-70" />
                  <span className="truncate font-semibold text-text">{f.name}</span>
                  <span className="text-text-dim">·</span>
                  <span className="text-text-dim">{f.hits.length}</span>
                </div>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {f.hits.map((hit, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => openCodeFile(f.id)}
                        title={`Open ${f.name} at line ${hit.line}`}
                        className="group flex w-full items-start gap-1 rounded-sm px-1 py-0.5 text-left text-[11px] text-text-mid hover:bg-bg-3 hover:text-text"
                      >
                        <span className="w-8 shrink-0 text-right font-mono text-text-dim group-hover:text-accent">
                          {hit.line}
                        </span>
                        <ChevronRight size={11} className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100" />
                        <span className="truncate font-mono">
                          {hit.text.trim() || '(empty line)'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Toggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={`flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] transition-colors ${
        active
          ? 'border-accent/40 bg-accent/15 text-accent'
          : 'border-border text-text-dim hover:bg-bg-3 hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

export default CodeSearchPanel;
