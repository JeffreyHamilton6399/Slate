/**
 * First-run / re-entry surface — pick a display name and a board to enter.
 * No accounts. The board name doubles as the Yjs room name.
 */

import { useEffect, useState } from 'react';
import { Box as BoxIcon, Globe, Lock, PenLine } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input, FieldLabel } from '../ui/Input';
import { useAppStore } from './store';
import { fetchRooms, type PublicRoom } from '../sync/rooms';
import { sanitizeDisplayName } from '@slate/sync-protocol';
import { cn } from '../utils/cn';

export function Onboarding() {
  const cachedName = useAppStore((s) => s.displayName);
  const enterBoard = useAppStore((s) => s.enterBoard);
  const setDisplayName = useAppStore((s) => s.setDisplayName);

  const [name, setName] = useState(cachedName || '');
  const [board, setBoard] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [mode, setMode] = useState<'2d' | '3d' | 'audio'>('2d');
  const [rooms, setRooms] = useState<PublicRoom[]>([]);

  // Share links carry ?board= (and optionally &mode=). Join directly when we
  // already know the visitor's name; otherwise prefill the form.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkBoard = sanitizeBoardName(params.get('board') ?? '');
    const linkModeRaw = params.get('mode');
    const linkMode = linkModeRaw === '3d' ? '3d' : linkModeRaw === '2d' ? '2d' : null;

    fetchRooms()
      .then((rs) => {
        setRooms(rs);
        if (!linkBoard) return;
        // Drop the param so leaving the board doesn't bounce back in.
        window.history.replaceState(null, '', window.location.pathname);
        const found = rs.find((r) => r.name === linkBoard);
        const m = linkMode ?? found?.mode ?? '2d';
        if (cachedName) {
          enterBoard({
            name: linkBoard,
            mode: m,
            visibility: found?.visibility ?? 'public',
            iAmCreator: false,
            joinedAt: Date.now(),
          });
        } else {
          setBoard(linkBoard);
          setMode(m);
        }
      })
      .catch(() => setRooms([]));
    // Run once on mount; deliberately not reactive to name edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const clean = sanitizeDisplayName(name) || 'Guest';
    // Board name is required — the user must name their project.
    const room = sanitizeBoardName(board);
    if (!room) return;
    setDisplayName(clean);
    enterBoard({
      name: room,
      mode,
      visibility,
      iAmCreator: !rooms.some((r) => r.name === room),
      joinedAt: Date.now(),
    });
  };

  const canSubmit = sanitizeBoardName(board).length > 0;

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center p-6 bg-bg overflow-auto">
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none fixed inset-0 opacity-60">
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-accent/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-green/15 blur-3xl" />
      </div>
      <div className="surface relative w-full max-w-md p-8 flex flex-col gap-5 shadow-[0_32px_80px_rgba(0,0,0,0.5),0_0_0_1px_var(--accent-glow)]">
        <header className="flex items-center gap-3">
          <SlateMark />
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-br from-text to-accent bg-clip-text text-transparent leading-tight">
              Slate
            </h1>
            <p className="text-xs text-text-dim">Real-time whiteboard &amp; 3D editor</p>
          </div>
        </header>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <FieldLabel>Your name</FieldLabel>
            <Input
              autoFocus
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alex"
            />
          </div>
          <div>
            <FieldLabel>Project name</FieldLabel>
            <Input
              maxLength={80}
              value={board}
              onChange={(e) => setBoard(e.target.value)}
              placeholder="Name your project"
              className="max-w-xs"
              required
            />
          </div>
          {/* Single-icon toggles: click to flip visibility / mode. Compact. */}
          <div className="flex items-center gap-3">
            <IconToggle
              active={visibility === 'public'}
              onClick={() => setVisibility(visibility === 'public' ? 'private' : 'public')}
              onIcon={<Globe size={15} />}
              offIcon={<Lock size={15} />}
              onLabel="Public"
              offLabel="Private"
            />
            <IconToggle
              active={mode !== '2d'}
              onClick={() => setMode(mode === '2d' ? '3d' : mode === '3d' ? 'audio' : '2d')}
              onIcon={<BoxIcon size={15} />}
              offIcon={<PenLine size={15} />}
              onLabel={mode === '3d' ? '3D' : 'Audio'}
              offLabel="2D"
            />
          </div>
          <Button type="submit" size="lg" className="mt-2 w-full" disabled={!canSubmit}>
            Enter board
          </Button>
        </form>
        {rooms.length > 0 && (
          <div className="border-t border-border pt-4 max-h-44 overflow-y-auto">
            <div className="panel-title mb-2">Live public boards</div>
            <ul className="flex flex-col gap-1">
              {rooms.map((r) => (
                <li key={r.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setBoard(r.name);
                      setMode(r.mode);
                    }}
                    className="w-full flex items-center justify-between rounded-sm px-2 py-1.5 text-sm text-text-mid hover:text-text hover:bg-bg-3"
                  >
                    <span className="font-mono truncate">{r.name}</span>
                    <span className="text-xs text-text-dim">
                      {r.members} · {r.mode}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** A single-icon toggle button: shows one icon when active, another when not.
 *  Clicking flips the state. More compact than a 2-button segmented control. */
function IconToggle({
  active,
  onClick,
  onIcon,
  offIcon,
  onLabel,
  offLabel,
}: {
  active: boolean;
  onClick: () => void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <Tooltip content={active ? onLabel : offLabel}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={active ? onLabel : offLabel}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-sm border transition-colors',
          active
            ? 'border-accent/60 bg-accent/15 text-accent'
            : 'border-border text-text-mid hover:bg-bg-3 hover:text-text',
        )}
      >
        {active ? onIcon : offIcon}
      </button>
    </Tooltip>
  );
}

function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <span title={content} className="contents">
      {children}
    </span>
  );
}

export function SlateMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#0c0c0e" />
      <rect x="3" y="3" width="26" height="26" rx="4" fill="none" stroke="#7c6aff" strokeWidth="1.8" />
      <path
        d="M20 8l4 4-10 10-4.5 1 1-4.5z"
        fill="none"
        stroke="#7c6aff"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <line x1="7" y1="25" x2="14" y2="25" stroke="#7c6aff" strokeWidth="1.6" strokeLinecap="round" opacity=".5" />
    </svg>
  );
}

export function sanitizeBoardName(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[^A-Za-z0-9_\-. ]/g, '')
    .trim()
    .slice(0, 80);
}

const adjectives = [
  'silent',
  'cosmic',
  'velvet',
  'lucid',
  'crimson',
  'frosted',
  'amber',
  'mellow',
  'spectral',
  'glacial',
];
const nouns = [
  'meadow',
  'rivulet',
  'mosaic',
  'cathedral',
  'horizon',
  'echo',
  'lantern',
  'thicket',
  'cipher',
  'glade',
];

export function randomBoardName(): string {
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Math.floor(Math.random() * 1000)
    .toString(36)
    .padStart(2, '0');
  return `${a}-${n}-${id}`;
}
