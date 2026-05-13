/**
 * Settings dialog: display name, sound effects toggle, theme, dock reset.
 */

import { useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input, FieldLabel } from '../ui/Input';
import { useAppStore } from './store';
import { useDockStore } from '../workspace/dockStore';
import { toast } from '../ui/Toast';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const displayName = useAppStore((s) => s.displayName);
  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const [name, setName] = useState(displayName);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="These settings are stored locally on this device."
    >
      <div className="flex flex-col gap-4">
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
                toast({ title: 'Display name updated' });
              }}
            >
              Save
            </Button>
          </div>
        </div>

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

        <div className="border-t border-border pt-4">
          <FieldLabel>About</FieldLabel>
          <p className="text-xs text-text-mid">
            Slate v2 — no accounts, peer state via CRDT (Yjs) over WebSocket relay.
            Voice via WebRTC. PWA install supported.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
