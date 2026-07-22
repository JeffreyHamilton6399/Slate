/**
 * Entry surface — the Photoshop-style start experience.
 *
 *   Accounts configured + signed out → SignIn (magic link).
 *   Accounts configured + signed in  → Home: recent projects (cloud-restored
 *     so they follow you across devices), new-board creation, live boards.
 *   Accounts not configured          → the classic account-less Onboarding.
 */

import { useEffect, useState } from 'react';
import { Clock, Eye, EyeOff, LogOut, Plus, Users, Globe, Lock, Box as BoxIcon, PenLine as PenLineIcon, Music as MusicIcon, FileText as FileTextIcon, Braces as BracesIcon, Workflow as WorkflowIcon, Presentation as PresentationIcon, Trash2, FolderOpen, ChevronRight, UserCircle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input, FieldLabel } from '../ui/Input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/DropdownMenu';
import { cn } from '../utils/cn';
import { sanitizeDisplayName, type DocMode } from '@slate/sync-protocol';
import { useAppStore } from './store';
import { Onboarding, SlateMark, sanitizeBoardName, randomBoardName } from './Onboarding';
import { Avatar } from './Avatar';
import { ProfileDialog, type ProfileTab } from './ProfileDialog';
import { AboutDialog } from './AboutDialog';
import { TermsDialog } from './TermsDialog';
import { fetchRooms, type PublicRoom } from '../sync/rooms';
import { listSaves, deleteSave } from '../files/snapshot';
import { accountsEnabled, supabase } from '../account/supabase';
import { useAccount } from '../account/useAccount';
import { restoreSavesFromCloud } from '../account/cloudSaves';
import { ensureMyProfile, fetchMyProfile } from '../account/friends';
import { useFriends } from '../account/useFriends';
import { modeBadgeClass, modeGradientClass, modeHoverBorderClass, modeTextClass } from './modeColors';

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
            // ^ On Vercel, window.location.origin is the production URL (e.g.
            //   https://slate-client.vercel.app). The Supabase dashboard must
            //   have this URL in Authentication → URL Configuration → Redirect URLs.
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
      // ^ Same as signUp — Supabase dashboard must allow this URL in Redirect URLs.
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
/* TermsDialog moved to ./TermsDialog.tsx — shared with Home + Onboarding profile menus. */

interface RecentProject {
  boardName: string;
  mode: DocMode;
  savedAt: number;
}

