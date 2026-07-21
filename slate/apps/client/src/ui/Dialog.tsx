import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, className }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        {/* Above the fullscreen gates (Home sign-in / onboarding at z-1000):
            dialogs opened FROM a gate (e.g. Terms of Service on the sign-up
            form) must render over it, not invisibly behind it. */}
        <RadixDialog.Overlay className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur-sm animate-fade-in" />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[1101] -translate-x-1/2 -translate-y-1/2 w-[92vw] rounded-lg surface shadow-2xl animate-slide-up',
            // `cn` is plain clsx (no tailwind-merge), so a base class would
            // fight a caller's override by CSS source order. Only apply the
            // defaults when the caller didn't pass their own.
            !className?.includes('max-w-') && 'max-w-md',
            !className?.includes('p-0') && 'p-5',
            className,
          )}
        >
          {title && (
            <RadixDialog.Title className="text-lg font-semibold mb-1.5">{title}</RadixDialog.Title>
          )}
          {description && (
            <RadixDialog.Description className="text-sm text-text-mid mb-4">
              {description}
            </RadixDialog.Description>
          )}
          {children}
          <RadixDialog.Close
            aria-label="Close"
            className="absolute right-3 top-3 p-1.5 rounded-sm text-text-dim hover:text-text hover:bg-bg-4"
          >
            <X size={16} />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
