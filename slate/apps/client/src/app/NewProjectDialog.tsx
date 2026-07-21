/**
 * New-project dialog — create a fresh board (2D or 3D) without leaving the
 * app. Available from the header (+) and File → New project…, so users don't
 * have to bounce out to Home to start something new.
 */

import { useState } from 'react';
import { Box, PenLine, Workflow } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input, FieldLabel } from '../ui/Input';
import { cn } from '../utils/cn';
import { useAppStore } from './store';
import { sanitizeBoardName, randomBoardName } from './Onboarding';

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const enterBoard = useAppStore((s) => s.enterBoard);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'2d' | '3d' | 'diagram'>('2d');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');

  const create = () => {
    const board = sanitizeBoardName(name) || randomBoardName();
    onOpenChange(false);
    setName('');
    // A brand-new name means we're the creator; the workspace remounts on the
    // currentBoard change and bootstraps the fresh doc.
    enterBoard({ name: board, mode, visibility, iAmCreator: true, joinedAt: Date.now() });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Start a fresh board. Your current board stays saved — reopen it any time from File → Open."
    >
      <div className="flex flex-col gap-4">
        <div>
          <FieldLabel>Name (optional)</FieldLabel>
          <Input
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
            }}
            placeholder="leave empty for a random name"
          />
        </div>
        <div>
          <FieldLabel>Type</FieldLabel>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['2d', '2D whiteboard', PenLine],
                ['3d', '3D editor', Box],
                ['diagram', 'Diagram', Workflow],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => setMode(v)}
                className={cn(
                  'flex items-center gap-2 rounded-sm border px-3 py-2.5 text-sm',
                  mode === v
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-border text-text-mid hover:bg-bg-3',
                )}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <FieldLabel>Visibility</FieldLabel>
          <div className="flex gap-0.5 rounded-sm bg-bg-3 p-0.5 w-max">
            {(
              [
                ['public', 'Public'],
                ['private', 'Private'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className={cn(
                  'rounded-sm px-3 py-1 text-xs font-medium',
                  visibility === v ? 'bg-accent text-white' : 'text-text-dim hover:text-text',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create}>
            Create project
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
