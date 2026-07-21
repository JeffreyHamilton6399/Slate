/**
 * Profile screen — a real full-size screen (not a scrolling column) with a
 * left tab rail: Profile · Friends · Settings. Everything account-shaped lives
 * here, so the Home avatar dropdown no longer needs Friends / Settings / Terms
 * entries — they're tabs in here.
 *
 *   Profile  — avatar + email, display name, cloud backup / restore / sign out
 *   Friends  — add by email, pending requests, accepted friends
 *   Settings — appearance (theme/accent), voice, 3D viewport, layout reset
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Check,
  CloudDownload,
  CloudUpload,
  LogOut,
  Moon,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  User as UserIcon,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input, FieldLabel } from '../ui/Input';
import { useAppStore, type Theme } from './store';
import { accountsEnabled, supabase } from '../account/supabase';
import { useAccount } from '../account/useAccount';
import { useFriends } from '../account/useFriends';
import { upsertMyProfile, fetchMyProfile, fetchUserProfile, type Friend } from '../account/friends';
import { backupSavesToCloud, restoreSavesFromCloud } from '../account/cloudSaves';
import { listSaves } from '../files/snapshot';
import { useDockStore } from '../workspace/dockStore';
import { useVoiceOptional } from '../voice/useVoiceOptional';
import { toast } from '../ui/Toast';
import { Avatar } from './Avatar';
import { AvatarCropper } from './AvatarCropper';

export type ProfileTab = 'profile' | 'friends' | 'settings';

/**
 * Strip emoji / pictographic characters from a status string. The status field
 * is plain-text only — friends see a short, scannable line next to the name, so
 * a leading emoji (or any emoji) just adds noise. This runs on save AND on
 * display so already-stored emoji-prefixed statuses are cleaned up too.
 */
function stripEmoji(s: string | null | undefined): string {
  if (!s) return '';
  // Strip emoji / pictographs so the status is plain text only. Friends see a
  // short scannable line next to the name, so a leading emoji (or any emoji)
  // just adds noise. This runs on save AND on display so already-stored
  // emoji-prefixed statuses are cleaned up too.
  //
  // We run each character class separately because eslint's
  // no-misleading-character-class rule flags ranges mixed with lone combining
  // marks (variation selector, ZWJ, keycap) in the same class — they need to
  // be applied in their own pass to actually strip the combining sequence.
  return s
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\u{FE0F}/gu, '')
    .replace(/\u{200D}/gu, '')
    .replace(/\u{20E3}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which tab to show when opened. */
  initialTab?: ProfileTab;
}

const TABS: { id: ProfileTab; label: string; Icon: typeof UserIcon }[] = [
  { id: 'profile', label: 'Profile', Icon: UserIcon },
  { id: 'friends', label: 'Friends', Icon: Users },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
];

export function ProfileDialog({ open, onOpenChange, initialTab = 'profile' }: ProfileDialogProps) {
  const displayName = useAppStore((s) => s.displayName);
  const avatarUrl = useAppStore((s) => s.avatarUrl);
  const setAvatarUrl = useAppStore((s) => s.setAvatarUrl);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const { user } = useAccount();
  const email = user?.email ?? '';

  // Jump to the requested tab each time the screen opens.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  // On open, pull the profile synced from another device (if the local store
  // hasn't got the fields yet). Keeps the pic/bio/status following the account.
  // The cloud is the source of truth — always overwrite local with cloud when
  // the cloud has a value, so changes made on another device show up here too.
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    void fetchMyProfile(user.id).then((prof) => {
      if (cancelled || !prof) return;
      const s = useAppStore.getState();
      if (prof.displayName) setDisplayName(prof.displayName);
      if (prof.avatarUrl) setAvatarUrl(prof.avatarUrl);
      if (prof.bio) s.setBio(prof.bio);
      if (prof.status) s.setStatusText(prof.status);
      if (prof.bannerColor) s.setBannerColor(prof.bannerColor);
    });
    return () => { cancelled = true; };
  }, [open, user?.id, setAvatarUrl, setDisplayName]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-5xl w-[95vw] p-0"
    >
      <div className="flex max-h-[85vh] min-h-[300px] flex-col sm:flex-row">
        {/* Tab rail — horizontal scroll strip on mobile so the three tabs
            always fit (even on a 320px screen), and a left rail on sm+. */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-56 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3">
          <div className="mb-2 hidden items-center gap-2 px-1.5 sm:flex">
            <Avatar url={avatarUrl} name={displayName || email} size={38} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text">{displayName || 'Anonymous'}</p>
              <p className="truncate text-[11px] text-text-dim" title={email}>{email || 'Not signed in'}</p>
            </div>
          </div>
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id}
              className={
                'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ' +
                (tab === id
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-mid hover:bg-bg-3 hover:text-text')
              }
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {tab === 'profile' && <ProfileTabView />}
          {tab === 'friends' && (
            <section>
              <h3 className="mb-4 text-lg font-semibold text-text">Friends</h3>
              <FriendsSection userId={user?.id} />
            </section>
          )}
          {tab === 'settings' && <SettingsTabView />}
        </div>
      </div>
    </Dialog>
  );
}

