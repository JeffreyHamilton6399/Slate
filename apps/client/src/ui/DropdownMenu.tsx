import * as Radix from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn';

export const DropdownMenu = Radix.Root;
export const DropdownMenuTrigger = Radix.Trigger;

export function DropdownMenuContent({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <Radix.Portal>
      <Radix.Content
        align={align}
        sideOffset={6}
        className={cn(
          'min-w-[180px] rounded-md surface p-1 shadow-xl animate-fade-in z-[300]',
          className,
        )}
      >
        {children}
      </Radix.Content>
    </Radix.Portal>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  disabled,
  destructive,
  shortcut,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
}) {
  return (
    <Radix.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex items-center justify-between gap-3 cursor-pointer rounded-sm px-2.5 py-1.5 text-sm outline-none',
        'data-[highlighted]:bg-bg-4 data-[highlighted]:text-text',
        destructive ? 'text-danger' : 'text-text',
        disabled && 'opacity-50 pointer-events-none',
      )}
    >
      <span className="flex items-center gap-2">{children}</span>
      {shortcut && <span className="text-xs text-text-dim font-mono">{shortcut}</span>}
    </Radix.Item>
  );
}

export function DropdownMenuSeparator() {
  return <Radix.Separator className="my-1 h-px bg-border" />;
}

export function DropdownMenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <Radix.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="flex items-center gap-2 cursor-pointer rounded-sm px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-bg-4 data-[highlighted]:text-text text-text"
    >
      <span className="w-4">
        {checked && <Check size={14} className="text-accent" />}
      </span>
      <span>{children}</span>
    </Radix.CheckboxItem>
  );
}