/** Signed-in home: recents grid + create + live boards. */
function Home({ email, userId }: { email: string; userId: string }) {
  const enterBoard = useAppStore((s) => s.enterBoard);
  const displayName = useAppStore((s) => s.displayName);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const [recents, setRecents] = useState<RecentProject[]>(() => recentsFromSaves());
  const [allProjects, setAllProjects] = useState<RecentProject[]>(() => allProjectsFromSaves());
  const [allProjectsOpen, setAllProjectsOpen] = useState(false);
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [board, setBoard] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [createMode, setCreateMode] = useState<DocMode>('2d');
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTab, setProfileTab] = useState<ProfileTab>('profile');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [cloudNote, setCloudNote] = useState('Syncing projects…');

  // Social: friends (for the online section + request badge) and incoming
  // board invites (notifications + a join banner).
  // Friend-request badge on the avatar. Board invites are shown as their own
  // bottom-right notification (BoardInviteNotifications, mounted app-wide).
  const { incomingCount } = useFriends(userId);
  const notifCount = incomingCount;

  /** Refresh both the recents widget + the All Projects dialog list. */
  const refreshSaves = () => {
    setRecents(recentsFromSaves());
    setAllProjects(allProjectsFromSaves());
  };

  // Default the collaboration display name from the account email.
  useEffect(() => {
    if (!displayName) setDisplayName(sanitizeDisplayName(email.split('@')[0] ?? '') || 'Guest');
  }, [displayName, email, setDisplayName]);

  // Pull cloud saves so recents follow the account across devices.
  useEffect(() => {
    let cancelled = false;
    void restoreSavesFromCloud(userId).then((r) => {
      if (cancelled) return;
      refreshSaves();
      setCloudNote(r.error ? `Cloud sync unavailable: ${r.error}` : '');
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Make sure this account has a profiles row on sign-in so FRIENDS can find
  // us by email — otherwise a user who never opened Profile to save a name is
  // invisible to "add friend by email".
  useEffect(() => {
    if (!userId) return;
    void ensureMyProfile(userId, email, useAppStore.getState().displayName);
  }, [userId, email]);

  // Cross-device display-name sync: pull the cloud profile on sign-in and
  // OVERWRITE the local store with the cloud values. The cloud is the source
  // of truth — when a user changes their name on device A, device B picks it
  // up the next time they sign in. (Previously the local store only took the
  // cloud value when empty, so a device that had a stale localStorage name
  // never picked up the change.) Empty cloud values keep the local value.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void fetchMyProfile(userId).then((prof) => {
      if (cancelled || !prof) return;
      const s = useAppStore.getState();
      if (prof.displayName) s.setDisplayName(prof.displayName);
      if (prof.avatarUrl) s.setAvatarUrl(prof.avatarUrl);
      if (prof.bio) s.setBio(prof.bio);
      if (prof.status) s.setStatusText(prof.status);
      if (prof.bannerColor) s.setBannerColor(prof.bannerColor);
    });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    fetchRooms().then(setRooms).catch(() => setRooms([]));
    // Poll for live board updates (visibility toggles, member counts) so
    // changes made by other users in their boards reflect here without a
    // manual refresh. 5s keeps the list feeling live.
    const interval = setInterval(() => {
      fetchRooms().then(setRooms).catch(() => {});
    }, 5_000);
    return () => clearInterval(interval);
  }, []);

  // Honor share links (?board=…&mode=…) by joining straight away. Whether
  // we're the creator matters: creators bootstrap the first layer + meta.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkBoard = sanitizeBoardName(params.get('board') ?? '');
    if (!linkBoard) return;
    const rawMode = params.get('mode');
    const linkMode: DocMode | null =
      rawMode === '3d' || rawMode === '2d' || rawMode === 'audio' || rawMode === 'doc' || rawMode === 'code' || rawMode === 'diagram' || rawMode === 'presentation' ? rawMode : null;
    window.history.replaceState(null, '', window.location.pathname);
    const join = (creator: boolean, mode: DocMode) =>
      enterBoard({
        name: linkBoard,
        mode,
        visibility: 'public',
        iAmCreator: creator,
        joinedAt: Date.now(),
      });
    fetchRooms()
      .then((rs) => {
        const found = rs.find((r) => r.name === linkBoard);
        join(!found, linkMode ?? found?.mode ?? '2d');
      })
      .catch(() => join(true, linkMode ?? '2d'));
  }, [enterBoard]);

  const open = (name: string, m: DocMode, creator: boolean) =>
    enterBoard({ name, mode: m, visibility, iAmCreator: creator, joinedAt: Date.now() });

  const create = (m: DocMode) => {
    const room = sanitizeBoardName(board) || randomBoardName();
    open(room, m, !rooms.some((r) => r.name === room));
  };

  const greeting = displayName || (email.split('@')[0] ?? 'there');

  // Live public boards: only public boards with at least one member. Private
  // boards and empty rooms disappear from the discovery list.
  const liveRooms = rooms.filter((r) => r.visibility === 'public' && r.members > 0);

  return (
    <div className="fixed inset-0 overflow-auto bg-bg">
      {/* Ambient page backdrop — two soft, fixed accent glows so the dark
          canvas feels layered instead of flat. Pointer-events-none so it
          never blocks clicks; low opacity keeps it subtle on every screen. */}
      <div className="pointer-events-none fixed inset-0 opacity-50" aria-hidden>
        <div className="absolute -top-40 left-[15%] h-96 w-96 rounded-full bg-accent/12 blur-3xl" />
        <div className="absolute top-1/3 -right-40 h-[28rem] w-[28rem] rounded-full bg-green/10 blur-3xl" />
      </div>
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col gap-10 px-6 py-8 sm:px-10">
        {/* Header */}
        <header className="flex items-center gap-3">
          <SlateMark />
          <span className="text-lg font-semibold tracking-tight">Slate</span>
          <div className="flex-1" />
          <ProfileMenu
            email={email}
            notifCount={notifCount}
            onOpenProfile={() => { setProfileTab('profile'); setProfileOpen(true); }}
          />
        </header>

        {/* Hero + create cards — fades + slides in on mount (.hero-rise) so
            the first paint feels alive without being flashy. */}
        <section className="hero-rise relative flex flex-col gap-5">
          {/* Local ambient glow behind the heading — sits above the page
              backdrop, below the content (relative children stack on top). */}
          <div className="pointer-events-none absolute -top-12 left-0 h-44 w-2/3 rounded-full bg-accent/15 blur-3xl" aria-hidden />
          <div className="pointer-events-none absolute -top-6 right-8 h-32 w-1/2 rounded-full bg-green/10 blur-3xl" aria-hidden />
          <div className="relative flex items-end justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Welcome back,{' '}
                <span className="bg-gradient-to-br from-accent to-accent-2 bg-clip-text text-transparent">
                  {greeting}
                </span>
              </h1>
              <p className="mt-1.5 text-sm text-text-dim">Start something new or pick up where you left off.</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setAllProjects(allProjectsFromSaves()); setAllProjectsOpen(true); }}
              className="shrink-0 gap-1.5 rounded-md text-text-mid hover:border-accent/50 hover:text-text"
              title="Browse all saved projects"
            >
              <FolderOpen size={14} />
              <span className="hidden sm:inline">All Projects</span>
              <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] font-mono font-bold text-accent">
                {allProjects.length}
              </span>
            </Button>
          </div>
          {/* Create bar (left) + Recent widget (right) — side by side on lg so
              the widget sits in the bottom-right corner of the hero without
              overlapping the create controls. Stacks vertically on mobile. */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-1 flex-col gap-2">
              {/* Premium create bar — a single rounded surface that holds the
                  name input + toggles + Create button. The input blends in
                  (transparent border) and the whole bar highlights on focus. */}
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border-2 bg-bg-2/70 p-1.5 shadow-[0_4px_24px_rgba(0,0,0,0.28)] backdrop-blur-sm transition-colors focus-within:border-accent/50">
                <Input
                  maxLength={80}
                  value={board}
                  onChange={(e) => setBoard(e.target.value)}
                  placeholder="Name your project…"
                  className="min-w-0 max-w-xs flex-1 border-transparent bg-bg-3/70 shadow-none focus:border-transparent focus:shadow-none"
                />
                <span className="mx-0.5 hidden h-5 w-px bg-border-2 sm:block" aria-hidden />
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
                  onClick={() => setCreateMode(createMode === '2d' ? '3d' : createMode === '3d' ? 'audio' : createMode === 'audio' ? 'doc' : createMode === 'doc' ? 'code' : createMode === 'code' ? 'diagram' : createMode === 'diagram' ? 'presentation' : '2d')}
                  onIcon={createMode === 'audio' ? <MusicIcon size={15} /> : createMode === 'doc' ? <FileTextIcon size={15} /> : createMode === 'code' ? <BracesIcon size={15} /> : createMode === 'diagram' ? <WorkflowIcon size={15} /> : createMode === 'presentation' ? <PresentationIcon size={15} /> : <BoxIcon size={15} />}
                  offIcon={<PenLineIcon size={15} />}
                  onLabel={createMode === '3d' ? '3D scene' : createMode === 'audio' ? 'Audio' : createMode === 'doc' ? 'Doc' : createMode === 'code' ? 'Code' : createMode === 'diagram' ? 'Diagram' : 'Presentation'}
                  offLabel="2D whiteboard"
                />
                <Button variant="primary" size="md" onClick={() => create(createMode)} disabled={!board.trim()} className="ml-0.5">
                  <Plus size={14} />
                  <span className="ml-1.5">Create</span>
                </Button>
              </div>
              {cloudNote && <span className="text-[11px] text-text-dim">{cloudNote}</span>}
            </div>

            {/* Recent widget — compact floating panel in the bottom-right of
                the hero on lg+. Each entry is a mini-card with a gradient
                mode accent on the left edge, a colored mode pill, and a
                time-ago. Hover lifts the row + tints its border to the mode. */}
            {recents.length > 0 && (
              <div className="w-full max-w-xs self-end lg:w-80">
                <div className="rounded-lg border border-border bg-bg-2/80 p-2 shadow-[0_4px_20px_rgba(0,0,0,0.25)] backdrop-blur-sm">
                  <div className="mb-1.5 flex items-center justify-between px-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-text-dim">Recent</span>
                    <button
                      type="button"
                      onClick={() => { setAllProjects(allProjectsFromSaves()); setAllProjectsOpen(true); }}
                      className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent/10"
                    >
                      View all <ChevronRight size={10} />
                    </button>
                  </div>
                  <ul className="flex flex-col gap-1">
                    {recents.map((r) => (
                      <li key={r.boardName}>
                        <button
                          type="button"
                          onClick={() => open(r.boardName, r.mode, false)}
                          className={cn(
                            'group relative flex w-full items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 py-1.5 text-left transition-all hover:-translate-y-px hover:bg-bg-3/70',
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
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{r.boardName}</span>
                          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-text-dim">
                            <Clock size={9} className="text-text-dim transition-colors group-hover:text-text-mid" />
                            {timeAgo(r.savedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Live public boards — staggered rise so it cascades in after the
            hero. Each row lifts on hover + tints its border to the mode color;
            a breathing green dot signals the board is genuinely live. */}
        <section className="stagger-rise" style={{ animationDelay: '120ms' }}>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text">Live public boards</h2>
            <span className="h-1.5 w-1.5 rounded-full bg-green live-pulse" aria-hidden />
          </div>
          {liveRooms.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-bg-2/40 px-4 py-6 text-center">
              <p className="text-xs text-text-dim">No public boards are live right now.</p>
              <p className="mt-1 text-[11px] text-text-dim/70">Create one (set it Public) and share the link, or check back later.</p>
            </div>
          ) : (
            <ul className="grid max-h-[28vh] grid-cols-1 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
              {liveRooms.map((r) => (
                <li key={r.name}>
                  <button
                    type="button"
                    onClick={() => open(r.name, r.mode, false)}
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-md border border-border bg-bg-2 px-2.5 py-1.5 text-left text-sm text-text-mid transition-all hover:bg-bg-3/60 hover:text-text',
                      modeHoverBorderClass(r.mode),
                    )}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green live-pulse" aria-hidden />
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider',
                        modeBadgeClass(r.mode),
                      )}
                    >
                      {r.mode}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-text-dim">
                      <Users size={10} />
                      <span className="font-mono">{r.members}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Footer — subtle gradient rule above an elegant version line + an
            About pill (the About dialog holds feedback, donate, and Terms). */}
        <footer className="mt-auto flex flex-col items-center gap-3 pt-6 text-[11px] text-text-dim">
          <div className="h-px w-full max-w-md bg-gradient-to-r from-transparent via-border-2 to-transparent" aria-hidden />
          <div className="flex items-center gap-2">
            <span className="text-text-dim/80">V1</span>
            <span className="text-text-dim/40">·</span>
            <span className="text-text-dim/80">Jeffrey Hamilton</span>
            <span className="text-text-dim/40">·</span>
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              className="rounded-full border border-border-2 bg-bg-2/60 px-2.5 py-0.5 text-[10px] font-medium text-text-mid transition-colors hover:border-accent/50 hover:text-accent"
              title="About Slate"
            >
              About
            </button>
          </div>
        </footer>
      </div>
      <ProfileDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        initialTab={profileTab}
      />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <AllProjectsDialog
        open={allProjectsOpen}
        onOpenChange={setAllProjectsOpen}
        projects={allProjects}
        onOpen={(name, mode) => { open(name, mode, false); setAllProjectsOpen(false); }}
        onDelete={(name) => {
          if (!window.confirm(`Delete saved project "${name}"? This removes the local + cloud saves, not the live board itself.`)) return;
          deleteSaveByBoardName(name);
          refreshSaves();
        }}
      />
    </div>
  );
}

/** Modal showing ALL saved projects in a grid with delete buttons. */
function AllProjectsDialog({ open, onOpenChange, projects, onOpen, onDelete }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projects: RecentProject[];
  onOpen: (name: string, mode: DocMode) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="All Projects" description={`${projects.length} saved project${projects.length === 1 ? '' : 's'}`}>
      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-bg-2/40 p-10 text-center">
          <FolderOpen size={22} className="text-text-dim/60" />
          <p className="text-xs text-text-dim">Nothing yet — create your first board on the home screen.</p>
          <p className="text-[11px] text-text-dim/70">Projects follow you on every device you sign in to.</p>
        </div>
      ) : (
        <ul className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
          {projects.map((r) => (
            <li key={r.boardName} className="group relative">
              <button
                type="button"
                onClick={() => onOpen(r.boardName, r.mode)}
                className={cn(
                  'hover-lift flex w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-2 text-left',
                  modeHoverBorderClass(r.mode),
                )}
              >
                <span
                  className={cn(
                    'relative grid h-16 w-full place-items-center text-xs font-bold tracking-wider',
                    modeGradientClass(r.mode),
                  )}
                >
                  <span className={cn('font-mono', modeTextClass(r.mode))}>{r.mode.toUpperCase()}</span>
                </span>
                <span className="flex flex-col gap-1 p-2.5">
                  <span className="truncate text-xs font-semibold text-text transition-colors group-hover:text-accent">
                    {r.boardName}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-text-dim">
                    <Clock size={9} /> {timeAgo(r.savedAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(r.boardName)}
                // Visible on mobile (no hover there); desktop reveals it on
                // hover so the card looks clean by default.
                className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-bg-2/90 text-text-mid opacity-100 backdrop-blur-sm transition-colors hover:border-danger/50 hover:text-danger sm:opacity-0 sm:group-hover:opacity-100"
                aria-label={`Delete project ${r.boardName}`}
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end pt-3">
        <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

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
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-all',
        active
          ? 'border-accent/70 bg-accent/20 text-accent shadow-[0_0_0_2px_var(--accent-glow)]'
          : 'border-border-2 text-text-mid hover:border-border hover:bg-bg-3 hover:text-text',
      )}
    >
      {active ? onIcon : offIcon}
    </button>
  );
}

/** Latest save per board, newest first — capped to the 3 most recent for the
 *  compact Recent widget in the hero corner. */
function recentsFromSaves(): RecentProject[] {
  return allProjectsFromSaves().slice(0, 3);
}

/** Latest save per board, newest first — NO cap. Used by the All Projects
 *  dialog so the user can browse every saved project. */
function allProjectsFromSaves(): RecentProject[] {
  const byBoard = new Map<string, RecentProject>();
  for (const e of listSaves()) {
    const cur = byBoard.get(e.boardName);
    if (!cur || e.savedAt > cur.savedAt) {
      byBoard.set(e.boardName, { boardName: e.boardName, mode: e.mode, savedAt: e.savedAt });
    }
  }
  return [...byBoard.values()].sort((a, b) => b.savedAt - a.savedAt);
}

/** Delete all saves for a board name. */
function deleteSaveByBoardName(boardName: string): void {
  for (const e of listSaves()) {
    if (e.boardName === boardName) deleteSave(e.id);
  }
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

/**
 * Circular avatar button in the top-right of the Home header. The dropdown is
 * intentionally minimal — Profile opens the tabbed Profile screen (which holds
 * Friends, Settings, and Account). The notification badge on the avatar
 * itself surfaces incoming friend requests; tapping the avatar → Profile →
 * Friends tab is the path to act on them. Donate is reachable via the footer
 * About link. Closes on outside-click / item-select / Esc — handled by Radix.
 */
function ProfileMenu({
  email,
  notifCount,
  onOpenProfile,
}: {
  email: string;
  notifCount: number;
  onOpenProfile: () => void;
}) {
  const displayName = useAppStore((s) => s.displayName);
  const avatarUrl = useAppStore((s) => s.avatarUrl);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={notifCount > 0 ? `Account menu — ${notifCount} notifications` : 'Account menu'}
          className="relative flex rounded-full p-0.5 ring-2 ring-accent/60 shadow-[0_0_18px_var(--accent-glow)] transition-all hover:ring-accent hover:shadow-[0_0_26px_var(--accent-glow)]"
          title="Account"
        >
          <Avatar url={avatarUrl} name={displayName || email} size={38} />
          {notifCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white ring-2 ring-bg">
              {notifCount > 9 ? '9+' : notifCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <div className="px-2.5 py-1.5">
          <p className="text-[10px] font-mono uppercase tracking-wider text-text-dim">
            Signed in as
          </p>
          <p className="truncate text-xs font-medium text-text" title={email || 'Guest'}>
            {email || 'Guest'}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenProfile}>
          <UserCircle size={14} /> Profile
          {notifCount > 0 && (
            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
              {notifCount > 9 ? '9+' : notifCount}
            </span>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={() => void supabase?.auth.signOut()}
        >
          <LogOut size={14} /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
