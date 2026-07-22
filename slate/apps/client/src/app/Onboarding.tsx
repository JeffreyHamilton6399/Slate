/**
 * First-run / re-entry surface — pick a display name and a board to enter.
 * No accounts. The board name doubles as the Yjs room name.
 */

import { useEffect, useState } from 'react';
import { Box as BoxIcon, Globe, Lock, PenLine, Music as MusicIcon, Braces as BracesIcon, Workflow as WorkflowIcon, Presentation as PresentationIcon, FolderOpen, Clock, Trash2, Coffee, Info, FileText, Users, User } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input, FieldLabel } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/DropdownMenu';
import { useAppStore } from './store';
import { fetchRooms, type PublicRoom } from '../sync/rooms';
import { sanitizeDisplayName, type DocMode } from '@slate/sync-protocol';
import { cn } from '../utils/cn';
import { listSaves, deleteSave } from '../files/snapshot';
import { AboutDialog } from './AboutDialog';
import { TermsDialog } from './TermsDialog';
import { modeBadgeClass, modeGradientClass, modeHoverBorderClass, modeTextClass } from './modeColors';

export function Onboarding() {
  const cachedName = useAppStore((s) => s.displayName);
  const enterBoard = useAppStore((s) => s.enterBoard);
  const setDisplayName = useAppStore((s) => s.setDisplayName);

  const [name, setName] = useState(cachedName || '');
  const [board, setBoard] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [mode, setMode] = useState<DocMode>('2d');
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [allProjectsOpen, setAllProjectsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [tos, setTos] = useState(false);
  const [savesVersion, setSavesVersion] = useState(0);

  // Build recents from local saves (max 3).
  const recents = (() => {
    const byBoard = new Map<string, { boardName: string; mode: DocMode; savedAt: number }>();
    for (const e of listSaves()) {
      const cur = byBoard.get(e.boardName);
      if (!cur || e.savedAt > cur.savedAt) {
        byBoard.set(e.boardName, { boardName: e.boardName, mode: e.mode, savedAt: e.savedAt });
      }
    }
    return [...byBoard.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, 3);
     
  })();

  const allProjects = (() => {
    const byBoard = new Map<string, { boardName: string; mode: DocMode; savedAt: number }>();
    for (const e of listSaves()) {
      const cur = byBoard.get(e.boardName);
      if (!cur || e.savedAt > cur.savedAt) {
        byBoard.set(e.boardName, { boardName: e.boardName, mode: e.mode, savedAt: e.savedAt });
      }
    }
    return [...byBoard.values()].sort((a, b) => b.savedAt - a.savedAt);
     
  })();

  const refreshSaves = () => setSavesVersion((v) => v + 1);
  void savesVersion; // re-render trigger

  // Share links carry ?board= (and optionally &mode=). Join directly when we
  // already know the visitor's name; otherwise prefill the form.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkBoard = sanitizeBoardName(params.get('board') ?? '');
    const linkModeRaw = params.get('mode');
    const linkMode: DocMode | null =
      linkModeRaw === '3d' || linkModeRaw === '2d' || linkModeRaw === 'audio' || linkModeRaw === 'doc' || linkModeRaw === 'code' || linkModeRaw === 'diagram' || linkModeRaw === 'presentation' ? linkModeRaw : null;

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
    // ToS must be accepted — mirrors the sign-up flow's required checkbox.
    if (!room || !tos) return;
    setDisplayName(clean);
    enterBoard({
      name: room,
      mode,
      visibility,
      iAmCreator: !rooms.some((r) => r.name === room),
      joinedAt: Date.now(),
    });
  };

  const canSubmit = sanitizeBoardName(board).length > 0 && tos;

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center p-3 bg-bg overflow-auto sm:p-6">
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none fixed inset-0 opacity-60">
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-accent/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-green/15 blur-3xl" />
      </div>
      <div className="surface relative w-full max-w-md p-5 flex flex-col gap-4 shadow-[0_32px_80px_rgba(0,0,0,0.55),0_0_0_1px_var(--accent-glow),0_0_70px_-12px_var(--accent-glow)] sm:p-8 sm:gap-5">
        {/* Gradient top accent — a thin line that crowns the card. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-lg bg-gradient-to-r from-transparent via-accent/70 to-transparent" aria-hidden />
        <header className="relative flex items-center gap-3">
          <SlateMark size={40} />
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-br from-text to-accent bg-clip-text text-transparent leading-tight">
              Slate
            </h1>
            <p className="text-xs text-text-dim">Real-time whiteboard &amp; 3D editor</p>
          </div>
          <div className="flex-1" />
          {/* Quick donate text link — small, unobtrusive. Hidden on very
              small screens (also reachable from the guest dropdown). */}
          <a
            href="https://buymeacoffee.com/jeffreyscof"
            target="_blank"
            rel="noreferrer noopener"
            className="hidden items-center gap-1 text-[11px] text-text-dim transition-colors hover:text-accent sm:flex"
            title="Support Slate — buy me a coffee"
          >
            <Coffee size={12} />
            <span>Donate</span>
          </a>
          {/* Guest profile dropdown — no account, so no Settings / Sign-in. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account menu"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-border-2 bg-bg-3 text-text-mid transition-colors hover:border-accent/40 hover:text-accent"
              >
                <User size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <div className="px-2.5 py-1.5">
                <p className="text-[10px] font-mono uppercase tracking-wider text-text-dim">
                  Account
                </p>
                <p className="truncate text-xs font-medium text-text">Guest</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
                <Info size={14} /> About
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => window.open('https://buymeacoffee.com/jeffreyscof', '_blank', 'noopener,noreferrer')}
              >
                <Coffee size={14} /> Donate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTermsOpen(true)}>
                <FileText size={14} /> Terms &amp; Privacy
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              onClick={() => setMode(mode === '2d' ? '3d' : mode === '3d' ? 'audio' : mode === 'audio' ? 'doc' : mode === 'doc' ? 'code' : mode === 'code' ? 'diagram' : mode === 'diagram' ? 'presentation' : '2d')}
              onIcon={mode === 'audio' ? <MusicIcon size={15} /> : mode === 'doc' ? <FileText size={15} /> : mode === 'code' ? <BracesIcon size={15} /> : mode === 'diagram' ? <WorkflowIcon size={15} /> : mode === 'presentation' ? <PresentationIcon size={15} /> : <BoxIcon size={15} />}
              offIcon={<PenLine size={15} />}
              onLabel={mode === '3d' ? '3D' : mode === 'audio' ? 'Audio' : mode === 'doc' ? 'Doc' : mode === 'code' ? 'Code' : mode === 'diagram' ? 'Diagram' : 'Slides'}
              offLabel="2D"
            />
          </div>
          {/* Terms of Service acceptance — required to enter the board. Mirrors
              the sign-up flow's checkbox so guests and accounts see the same
              gate. Links to the TermsDialog (already mounted below). */}
          <label className="flex items-start gap-2 text-xs text-text-mid">
            <input
              type="checkbox"
              checked={tos}
              onChange={(e) => setTos(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              I agree to the{' '}
              <button
                type="button"
                onClick={() => setTermsOpen(true)}
                className="text-accent underline-offset-2 hover:underline"
              >
                Terms of Service &amp; Privacy Policy
              </button>
            </span>
          </label>
          <Button type="submit" size="lg" className="mt-2 w-full" disabled={!canSubmit}>
            Enter board
          </Button>
        </form>

        {/* Recent projects + All Projects button */}
        {recents.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="panel-title">Recent</span>
              <button
                type="button"
                onClick={() => setAllProjectsOpen(true)}
                className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-text-dim transition-colors hover:bg-bg-3 hover:text-text"
              >
                <FolderOpen size={11} />
                All ({allProjects.length})
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {recents.map((r) => (
                <li key={r.boardName}>
                  <button
                    type="button"
                    onClick={() => {
                      setDisplayName(sanitizeDisplayName(name) || 'Guest');
                      enterBoard({ name: r.boardName, mode: r.mode, visibility: 'public', iAmCreator: false, joinedAt: Date.now() });
                    }}
                    className={cn(
                      'group relative w-full flex items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 py-1.5 text-sm text-text-mid transition-all hover:-translate-y-px hover:bg-bg-3/70 hover:text-text',
                      modeHoverBorderClass(r.mode),
                    )}
                  >
                    <span className={cn('absolute inset-y-0 left-0 w-0.5', modeGradientClass(r.mode))} aria-hidden />
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 py-0.5 text-[8px] font-mono font-bold uppercase tracking-wider',
                        modeBadgeClass(r.mode),
                      )}
                    >
                      {r.mode}
                    </span>
                    <span className="font-mono truncate flex-1 text-left">{r.boardName}</span>
                    <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-text-dim">
                      <Clock size={9} className="text-text-dim transition-colors group-hover:text-text-mid" />
                      {timeAgo(r.savedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {rooms.length > 0 && (
          <div className="border-t border-border pt-4 max-h-48 overflow-y-auto">
            <div className="mb-2 flex items-center gap-2">
              <span className="panel-title">Live public boards</span>
              <span className="h-1.5 w-1.5 rounded-full bg-green live-pulse" aria-hidden />
            </div>
            <ul className="flex flex-col gap-1">
              {rooms.map((r) => (
                <li key={r.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setBoard(r.name);
                      setMode(r.mode);
                    }}
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm text-text-mid transition-all hover:-translate-y-px hover:bg-bg-3/70 hover:text-text',
                      modeHoverBorderClass(r.mode),
                    )}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green live-pulse" aria-hidden />
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-mono font-bold uppercase tracking-wider',
                        modeBadgeClass(r.mode),
                      )}
                    >
                      {r.mode}
                    </span>
                    <span className="font-mono truncate flex-1 text-left">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-bg-3/70 px-1.5 py-0.5 text-[10px] text-text-mid">
                      <Users size={10} className="text-text-dim" />
                      <span className="font-mono">{r.members}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {/* All Projects dialog */}
      <Dialog open={allProjectsOpen} onOpenChange={setAllProjectsOpen} title="All Projects" description={`${allProjects.length} saved project${allProjects.length === 1 ? '' : 's'}`}>
        <div className="max-h-[50vh] overflow-y-auto">
          {allProjects.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-bg-2/40 p-10 text-center">
              <FolderOpen size={22} className="text-text-dim/60" />
              <p className="text-xs text-text-dim">No saved projects yet.</p>
              <p className="text-[11px] text-text-dim/70">Create one above to get started.</p>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {allProjects.map((r) => (
                <li key={r.boardName} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      setDisplayName(sanitizeDisplayName(name) || 'Guest');
                      enterBoard({ name: r.boardName, mode: r.mode, visibility: 'public', iAmCreator: false, joinedAt: Date.now() });
                      setAllProjectsOpen(false);
                    }}
                    className={cn(
                      'hover-lift flex w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-2 text-left',
                      modeHoverBorderClass(r.mode),
                    )}
                  >
                    <span className={cn('relative grid h-16 place-items-center text-xs font-bold tracking-wider', modeGradientClass(r.mode))}>
                      <span className={cn('font-mono', modeTextClass(r.mode))}>{r.mode.toUpperCase()}</span>
                    </span>
                    <span className="flex flex-col gap-1 p-2.5">
                      <span className="truncate text-xs font-semibold text-text transition-colors group-hover:text-accent">{r.boardName}</span>
                      <span className="flex items-center gap-1 text-[10px] text-text-dim">
                        <Clock size={9} /> {timeAgo(r.savedAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      for (const e of listSaves()) if (e.boardName === r.boardName) deleteSave(e.id);
                      refreshSaves();
                    }}
                    // Visible on mobile (no hover there); desktop reveals it on
                    // hover so the card looks clean by default.
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-bg-2/90 text-text-mid opacity-100 backdrop-blur-sm transition-colors hover:border-danger/50 hover:text-danger sm:opacity-0 sm:group-hover:opacity-100"
                    aria-label="Delete project"
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end pt-3">
          <Button variant="primary" size="sm" onClick={() => setAllProjectsOpen(false)}>Close</Button>
        </div>
      </Dialog>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </div>
  );
}

/** Relative time formatter. */
function timeAgo(t: number): string {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
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
          'flex h-9 w-9 items-center justify-center rounded-md border transition-all',
          active
            ? 'border-accent/70 bg-accent/20 text-accent shadow-[0_0_0_2px_var(--accent-glow)]'
            : 'border-border-2 text-text-mid hover:border-border hover:bg-bg-3 hover:text-text',
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

export function SlateMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
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
