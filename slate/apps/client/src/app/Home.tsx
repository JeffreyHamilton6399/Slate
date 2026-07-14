/**
 * Entry surface — the Photoshop-style start experience.
 *
 *   Accounts configured + signed out → SignIn (magic link).
 *   Accounts configured + signed in  → Home: recent projects (cloud-restored
 *     so they follow you across devices), new-board creation, live boards.
 *   Accounts not configured          → the classic account-less Onboarding.
 */

import { useEffect, useState } from 'react';
import { Clock, Eye, EyeOff, LogOut, Plus, Settings as SettingsIcon, Users, Globe, Lock, Box as BoxIcon, PenLine as PenLineIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input, FieldLabel } from '../ui/Input';
import { cn } from '../utils/cn';
import { sanitizeDisplayName } from '@slate/sync-protocol';
import { useAppStore } from './store';
import { Onboarding, SlateMark, sanitizeBoardName, randomBoardName } from './Onboarding';
import { SettingsDialog } from './Settings';
import { fetchRooms, type PublicRoom } from '../sync/rooms';
import { listSaves } from '../files/snapshot';
import { accountsEnabled, supabase } from '../account/supabase';
import { useAccount } from '../account/useAccount';
import { restoreSavesFromCloud } from '../account/cloudSaves';

export function Entry() {
  const { user, loading } = useAccount();
  if (!accountsEnabled) return <Onboarding />;
  if (loading) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-bg text-xs text-text-dim">
        Checking session…
      </div>
    );
  }
  if (!user) return <SignIn />;
  return <Home email={user.email ?? ''} userId={user.id} />;
}

