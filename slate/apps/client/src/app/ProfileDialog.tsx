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

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CloudDownload,
  CloudUpload,
  LogOut,
  Moon,
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
import { upsertMyProfile, fetchMyProfile } from '../account/friends';
import { backupSavesToCloud, restoreSavesFromCloud } from '../account/cloudSaves';
import { useDockStore } from '../workspace/dockStore';
import { useVoiceOptional } from '../voice/useVoiceOptional';
import { toast } from '../ui/Toast';
import { Avatar } from './Avatar';
import { AvatarCropper } from './AvatarCropper';

export type ProfileTab = 'profile' | 'friends' | 'settings';

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

  // On open, pull the avatar/name synced from another device (if the local
  // store hasn't got one yet). Keeps the pic following the account.
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    void fetchMyProfile(user.id).then((prof) => {
      if (cancelled || !prof) return;
      if (prof.avatarUrl && !useAppStore.getState().avatarUrl) setAvatarUrl(prof.avatarUrl);
      if (prof.displayName && !useAppStore.getState().displayName) setDisplayName(prof.displayName);
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
        {/* Tab rail */}
        <nav className="flex shrink-0 gap-1 border-b border-border p-3 sm:w-56 sm:flex-col sm:border-b-0 sm:border-r">
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
                'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ' +
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
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
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

/** Profile tab — identity + account (avatar, name, cloud backup, sign out). */
function ProfileTabView() {
  const displayName = useAppStore((s) => s.displayName);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const avatarUrl = useAppStore((s) => s.avatarUrl);
  const setAvatarUrl = useAppStore((s) => s.setAvatarUrl);
  const { user } = useAccount();
  const email = user?.email ?? '';
  const userId = user?.id;
  const [name, setName] = useState(displayName);
  useEffect(() => setName(displayName), [displayName]);

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

  const saveAvatar = (dataUrl: string | null) => {
    setAvatarUrl(dataUrl ?? '');
    if (userId) void upsertMyProfile(userId, useAppStore.getState().displayName || name, email, dataUrl ?? null);
  };

  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-lg font-semibold text-text">Profile</h3>
      <div className="flex items-center gap-4 rounded-lg border border-border bg-bg-2 p-4">
        {/* Avatar with hover camera overlay (Google-style). */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group relative shrink-0 rounded-full"
          title="Change photo"
          aria-label="Change profile photo"
        >
          <Avatar url={avatarUrl} name={displayName || email} size={72} className="ring-2 ring-border" />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <Camera size={20} className="text-white" />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = ''; }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text">{displayName || 'Anonymous'}</p>
          {email ? (
            <p className="truncate text-xs text-text-dim" title={email}>{email}</p>
          ) : (
            <p className="text-xs text-text-dim">Not signed in</p>
          )}
          <div className="mt-2 flex gap-2">
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
      </div>

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
  const showTransformHud = useAppStore((s) => s.showTransformHud);
  const setShowTransformHud = useAppStore((s) => s.setShowTransformHud);
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

      {/* 3D viewport */}
      <div>
        <FieldLabel>3D viewport</FieldLabel>
        <label className="flex items-start gap-2 text-xs text-text-mid">
          <input
            type="checkbox"
            checked={showTransformHud}
            onChange={(e) => setShowTransformHud(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Show transform hints
            <span className="block text-text-dim">
              The on-screen prompts at the bottom of the 3D viewport. Turn off once you know the
              tools.
            </span>
          </span>
        </label>
        <p className="mt-2 text-xs text-text-dim">
          Units, CAD snapping, and the board background are per-board — set them in File → Board
          settings.
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
 * Falls back to a "sign in" hint when Supabase isn't configured or the user
 * isn't signed in.
 */
function FriendsSection({ userId }: { userId: string | undefined }) {
  const { friends, pending, loading, sendRequest, accept, remove } = useFriends(userId);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

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

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    await sendRequest(email);
    setBusy(false);
    setEmail('');
  };

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
            <div>
              <p className="mb-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
                Friends ({friends.length})
              </p>
              <ul className="flex flex-col gap-1">
                {friends.map((f) => (
                  <li
                    key={f.userId}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-2 px-2.5 py-1.5"
                  >
                    <span className="relative shrink-0">
                      <Avatar url={f.avatarUrl} name={f.displayName} size={28} />
                      <span
                        className={
                          'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-2 ' +
                          (f.online ? 'bg-green' : 'bg-text-dim/50')
                        }
                        title={f.online ? 'Online' : 'Offline'}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-text">
                        {f.displayName || 'Anonymous'}
                        {f.online && <span className="ml-1.5 text-[10px] font-normal text-green">online</span>}
                      </p>
                      {f.email && <p className="truncate text-[10px] text-text-dim">{f.email}</p>}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void remove(f.userId)}
                      aria-label={`Remove friend ${f.displayName}`}
                    >
                      <UserMinus size={12} />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
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