const BANNER_COLORS = ['#7c6aff', '#38bdf8', '#22d3a5', '#fbbf24', '#f472b6', '#f87171', '#64748b'];

/** Profile tab — a social-style profile card: banner, big avatar, status line,
 *  bio, stats, then the account plumbing (cloud backup, sign out). */
function ProfileTabView() {
  const displayName = useAppStore((s) => s.displayName);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const avatarUrl = useAppStore((s) => s.avatarUrl);
  const setAvatarUrl = useAppStore((s) => s.setAvatarUrl);
  const bio = useAppStore((s) => s.bio);
  const setBio = useAppStore((s) => s.setBio);
  const statusText = useAppStore((s) => s.statusText);
  const setStatusText = useAppStore((s) => s.setStatusText);
  const bannerColor = useAppStore((s) => s.bannerColor);
  const setBannerColor = useAppStore((s) => s.setBannerColor);
  const { user } = useAccount();
  const email = user?.email ?? '';
  const userId = user?.id;
  const { friends } = useFriends(userId);
  const [name, setName] = useState(displayName);
  const [bioDraft, setBioDraft] = useState(bio);
  const [statusDraft, setStatusDraft] = useState(statusText);
  useEffect(() => setName(displayName), [displayName]);
  useEffect(() => setBioDraft(bio), [bio]);
  useEffect(() => setStatusDraft(statusText), [statusText]);

  const boardsCount = useMemo(() => listSaves().length, []);
  const memberSince = useMemo(() => {
    const t = user?.created_at ? Date.parse(user.created_at) : NaN;
    if (!Number.isFinite(t)) return null;
    return new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [user?.created_at]);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  const onPickFile = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast({ title: 'Pick an image file', variant: 'error' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result as string);
    reader.readAsDataURL(file);
  };

  /** Push the full local profile to the cloud row (partial-safe). */
  const syncProfile = (patch?: { avatar?: string | null; bio?: string; status?: string; bannerColor?: string }) => {
    if (!userId) return;
    const s = useAppStore.getState();
    void upsertMyProfile(userId, s.displayName || name, email, patch?.avatar, {
      bio: patch?.bio ?? s.bio,
      status: patch?.status ?? s.statusText,
      bannerColor: patch?.bannerColor ?? s.bannerColor,
    });
  };

  const saveAvatar = (dataUrl: string | null) => {
    setAvatarUrl(dataUrl ?? '');
    syncProfile({ avatar: dataUrl ?? null });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Profile card: banner + avatar + identity ── */}
      <div className="overflow-hidden rounded-xl border border-border bg-bg-2">
        {/* Banner (choose a color on hover). */}
        <div
          className="group/banner relative h-24"
          style={{ background: `linear-gradient(135deg, ${bannerColor} 0%, ${bannerColor}55 70%, transparent 130%)` }}
        >
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/35 px-2 py-1 opacity-0 backdrop-blur transition-opacity group-hover/banner:opacity-100">
            {BANNER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Banner color ${c}`}
                onClick={() => { setBannerColor(c); syncProfile({ bannerColor: c }); }}
                className={
                  'h-4 w-4 rounded-full border transition-transform hover:scale-110 ' +
                  (bannerColor.toLowerCase() === c ? 'border-white' : 'border-white/30')
                }
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="px-5 pb-4">
          {/* Avatar overlaps the banner like every social profile. */}
          <div className="-mt-10 mb-2 flex items-end justify-between">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="group relative flex shrink-0 rounded-full"
              title="Change photo"
              aria-label="Change profile photo"
            >
              <Avatar url={avatarUrl} name={displayName || email} size={88} className="ring-4 ring-bg-2" />
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <Camera size={20} className="text-white" />
              </span>
            </button>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
                <Camera size={13} />
                <span className="ml-1.5">{avatarUrl ? 'Change photo' : 'Upload photo'}</span>
              </Button>
              {avatarUrl && (
                <Button variant="ghost" size="sm" onClick={() => saveAvatar(null)} aria-label="Remove photo">
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <p className="truncate text-xl font-bold text-text">{displayName || 'Anonymous'}</p>
          {stripEmoji(statusText) && <p className="mt-0.5 truncate text-sm text-text-mid">{stripEmoji(statusText)}</p>}
          <p className="mt-0.5 truncate text-xs text-text-dim" title={email}>
            {email || 'Not signed in'}
          </p>
          {bio && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-mid">{bio}</p>}
          {/* Stats row. */}
          <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3 text-xs text-text-dim">
            <span>
              <span className="font-semibold text-text">{friends.length}</span> friend{friends.length === 1 ? '' : 's'}
            </span>
            <span>
              <span className="font-semibold text-text">{boardsCount}</span> saved board{boardsCount === 1 ? '' : 's'}
            </span>
            {memberSince && <span>Member since <span className="font-semibold text-text">{memberSince}</span></span>}
          </div>
        </div>
      </div>

      {/* ── Edit fields ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel>Display name</FieldLabel>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Your name" />
            <Button
              size="sm"
              onClick={() => {
                setDisplayName(name);
                if (userId) void upsertMyProfile(userId, name, email, useAppStore.getState().avatarUrl || null);
                toast({ title: 'Display name updated' });
              }}
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-xs text-text-dim">How collaborators and friends see you.</p>
        </div>
        <div>
          <FieldLabel>Status</FieldLabel>
          <div className="flex gap-2">
            <Input
              value={statusDraft}
              onChange={(e) => setStatusDraft(e.target.value)}
              maxLength={60}
              placeholder="What are you up to?"
            />
            <Button
              size="sm"
              onClick={() => {
                // Strip any emoji so the status is plain text only — friends
                // see a short scannable line next to the name, no pictographs.
                const clean = stripEmoji(statusDraft);
                setStatusDraft(clean);
                setStatusText(clean);
                syncProfile({ status: clean });
                toast({ title: 'Status updated' });
              }}
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-xs text-text-dim">A short plain-text line friends see next to your name.</p>
        </div>
      </div>

      <div>
        <FieldLabel>About me</FieldLabel>
        <textarea
          value={bioDraft}
          onChange={(e) => setBioDraft(e.target.value)}
          maxLength={280}
          rows={3}
          placeholder="Tell people what you make…"
          className="w-full resize-none rounded-md border border-border bg-bg-2 px-3 py-2 text-sm text-text outline-none placeholder:text-text-dim focus:border-accent"
        />
        <div className="mt-1 flex items-center justify-between">
          <p className="text-xs text-text-dim">{bioDraft.length}/280</p>
          <Button
            size="sm"
            variant="outline"
            disabled={bioDraft === bio}
            onClick={() => {
              setBio(bioDraft.trim());
              syncProfile({ bio: bioDraft.trim() });
              toast({ title: 'Bio updated' });
            }}
          >
            Save bio
          </Button>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <FieldLabel>Account</FieldLabel>
        <AccountSection />
      </div>

      <AvatarCropper
        open={cropSrc !== null}
        src={cropSrc}
        onCancel={() => setCropSrc(null)}
        onCrop={(dataUrl) => { setCropSrc(null); saveAvatar(dataUrl); toast({ title: 'Photo updated' }); }}
      />
    </div>
  );
}

/** Settings tab — appearance, voice, 3D viewport, layout. */
function SettingsTabView() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const paperFollowsTheme = useAppStore((s) => s.paperFollowsTheme);
  const setPaperFollowsTheme = useAppStore((s) => s.setPaperFollowsTheme);
  const accent = useAppStore((s) => s.accent);
  const setAccent = useAppStore((s) => s.setAccent);
  const showOnline = useAppStore((s) => s.showOnline);
  const setShowOnline = useAppStore((s) => s.setShowOnline);
  const voiceVolume = useAppStore((s) => s.voiceVolume);
  const storeSetVoiceVolume = useAppStore((s) => s.setVoiceVolume);
  const voice = useVoiceOptional();
  const setVoiceVolume = (v: number) => {
    if (voice) voice.setOutputVolume(v);
    else storeSetVoiceVolume(v);
  };

  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-lg font-semibold text-text">Settings</h3>

      {/* Two columns on wide screens so settings span across instead of
          stacking into one very tall column. */}
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
      {/* Appearance */}
      <div>
        <FieldLabel>Theme</FieldLabel>
        <div className="flex w-max gap-1 rounded-sm bg-bg-3 p-0.5">
          {(
            [
              ['dark', 'Dark', Moon],
              ['light', 'Light', Sun],
            ] as [Theme, string, typeof Moon][]
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              className={
                'flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs ' +
                (theme === value ? 'bg-accent/20 text-accent' : 'text-text-dim hover:text-text')
              }
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs text-text-mid">
          <input
            type="checkbox"
            checked={paperFollowsTheme}
            onChange={(e) => setPaperFollowsTheme(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Board canvas follows theme
            <span className="block text-text-dim">
              The 2D paper and 3D viewport render light or dark to match. Turn off to show the
              board&apos;s shared background color instead.
            </span>
          </span>
        </label>
        <div className="mt-3">
          <FieldLabel>Accent color</FieldLabel>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Accent color"
              className="h-8 w-12 rounded-sm border border-border bg-transparent"
            />
            {['#7c6aff', '#38bdf8', '#22d3a5', '#fbbf24', '#f472b6', '#f87171'].map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${c}`}
                onClick={() => setAccent(c)}
                className={
                  'h-5 w-5 rounded-full border ' +
                  (accent.toLowerCase() === c ? 'border-text' : 'border-text-dim/40')
                }
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Voice */}
      <div>
        <FieldLabel>Voice</FieldLabel>
        <label className="flex items-center gap-2 text-xs text-text-mid">
          <span className="w-24 shrink-0">Output volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={voiceVolume}
            onChange={(e) => setVoiceVolume(Number(e.target.value))}
            className="flex-1 accent-accent"
            aria-label="Voice output volume"
          />
          <span className="w-8 text-right font-mono">{Math.round(voiceVolume * 100)}</span>
        </label>
        <p className="mt-1 text-xs text-text-dim">
          How loud everyone sounds to you. Per-person sliders live in the people widget while
          you&apos;re in voice.
        </p>
      </div>

      {/* Privacy */}
      <div>
        <FieldLabel>Privacy</FieldLabel>
        <label className="flex items-start gap-2 text-xs text-text-mid">
          <input
            type="checkbox"
            checked={showOnline}
            onChange={(e) => setShowOnline(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Show when I&apos;m online
            <span className="block text-text-dim">
              Friends see a green dot while you&apos;re active. Turn off to always appear offline.
            </span>
          </span>
        </label>
      </div>

      {/* Layout */}
      <div>
        <FieldLabel>Layout</FieldLabel>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            useDockStore.persist?.clearStorage?.();
            location.reload();
          }}
        >
          Reset dock layout
        </Button>
      </div>
      </div>
    </div>
  );
}

