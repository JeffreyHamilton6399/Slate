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
        <RadixDialog.Overlay className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm animate-fade-in" />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[301] -translate-x-1/2 -translate-y-1/2 w-[92vw] max-w-md rounded-lg surface shadow-2xl p-6 animate-slide-up',
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
