import * as RadixToast from '@radix-ui/react-toast';
import { create } from 'zustand';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';
import { makeId } from '../utils/id';

interface ToastEntry {
  id: string;
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'error';
}

interface ToastStore {
  toasts: ToastEntry[];
  push: (t: Omit<ToastEntry, 'id'>) => string;
  remove: (id: string) => void;
}

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = makeId('toast');
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
    return id;
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export function toast(t: Omit<ToastEntry, 'id'>): string {
  return useToasts.getState().push(t);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixToast.Provider swipeDirection="right" duration={4000}>
      {children}
      <ToastViewport />
    </RadixToast.Provider>
  );
}

function ToastViewport() {
  const toasts = useToasts((s) => s.toasts);
  const remove = useToasts((s) => s.remove);
  return (
    <>
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} onClose={() => remove(t.id)} />
      ))}
      <RadixToast.Viewport className="fixed bottom-4 right-4 z-[400] flex w-[360px] max-w-[92vw] flex-col gap-2 outline-none" />
    </>
  );
}

function ToastItem({ entry, onClose }: { entry: ToastEntry; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <RadixToast.Root
      className={cn(
        'surface flex items-start gap-3 p-3 shadow-xl animate-slide-up',
        entry.variant === 'success' && 'border-green/40',
        entry.variant === 'error' && 'border-danger/40',
      )}
    >
      <div className="flex-1">
        <RadixToast.Title className="text-sm font-semibold">{entry.title}</RadixToast.Title>
        {entry.description && (
          <RadixToast.Description className="mt-0.5 text-xs text-text-mid">
            {entry.description}
          </RadixToast.Description>
        )}
      </div>
      <RadixToast.Close
        aria-label="Close"
        className="p-1 text-text-dim hover:text-text"
        onClick={onClose}
      >
        <X size={14} />
      </RadixToast.Close>
    </RadixToast.Root>
  );
}
