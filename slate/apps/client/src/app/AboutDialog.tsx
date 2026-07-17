/**
 * About dialog — what Slate is, plus quick links for feedback, support,
 * and the legal docs. Opened from the profile dropdown in Home + Onboarding.
 *
 * The Terms dialog is rendered as a nested dialog (state held here) so the
 * user can hop from About → Terms → Close → back to About.
 */

import { useState } from 'react';
import { Coffee, FileText, Mail } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { TermsDialog } from './TermsDialog';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FEEDBACK_EMAIL = 'jeffreyhamilton6399@gmail.com';
const DONATE_URL = 'https://buymeacoffee.com/jeffreyscof';

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const [termsOpen, setTermsOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} title="Slate is free forever">
        <div className="flex flex-col gap-4 text-sm text-text-mid">
          <p>
            Slate is a real-time collaborative 2D whiteboard, 3D editor, and audio DAW. It&apos;s
            free forever, open for everyone, and works in your browser.
          </p>

          {/* Give Feedback */}
          <section className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-mono uppercase tracking-wider text-text-dim">
              Give Feedback
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => {
                const body = encodeURIComponent(
                  "Tell us what's working, what's broken, or what you'd love to see next.\n\n— ",
                );
                window.open(
                  `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent('Slate Feedback')}&body=${body}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              }}
            >
              <Mail size={14} />
              Email the developer
            </Button>
          </section>

          {/* Support Slate */}
          <section className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-mono uppercase tracking-wider text-text-dim">
              Support Slate
            </p>
            <a
              href={DONATE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex w-full items-center justify-center gap-2 rounded-sm bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
            >
              <Coffee size={14} />
              Buy me a coffee
            </a>
          </section>

          {/* Terms & Privacy */}
          <section className="border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-mono uppercase tracking-wider text-text-dim">
              Terms &amp; Privacy
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => setTermsOpen(true)}
            >
              <FileText size={14} />
              Read the Terms of Service &amp; Privacy Policy
            </Button>
          </section>
        </div>
        <div className="flex justify-end pt-4">
          <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </Dialog>

      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </>
  );
}