/**
 * Friends section — add by email, pending requests, accepted friends list.
 * Clicking an accepted friend opens a detail view (avatar, bio, status, days
 * on Slate, banner color). Falls back to a "sign in" hint when Supabase isn't
 * configured or the user isn't signed in.
 */
function FriendsSection({ userId }: { userId: string | undefined }) {
  const { friends, pending, loading, sendRequest, accept, remove } = useFriends(userId);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  // Must be declared with the other hooks (before any early return) so the hook
  // order stays constant whether or not accounts are enabled / the user is in.
  const [query, setQuery] = useState('');
  /** The friend whose profile detail view is open (null = list view). */
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);

  if (!accountsEnabled) {
    return (
      <p className="text-xs text-text-dim">
        Accounts are not configured. Create a free Supabase project, run{' '}
        <code className="font-mono">supabase/schema.sql</code>, and set{' '}
        <code className="font-mono">VITE_SUPABASE_URL</code> +{' '}
        <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> at build time to enable friends.
      </p>
    );
  }

  if (!userId) {
    return (
      <p className="text-xs text-text-dim">
        Sign in to add friends and share boards with people you know.
      </p>
    );
  }

  // Detail view for a clicked friend — overlays the list with a Back button.
  if (selectedFriend) {
    return (
      <FriendProfileView
        friend={selectedFriend}
        onBack={() => setSelectedFriend(null)}
        onRemove={async (id) => {
          await remove(id);
          setSelectedFriend(null);
        }}
      />
    );
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    await sendRequest(email);
    setBusy(false);
    setEmail('');
  };

  const q = query.trim().toLowerCase();
  const matches = (f: { displayName: string; email: string | null; statusText?: string | null }) =>
    q === '' ||
    f.displayName.toLowerCase().includes(q) ||
    (f.email ?? '').toLowerCase().includes(q) ||
    (f.statusText ?? '').toLowerCase().includes(q);
  const online = friends.filter((f) => f.online && matches(f));
  const offline = friends.filter((f) => !f.online && matches(f));

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="friend@example.com"
          aria-label="Friend's email"
          className="flex-1"
        />
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>
          <UserPlus size={13} />
          <span className="ml-1.5">Send</span>
        </Button>
      </form>

      {friends.length > 3 && (
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search friends…"
            aria-label="Search friends"
            className="w-full rounded-md border border-border bg-bg-2 py-1.5 pl-8 pr-3 text-xs text-text outline-none placeholder:text-text-dim focus:border-accent"
          />
        </div>
      )}

      {loading ? (
        <p className="text-xs text-text-dim">Loading…</p>
      ) : (
        <>
          {pending.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
                Pending requests
              </p>
              <ul className="flex flex-col gap-1">
                {pending.map((f) => (
                  <li
                    key={f.userId}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-2 px-2.5 py-1.5"
                  >
                    <Avatar url={f.avatarUrl} name={f.displayName} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-text">{f.displayName || 'Anonymous'}</p>
                      {f.email && <p className="truncate text-[10px] text-text-dim">{f.email}</p>}
                    </div>
                    {f.incoming ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void accept(f.userId)}
                          aria-label={`Accept friend request from ${f.displayName}`}
                        >
                          <Check size={12} />
                          <span className="ml-1">Accept</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void remove(f.userId)}
                          aria-label={`Decline friend request from ${f.displayName}`}
                        >
                          <X size={12} />
                        </Button>
                      </>
                    ) : (
                      <span className="text-[10px] font-mono uppercase tracking-wider text-text-dim">
                        Sent
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {friends.length > 0 ? (
            <>
              {online.length > 0 && <FriendList label={`Online — ${online.length}`} friends={online} onRemove={remove} onSelect={setSelectedFriend} />}
              {offline.length > 0 && <FriendList label={`Offline — ${offline.length}`} friends={offline} onRemove={remove} onSelect={setSelectedFriend} />}
              {online.length === 0 && offline.length === 0 && (
                <p className="text-xs text-text-dim">No friends match “{query}”.</p>
              )}
            </>
          ) : pending.length === 0 ? (
            <p className="text-xs text-text-dim">
              No friends yet — add someone by their email above to start collaborating.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Friend detail view — a social-style profile card for a clicked friend:
 *  banner, big avatar, status line, bio, stats (days on Slate, online status),
 *  email, plus a Back button and a Remove friend action. Fetches the friend's
 *  full profile (bio, banner color, created_at) on mount. */
function FriendProfileView({
  friend,
  onBack,
  onRemove,
}: {
  friend: Friend;
  onBack: () => void;
  onRemove: (friendId: string) => Promise<void>;
}) {
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof fetchUserProfile>> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchUserProfile(friend.userId).then((p) => {
      if (cancelled) return;
      setProfile(p);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [friend.userId]);

  // Prefer the freshly-fetched profile fields; fall back to the Friend row
  // (which already has display name / avatar / status / bio / email) so the
  // view renders immediately even before the fetch resolves.
  const displayName = profile?.displayName ?? friend.displayName ?? 'Anonymous';
  const avatarUrl = profile?.avatarUrl ?? friend.avatarUrl;
  const bio = profile?.bio ?? friend.bio;
  const statusText = profile?.status ?? friend.statusText;
  const email = profile?.email ?? friend.email;
  const bannerColor = profile?.bannerColor ?? '#7c6aff';
  const online = friend.online;

  const daysOnSlate = useMemo(() => {
    const t = profile?.createdAt;
    if (!t || !Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  }, [profile?.createdAt]);

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="flex w-max items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-mid hover:bg-bg-3 hover:text-text"
        aria-label="Back to friends list"
      >
        <ArrowLeft size={13} />
        <span>Back</span>
      </button>

      <div className="overflow-hidden rounded-xl border border-border bg-bg-2">
        <div
          className="h-24"
          style={{ background: `linear-gradient(135deg, ${bannerColor} 0%, ${bannerColor}55 70%, transparent 130%)` }}
        />
        <div className="px-5 pb-4">
          <div className="-mt-10 mb-2 flex items-end justify-between">
            <span className="relative shrink-0">
              <Avatar
                url={avatarUrl}
                name={displayName}
                size={88}
                className="ring-4 ring-bg-2"
              />
              <span
                className={
                  'absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full ring-2 ring-bg-2 ' +
                  (online ? 'bg-green' : 'bg-text-dim/50')
                }
                title={online ? 'Online' : 'Offline'}
              />
            </span>
          </div>
          <p className="truncate text-xl font-bold text-text">{displayName}</p>
          {stripEmoji(statusText) && <p className="mt-0.5 truncate text-sm text-text-mid">{stripEmoji(statusText)}</p>}
          {email && (
            <p className="mt-0.5 truncate text-xs text-text-dim" title={email}>
              {email}
            </p>
          )}
          {bio && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-mid">{bio}</p>}

          {/* Stats row */}
          <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3 text-xs text-text-dim">
            <span className="flex items-center gap-1">
              <span
                className={
                  'inline-block h-2 w-2 rounded-full ' + (online ? 'bg-green' : 'bg-text-dim/50')
                }
              />
              {online ? 'Online now' : 'Offline'}
            </span>
            {daysOnSlate !== null && (
              <span>
                <span className="font-semibold text-text">{daysOnSlate}</span> day{daysOnSlate === 1 ? '' : 's'} on Slate
              </span>
            )}
            {loading && <span className="text-text-dim">Loading…</span>}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="text-text-dim hover:text-danger"
          onClick={() => void onRemove(friend.userId)}
          aria-label={`Remove friend ${displayName}`}
        >
          <UserMinus size={13} />
          <span className="ml-1.5">Remove friend</span>
        </Button>
      </div>
    </div>
  );
}

/** One group of friend cards (Online / Offline) in a responsive grid. Each
 *  card is a square-ish, contact-directory-style tile: avatar centered at top,
 *  display name below (truncated), status text below that (small, truncated),
 *  and an online dot. The whole card is a button that opens the friend's
 *  profile detail view; the UserMinus button overlays the corner on hover so
 *  it doesn't compete with the click-to-open affordance. */
function FriendList({
  label,
  friends,
  onRemove,
  onSelect,
}: {
  label: string;
  friends: ReturnType<typeof useFriends>['friends'];
  onRemove: (friendId: string) => Promise<void>;
  onSelect: (friend: Friend) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-mono uppercase tracking-wider text-text-dim">{label}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {friends.map((f) => (
          <FriendCard key={f.userId} friend={f} onSelect={onSelect} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

/** A single compact friend tile — square-ish card with avatar + name + status.
 *  Click anywhere on the card (except the remove button) to open the profile. */
function FriendCard({
  friend: f,
  onSelect,
  onRemove,
}: {
  friend: ReturnType<typeof useFriends>['friends'][number];
  onSelect: (friend: Friend) => void;
  onRemove: (friendId: string) => Promise<void>;
}) {
  const status = stripEmoji(f.statusText);
  const subline = status || f.bio || f.email || (f.online ? 'Online' : 'Offline');
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(f)}
        aria-label={`View ${f.displayName || 'Anonymous'}'s profile`}
        className={
          'flex w-full flex-col items-center gap-1.5 rounded-lg border border-border bg-bg-2 p-3 text-center transition-colors hover:border-accent/50 hover:bg-bg-3 ' +
          (f.online ? '' : 'opacity-80')
        }
      >
        <span className="relative shrink-0">
          <Avatar
            url={f.avatarUrl}
            name={f.displayName}
            size={44}
            className={f.online ? '' : 'opacity-70 saturate-50'}
          />
          <span
            className={
              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-2 ' +
              (f.online ? 'bg-green' : 'bg-text-dim/50')
            }
            title={f.online ? 'Online' : 'Offline'}
          />
        </span>
        <p
          className={
            'w-full truncate text-xs font-semibold ' + (f.online ? 'text-text' : 'text-text-mid')
          }
          title={f.displayName || 'Anonymous'}
        >
          {f.displayName || 'Anonymous'}
        </p>
        <p className="w-full truncate text-[10px] text-text-dim" title={subline}>
          {subline}
        </p>
      </button>
      <button
        type="button"
        onClick={() => void onRemove(f.userId)}
        aria-label={`Remove friend ${f.displayName}`}
        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-sm bg-bg-3/90 text-text-mid opacity-0 backdrop-blur transition-opacity hover:text-danger group-hover:opacity-100"
      >
        <UserMinus size={11} />
      </button>
    </div>
  );
}

/**
 * Account — Supabase-backed sign-in + cross-device save backup. Renders a
 * setup hint until VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are provided.
 */
function AccountSection() {
  const { user, loading } = useAccount();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!accountsEnabled) {
    return (
      <p className="text-xs text-text-dim">
        Accounts are not configured. Create a free Supabase project, run{' '}
        <code className="font-mono">supabase/schema.sql</code>, and set{' '}
        <code className="font-mono">VITE_SUPABASE_URL</code> +{' '}
        <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> at build time to enable sign-in
        and cross-device saves.
      </p>
    );
  }
  if (loading) return <p className="text-xs text-text-dim">Checking session…</p>;

  if (!user) {
    return (
      <p className="text-xs text-text-dim">
        You&apos;re signed out — sign in from the start screen to back up your saves and open them
        on any device.
      </p>
    );
  }

  const run = async (fn: () => Promise<{ pushed?: number; pulled?: number; error?: string }>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setNote(
      r.error ??
        (r.pushed !== undefined
          ? `Backed up ${r.pushed} save${r.pushed === 1 ? '' : 's'}.`
          : `Restored ${r.pulled} save${r.pulled === 1 ? '' : 's'} — File → Open to load one.`),
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-text-mid">
        Signed in as <span className="font-mono text-text">{user.email}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => backupSavesToCloud(user.id))}>
          <CloudUpload size={13} />
          <span className="ml-1.5">Back up saves</span>
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => restoreSavesFromCloud(user.id))}>
          <CloudDownload size={13} />
          <span className="ml-1.5">Restore saves</span>
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void supabase?.auth.signOut()}>
          <LogOut size={13} />
          <span className="ml-1.5">Sign out</span>
        </Button>
      </div>
      {note && <p className="text-xs text-text-mid">{note}</p>}
    </div>
  );
}
