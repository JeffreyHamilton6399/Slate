/**
 * Profile dialog — replaces SettingsDialog. Combines the existing settings
 * sections (display name, appearance, voice, 3D viewport, layout, account)
 * with a new Friends section so the user can manage everything about their
 * identity + social graph from one place.
 *
 * Sections (top to bottom):
 *   1. Profile header — avatar + email + display name
 *   2. Display name
 *   3. Friends (NEW) — add by email, pending requests, accepted friends
 *   4. Appearance — theme + accent + paper follows theme
 *   5. Voice — output volume slider
 *   6. 3D viewport — transform HUD hints
 *   7. Layout — reset dock
 *   8. Account — Supabase backup / restore / sign out
 */

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CloudDownload,
  CloudUpload,
  LogOut,
  Moon,
  Sun,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input, FieldLabel } from '../ui/Input';
import { useAppStore, type Theme } from './store';
import { accountsEnabled, supabase } from '../account/supabase';
import { useAccount } from '../account/useAccount';
import { useFriends } from '../account/useFriends';
import { upsertMyProfile } from '../account/friends';
import { backupSavesToCloud, restoreSavesFromCloud } from '../account/cloudSaves';
import { useDockStore } from '../workspace/dockStore';
import { useVoiceOptional } from '../voice/useVoiceOptional';
import { toast } from '../ui/Toast';

interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When true, scroll the Friends section into view on open. */
  focusFriends?: boolean;
}

export function ProfileDialog({ open, onOpenChange, focusFriends }: ProfileDialogProps) {
  const displayName = useAppStore((s) => s.displayName);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const paperFollowsTheme = useAppStore((s) => s.paperFollowsTheme);
  const setPaperFollowsTheme = useAppStore((s) => s.setPaperFollowsTheme);
  const accent = useAppStore((s) => s.accent);
  const setAccent = useAppStore((s) => s.setAccent);
  const showTransformHud = useAppStore((s) => s.showTransformHud);
  const setShowTransformHud = useAppStore((s) => s.setShowTransformHud);
  const voiceVolume = useAppStore((s) => s.voiceVolume);
  const storeSetVoiceVolume = useAppStore((s) => s.setVoiceVolume);
  const voice = useVoiceOptional();
  const setVoiceVolume = (v: number) => {
    // Route through the live voice client when connected; store otherwise.
    if (voice) voice.setOutputVolume(v);
    else storeSetVoiceVolume(v);
  };

  const { user } = useAccount();
  const email = user?.email ?? '';
  const userId = user?.id;
  const [name, setName] = useState(displayName);
  const friendsSectionRef = useRef<HTMLDivElement | null>(null);

  // Sync local name input when the dialog opens / store name changes.
  useEffect(() => {
    if (open) setName(displayName);
  }, [open, displayName]);

  // When asked to focus the friends section (e.g. opened from "Friends" in
  // the profile dropdown), scroll it into view shortly after open.
  useEffect(() => {
    if (!open || !focusFriends) return;
    const t = setTimeout(() => {
      friendsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return () => clearTimeout(t);
  }, [open, focusFriends]);

  const initial = email ? email[0]?.toUpperCase() ?? '?' : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Profile"
      description="Manage your identity, friends, and device preferences."
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        {/* Profile header */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-2 p-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-lg font-semibold text-accent">
            {initial ?? '?'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">
              {displayName || 'Anonymous'}
            </p>
            {email ? (
              <p className="truncate text-xs text-text-dim" title={email}>
                {email}
              </p>
            ) : (
              <p className="text-xs text-text-dim">Not signed in</p>
            )}
          </div>
        </div>

        {/* Display name */}
        <div>
          <FieldLabel>Display name</FieldLabel>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="Your name"
            />
            <Button
              size="sm"
              onClick={() => {
                setDisplayName(name);
                // Mirror to the cloud profile so friends can see the new name.
                if (userId) void upsertMyProfile(userId, name, email);
                toast({ title: 'Display name updated' });
              }}
            >
              Save
            </Button>
          </div>
        </div>

        {/* Friends */}
        <div ref={friendsSectionRef} className="border-t border-border pt-4">
          <FriendsSection userId={userId} />
        </div>

        {/* Appearance */}
        <div className="border-t border-border pt-4">
          <FieldLabel>Theme</FieldLabel>
          <div className="flex gap-1 rounded-sm bg-bg-3 p-0.5 w-max">
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
                  (theme === value
                    ? 'bg-accent/20 text-accent'
                    : 'text-text-dim hover:text-text')
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
                The 2D paper and 3D viewport render light or dark to match. Turn off to
                show the board&apos;s shared background color set below.
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
        <div className="border-t border-border pt-4">
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
        <div className="border-t border-border pt-4">
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
                The on-screen prompts at the bottom of the 3D viewport (e.g. “Bevel • move
                mouse · click to confirm”). Turn off once you know the tools.
              </span>
            </span>
          </label>
          <p className="mt-2 text-xs text-text-dim">
            Units, CAD snapping, and the board background are per-board — set them in
            File → Board settings.
          </p>
        </div>

        {/* Layout */}
        <div className="border-t border-border pt-4">
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

        {/* Account */}
        <div className="border-t border-border pt-4">
          <FieldLabel>Account</FieldLabel>
          <AccountSection />
        </div>
      </div>
    </Dialog>
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
        <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> at build time to enable
        friends.
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
          {/* Pending requests */}
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
                      <p className="truncate text-xs font-medium text-text">
                        {f.displayName || 'Anonymous'}
                      </p>
                      {f.email && (
                        <p className="truncate text-[10px] text-text-dim">{f.email}</p>
                      )}
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

          {/* Accepted friends */}
          {friends.length > 0 ? (
            <div>
              <p className="mb-1 text-[10px] font-mono uppercase tracking-wider text-text-dim">
                Friends ({friends.length})
              </p>
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
                {friends.map((f) => (
                  <li
                    key={f.userId}
                    className="flex items-center gap-2 rounded-md border border-border bg-bg-2 px-2.5 py-1.5"
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
                      {(f.displayName || '?')[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-text">
                        {f.displayName || 'Anonymous'}
                      </p>
                      {f.email && (
                        <p className="truncate text-[10px] text-text-dim">{f.email}</p>
                      )}
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
 * setup hint until VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are provided
 * (see supabase/schema.sql for the one-time project setup).
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
        <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> at build time to enable
        sign-in and cross-device saves.
      </p>
    );
  }
  if (loading) return <p className="text-xs text-text-dim">Checking session…</p>;

  if (!user) {
    return (
      <p className="text-xs text-text-dim">
        You&apos;re signed out — sign in from the start screen to back up your saves and open
        them on any device.
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
