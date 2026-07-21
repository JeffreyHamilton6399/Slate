/**
 * WelcomeOverlay — a one-time first-run tutorial shown the first time a user
 * enters a board on this device. The localStorage flag `slate.onboarding.done`
 * gates it so it never repeats (and never blocks a returning user).
 *
 * Flow:
 *   1. Welcome splash — short pitch.
 *   2. "Have you used Slate before?" — Yes jumps straight to Done; No shows
 *      a 3-card tip rundown of the basics.
 *   3. Done — sets the localStorage flag and unmounts.
 *
 * Skipping (via the X close button or pressing Escape) also sets the flag so
 * the user is never nagged. The overlay lives above the Workspace shell so
 * the user can see the board they just entered behind it; it doesn't block
 * interaction with the underlying editor once dismissed.
 */

import { useEffect, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Check, Layers, MousePointerClick, PenLine, Share2, X } from 'lucide-react';
import { Button } from '../ui/Button';

/** localStorage flag — '1' once the user has seen the tutorial (or skipped). */
export const ONBOARDING_DONE_KEY = 'slate.onboarding.done';

/** Returns true if the user has already seen the tutorial on this device. */
export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Marks the tutorial as seen so it never re-shows. Safe to call repeatedly. */
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    /* localStorage may be unavailable (private mode) — silently skip. */
  }
}

type Step = 'welcome' | 'experience' | 'tips';

interface TipCard {
  Icon: typeof Layers;
  title: string;
  body: string;
}

const TIPS: TipCard[] = [
  {
    Icon: Layers,
    title: 'Pick your mode',
    body: 'Choose between 2D canvas, 3D editor, audio DAW, docs, code, or diagrams — each board is one mode, and you can have as many boards as you want.',
  },
  {
    Icon: MousePointerClick,
    title: 'Tools live in the panels',
    body: 'On desktop, panels dock to the sides. On mobile, tap the Panels button (bottom-right) to open them in a bottom sheet.',
  },
  {
    Icon: Share2,
    title: 'Everything syncs live',
    body: 'Invite friends with the Share button — every edit, stroke, and cursor merges in real time. Offline edits catch up when you reconnect.',
  },
  {
    Icon: PenLine,
    title: 'Save & export anytime',
    body: 'The File menu (top-left) has Save, Save As, Export, and Print. Boards auto-save while you work, so your progress follows you across devices.',
  },
];

export function WelcomeOverlay() {
  // Mount-time read of the localStorage flag — we never want to flash the
  // overlay open and then close it, so the initial state matches the flag.
  const [open, setOpen] = useState(() => !hasSeenOnboarding());
  const [step, setStep] = useState<Step>('welcome');

  // Reset to the first step every time the overlay opens (defensive — there's
  // only ever one open in the app lifetime, but keeps state honest).
  useEffect(() => {
    if (open) setStep('welcome');
  }, [open]);

  // Escape closes the overlay (RadixDialog handles the Escape key
  // natively — this is for the close button + completion path).
  const dismiss = () => {
    markOnboardingDone();
    setOpen(false);
  };

  if (!open) return null;

  return (
    <RadixDialog.Root open={open} onOpenChange={(v) => { if (!v) dismiss(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[1200] bg-black/60 backdrop-blur-sm animate-fade-in" />
        <RadixDialog.Content
          aria-label="Welcome to Slate"
          className="fixed left-1/2 top-1/2 z-[1201] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg surface p-6 shadow-2xl animate-slide-up sm:p-8"
        >
          {/* Close (X) button — top-right. Skipping also sets the localStorage
              flag so the user isn't nagged on the next board entry. */}
          <RadixDialog.Close
            aria-label="Skip welcome"
            className="absolute right-3 top-3 rounded-sm p-1.5 text-text-dim hover:bg-bg-4 hover:text-text"
          >
            <X size={16} />
          </RadixDialog.Close>

          {step === 'welcome' && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent/15 text-accent">
                <PenLine size={26} />
              </div>
              <div>
                <RadixDialog.Title className="text-2xl font-bold tracking-tight text-text">
                  Welcome to Slate
                </RadixDialog.Title>
                <RadixDialog.Description className="mt-2 text-sm text-text-mid">
                  A real-time multi-mode canvas — draw in 2D, build in 3D, mix audio, write docs, code, and diagram, all in your browser. Everything you do here syncs live with everyone on the board.
                </RadixDialog.Description>
              </div>
              <Button
                variant="primary"
                size="lg"
                className="mt-2 w-full"
                onClick={() => setStep('experience')}
              >
                Continue
              </Button>
            </div>
          )}

          {step === 'experience' && (
            <div className="flex flex-col gap-5">
              <div>
                <RadixDialog.Title className="text-xl font-bold tracking-tight text-text">
                  Have you used Slate before?
                </RadixDialog.Title>
                <RadixDialog.Description className="mt-1.5 text-sm text-text-mid">
                  We&apos;ll skip the basics if you&apos;re already up to speed.
                </RadixDialog.Description>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setStep('tips')}
                  className="flex flex-col items-start gap-1 rounded-md border border-border bg-bg-2 p-4 text-left transition-colors hover:border-accent/50 hover:bg-bg-3"
                >
                  <span className="text-sm font-medium text-text">No, it&apos;s new</span>
                  <span className="text-xs text-text-dim">Show me a quick rundown</span>
                </button>
                <button
                  type="button"
                  onClick={dismiss}
                  className="flex flex-col items-start gap-1 rounded-md border border-border bg-bg-2 p-4 text-left transition-colors hover:border-accent/50 hover:bg-bg-3"
                >
                  <span className="flex items-center gap-1 text-sm font-medium text-text">
                    <Check size={13} className="text-green" /> Yes, jump in
                  </span>
                  <span className="text-xs text-text-dim">Skip the tutorial</span>
                </button>
              </div>
            </div>
          )}

          {step === 'tips' && (
            <div className="flex flex-col gap-4">
              <div>
                <RadixDialog.Title className="text-xl font-bold tracking-tight text-text">
                  Quick tour
                </RadixDialog.Title>
                <RadixDialog.Description className="mt-1.5 text-sm text-text-mid">
                  Four things to know — then you&apos;re on your way.
                </RadixDialog.Description>
              </div>
              <ul className="flex flex-col gap-2.5">
                {TIPS.map(({ Icon, title, body }) => (
                  <li
                    key={title}
                    className="flex gap-3 rounded-md border border-border bg-bg-2 p-3"
                  >
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent/15 text-accent">
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text">{title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-text-mid">{body}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <Button variant="primary" size="lg" className="w-full" onClick={dismiss}>
                Got it — start creating
              </Button>
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
