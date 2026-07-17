/**
 * Terms of Service + Privacy Policy dialog.
 *
 * Shared by SignIn (sign-up ToS link), the Home profile dropdown, and the
 * Onboarding profile dropdown. Renders above the z-1000 entry gates via the
 * shared `Dialog` component (z-1100).
 */

import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface TermsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TermsDialog({ open, onOpenChange }: TermsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Terms of Service & Privacy Policy">
      <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto pr-1 text-xs text-text-mid">
        <section>
          <p className="font-medium text-text">Terms of Service</p>
          <p className="mt-1">
            Slate is provided as-is, without warranty of any kind. You are responsible for the
            content you create and share. Boards can be public — do not post anything you do not
            have the right to share. Accounts that abuse the service may be removed.
          </p>
        </section>
        <section>
          <p className="font-medium text-text">Privacy Policy</p>
          <p className="mt-1">
            Your email address and password hash are stored with our authentication provider
            (Supabase) solely to operate your account. Board saves you back up are stored under
            your account and are not shared with other users. Live board content is synced with
            the collaborators in the same board. We do not sell your data.
          </p>
        </section>
        <section>
          <p className="font-medium text-text">Data Retention</p>
          <p className="mt-1">
            Your boards are stored locally in your browser and synced to the server while
            you&apos;re collaborating. Deleting a project removes it from your local storage and
            cloud saves.
          </p>
        </section>
        <p className="text-text-dim">Questions? Contact the board owner or the project maintainer.</p>
      </div>
      <div className="flex justify-end pt-3">
        <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