/** Email + password sign-in / sign-up (display name + ToS on sign-up). */
function SignIn() {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayNameField] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [tos, setTos] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set when a sign-in fails because the email is unconfirmed — enables Resend. */
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const setDisplayName = useAppStore((s) => s.setDisplayName);

  const base = email.includes('@') && password.length >= 6;
  const valid =
    tab === 'signin'
      ? base
      : base && password === confirm && sanitizeDisplayName(displayName).length > 0 && tos;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!supabase || !valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setNeedsConfirm(false);
    // Timeout so a misconfigured / unreachable Supabase never freezes the
    // form on "Working…" forever — the user can retry.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out — check your connection and retry.')), 20000),
    );
    try {
      if (tab === 'signin') {
        const race = await Promise.race([
          supabase.auth.signInWithPassword({ email, password }),
          timeout,
        ]);
        const err = race.error;
        if (err) {
          const unconfirmed = err.message === 'Email not confirmed';
          setNeedsConfirm(unconfirmed);
          setError(
            unconfirmed
              ? 'This account still needs its email confirmed — check your inbox (and spam) for the link, or resend it below.'
              : err.message,
          );
        }
      } else {
        const clean = sanitizeDisplayName(displayName);
        const race = await Promise.race([
          supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin, data: { display_name: clean } },
          }),
          timeout,
        ]);
        const err = race.error;
        if (err) setError(err.message);
        else {
          setDisplayName(clean);
          if (!race.data.session) {
            setNotice(
              `Account created. We sent a confirmation link to ${email} — click it, then sign in here.`,
            );
            setTab('signin');
          }
        }
      }
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please retry.');
    }
    setBusy(false);
  };

  const resendConfirmation = async () => {
    if (!supabase || !email.includes('@')) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (err) setError(err.message);
    else {
      setNeedsConfirm(false);
      setNotice(`Confirmation email re-sent to ${email}. Check your inbox and spam folder.`);
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center p-6 bg-bg overflow-auto">
      <div className="surface w-full max-w-sm p-8 flex flex-col gap-5 shadow-[0_32px_80px_rgba(0,0,0,0.5),0_0_0_1px_var(--accent-glow)]">
        <header className="flex items-center gap-3">
          <SlateMark />
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-br from-text to-accent bg-clip-text text-transparent leading-tight">
              Slate
            </h1>
            <p className="text-xs text-text-dim">Real-time whiteboard &amp; 3D editor</p>
          </div>
        </header>

        <div className="flex rounded-sm bg-bg-3 p-0.5">
          {(
            [
              ['signin', 'Sign in'],
              ['signup', 'Create account'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setTab(v);
                setError(null);
                setNotice(null);
              }}
              className={cn(
                'flex-1 rounded-sm py-1.5 text-xs font-medium',
                tab === v ? 'bg-accent text-white' : 'text-text-dim hover:text-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {tab === 'signup' && (
            <div>
              <FieldLabel>Display name</FieldLabel>
              <Input
                autoFocus
                maxLength={40}
                value={displayName}
                onChange={(e) => setDisplayNameField(e.target.value)}
                placeholder="How collaborators see you"
              />
            </div>
          )}
          <div>
            <FieldLabel>Email</FieldLabel>
            <Input
              autoFocus={tab === 'signin'}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div>
            <FieldLabel>Password</FieldLabel>
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tab === 'signup' ? 'At least 6 characters' : '••••••••'}
                autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
                className="pr-8"
              />
              <button
                type="button"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text"
              >
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          {tab === 'signup' && (
            <>
              <div>
                <FieldLabel>Re-enter password</FieldLabel>
                <Input
                  type={showPw ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Same password again"
                  autoComplete="new-password"
                />
                {confirm.length > 0 && confirm !== password && (
                  <p className="mt-1 text-xs text-danger">Passwords don&apos;t match.</p>
                )}
              </div>
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
            </>
          )}
          <Button type="submit" size="lg" disabled={busy || !valid} className="w-full">
            {busy ? 'Working…' : tab === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
          {error && <p className="text-xs text-danger">{error}</p>}
          {needsConfirm && (
            <button
              type="button"
              onClick={resendConfirmation}
              disabled={busy}
              className="self-start text-xs text-accent underline-offset-2 hover:underline disabled:opacity-50"
            >
              Resend confirmation email
            </button>
          )}
          {notice && <p className="text-xs text-text-mid">{notice}</p>}
        </form>
      </div>
      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </div>
  );
}

/** Placeholder legal terms — swap for real counsel-reviewed text before launch. */
function TermsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Terms of Service & Privacy Policy">
      <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto text-xs text-text-mid">
        <p className="font-medium text-text">Terms of Service</p>
        <p>
          Slate is provided as-is, without warranty of any kind. You are responsible for the
          content you create and share. Boards can be public — do not post anything you do not
          have the right to share. Accounts that abuse the service may be removed.
        </p>
        <p className="font-medium text-text">Privacy</p>
        <p>
          Your email address and password hash are stored with our authentication provider
          (Supabase) solely to operate your account. Board saves you back up are stored under
          your account and are not shared with other users. Live board content is synced with
          the collaborators in the same board. We do not sell your data.
        </p>
        <p>Questions? Contact the board owner or the project maintainer.</p>
      </div>
      <div className="flex justify-end pt-3">
        <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

interface RecentProject {
  boardName: string;
  mode: '2d' | '3d' | 'audio';
  savedAt: number;
}

/** Signed-in home: recents grid + create + live boards. */
function Home({ email, userId }: { email: string; userId: string }) {
  const enterBoard = useAppStore((s) => s.enterBoard);
  const displayName = useAppStore((s) => s.displayName);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const [recents, setRecents] = useState<RecentProject[]>(() => recentsFromSaves());
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [board, setBoard] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [createMode, setCreateMode] = useState<'2d' | '3d' | 'audio'>('2d');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloudNote, setCloudNote] = useState('Syncing projects…');

  // Default the collaboration display name from the account email.
  useEffect(() => {
    if (!displayName) setDisplayName(sanitizeDisplayName(email.split('@')[0] ?? '') || 'Guest');
  }, [displayName, email, setDisplayName]);

  // Pull cloud saves so recents follow the account across devices.
  useEffect(() => {
    let cancelled = false;
    void restoreSavesFromCloud(userId).then((r) => {
      if (cancelled) return;
      setRecents(recentsFromSaves());
      setCloudNote(r.error ? `Cloud sync unavailable: ${r.error}` : '');
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    fetchRooms().then(setRooms).catch(() => setRooms([]));
    // Poll for live board updates (visibility toggles, member counts) so
    // changes made by other users in their boards reflect here without a
    // manual refresh. 10s is infrequent enough to be cheap.
    const interval = setInterval(() => {
      fetchRooms().then(setRooms).catch(() => {});
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Honor share links (?board=…&mode=…) by joining straight away. Whether
  // we're the creator matters: creators bootstrap the first layer + meta.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkBoard = sanitizeBoardName(params.get('board') ?? '');
    if (!linkBoard) return;
    const linkMode = params.get('mode') === '3d' ? '3d' : '2d';
    window.history.replaceState(null, '', window.location.pathname);
    const join = (creator: boolean) =>
      enterBoard({
        name: linkBoard,
        mode: linkMode,
        visibility: 'public',
        iAmCreator: creator,
        joinedAt: Date.now(),
      });
    fetchRooms()
      .then((rs) => join(!rs.some((r) => r.name === linkBoard)))
      .catch(() => join(true));
  }, [enterBoard]);

  const open = (name: string, m: '2d' | '3d' | 'audio', creator: boolean) =>
    enterBoard({ name, mode: m, visibility, iAmCreator: creator, joinedAt: Date.now() });

  const create = (m: '2d' | '3d' | 'audio') => {
    const room = sanitizeBoardName(board) || randomBoardName();
    open(room, m, !rooms.some((r) => r.name === room));
  };

  const greeting = displayName || (email.split('@')[0] ?? 'there');

  return (
    <div className="fixed inset-0 overflow-auto bg-bg">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-10 px-6 py-8 sm:px-10">
        {/* Header */}
        <header className="flex items-center gap-3">
          <SlateMark />
          <span className="text-lg font-semibold tracking-tight">Slate</span>
          <div className="flex-1" />
          <span className="hidden text-xs text-text-dim sm:inline">{email}</span>
          <Button variant="icon" size="none" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon size={16} />
          </Button>
          <Button variant="icon" size="none" aria-label="Sign out" onClick={() => void supabase?.auth.signOut()}>
            <LogOut size={16} />
          </Button>
        </header>

        {/* Hero + create cards */}
        <section className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Welcome back, <span className="text-accent">{greeting}</span>
            </h1>
            <p className="mt-1 text-sm text-text-dim">Start something new or pick up where you left off.</p>
          </div>
          <div className="flex flex-col gap-3">
            {/* Compressed create bar: name (capped, required) + icon toggles +
                Create button. Compact single-row layout. */}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                maxLength={80}
                value={board}
                onChange={(e) => setBoard(e.target.value)}
                placeholder="Project name"
                className="min-w-0 max-w-xs flex-1"
              />
              <IconToggle
                active={visibility === 'public'}
                onClick={() => setVisibility(visibility === 'public' ? 'private' : 'public')}
                onIcon={<Globe size={15} />}
                offIcon={<Lock size={15} />}
                onLabel="Public"
                offLabel="Private"
              />
              <IconToggle
                active={createMode !== '2d'}
                onClick={() => setCreateMode(createMode === '2d' ? '3d' : createMode === '3d' ? 'audio' : '2d')}
                onIcon={<BoxIcon size={15} />}
                offIcon={<PenLineIcon size={15} />}
                onLabel={createMode === '3d' ? '3D scene' : 'Audio'}
                offLabel="2D whiteboard"
              />
              <Button variant="primary" size="md" onClick={() => create(createMode)} disabled={!board.trim()}>
                <Plus size={14} />
                <span className="ml-1.5">Create</span>
              </Button>
            </div>
          </div>
        </section>

        {/* Recent projects */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-text">Recent projects</h2>
            {cloudNote && <span className="text-[11px] text-text-dim">{cloudNote}</span>}
          </div>
          {recents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-text-dim">
              Nothing yet — create your first board above. Projects follow you on every device you
              sign in to.
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {recents.map((r) => (
                <li key={r.boardName}>
                  <button
                    type="button"
                    onClick={() => open(r.boardName, r.mode, false)}
                    className="group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-2 text-left transition-colors hover:border-accent/50"
                  >
                    <span
                      className={cn(
                        'grid h-20 w-full place-items-center text-sm font-bold tracking-wider',
                        r.mode === '3d' ? 'bg-accent/10 text-accent' : 'bg-green/10 text-green',
                      )}
                    >
                      {r.mode.toUpperCase()}
                    </span>
                    <span className="flex flex-col gap-0.5 p-2.5">
                      <span className="truncate text-sm font-medium text-text group-hover:text-accent">
                        {r.boardName}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-text-dim">
                        <Clock size={10} /> {timeAgo(r.savedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Live public boards */}
        {rooms.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-text">Live public boards</h2>
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {rooms.map((r) => (
                <li key={r.name}>
                  <button
                    type="button"
                    onClick={() => open(r.name, r.mode, false)}
                    className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-2 px-3 py-2 text-sm text-text-mid transition-colors hover:border-accent/40 hover:text-text"
                  >
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider',
                        r.mode === '3d' ? 'bg-accent/15 text-accent' : 'bg-green/15 text-green',
                      )}
                    >
                      {r.mode}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{r.name}</span>
                    <Users size={12} className="text-text-dim" />
                    <span className="font-mono text-xs">{r.members}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

/** Single-icon toggle: shows one icon when active, another when not. */
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
    <button
      type="button"
      title={active ? onLabel : offLabel}
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? onLabel : offLabel}
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border transition-colors',
        active
          ? 'border-accent/60 bg-accent/15 text-accent'
          : 'border-border text-text-mid hover:bg-bg-3 hover:text-text',
      )}
    >
      {active ? onIcon : offIcon}
    </button>
  );
}

/** Latest save per board, newest first. */
function recentsFromSaves(): RecentProject[] {
  const byBoard = new Map<string, RecentProject>();
  for (const e of listSaves()) {
    const cur = byBoard.get(e.boardName);
    if (!cur || e.savedAt > cur.savedAt) {
      byBoard.set(e.boardName, { boardName: e.boardName, mode: e.mode, savedAt: e.savedAt });
    }
  }
  return [...byBoard.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, 12);
}

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
