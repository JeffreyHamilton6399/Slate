/**
 * First-run / re-entry surface — pick a display name and a board to enter.
 * No accounts. The board name doubles as the Yjs room name.
 */

import { useEffect, useState } from 'react';
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
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const [rooms, setRooms] = useState<PublicRoom[]>([]);

  useEffect(() => {
    fetchRooms().then(setRooms).catch(() => setRooms([]));
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const clean = sanitizeDisplayName(name) || 'Guest';
    const room = sanitizeBoardName(board) || randomBoardName();
    setDisplayName(clean);
    enterBoard({
      name: room,
      mode,
      visibility,
      iAmCreator: !rooms.some((r) => r.name === room),
      joinedAt: Date.now(),
    });
  };

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center p-6 bg-bg overflow-auto">
      <div className="surface w-full max-w-md p-8 flex flex-col gap-5 shadow-[0_32px_80px_rgba(0,0,0,0.5),0_0_0_1px_var(--accent-glow)]">
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
            <FieldLabel>Board name (optional)</FieldLabel>
            <Input
              maxLength={80}
              value={board}
              onChange={(e) => setBoard(e.target.value)}
              placeholder="leave empty for a fresh board"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <SegmentedControl
              label="Visibility"
              value={visibility}
              onChange={(v) => setVisibility(v as 'public' | 'private')}
              options={[
                { v: 'public', label: 'Public' },
                { v: 'private', label: 'Private' },
              ]}
            />
            <SegmentedControl
              label="Mode"
              value={mode}
              onChange={(v) => setMode(v as '2d' | '3d')}
              options={[
                { v: '2d', label: '2D' },
                { v: '3d', label: '3D' },
              ]}
            />
          </div>
          <Button type="submit" size="lg" className="mt-2 w-full">
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

function SegmentedControl({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; label: string }[];
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-0 bg-bg-3 rounded-sm p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={cn(
              'flex-1 text-center text-xs py-1.5 rounded-sm font-medium transition-colors',
              value === o.v ? 'bg-accent text-white' : 'text-text-dim hover:text-text',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SlateMark() {
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

function sanitizeBoardName(s: string): string {
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

function randomBoardName(): string {
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Math.floor(Math.random() * 1000)
    .toString(36)
    .padStart(2, '0');
  return `${a}-${n}-${id}`;
}
