/**
 * Soft install prompt — appears once we have the deferred `beforeinstallprompt`
 * event (Chromium browsers). iOS Safari users see a one-time hint with
 * Add-to-Home-Screen instructions.
 */

import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useAppStore } from './store';
import { Button } from '../ui/Button';

const DISMISS_KEY = 'slate.install.dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const installable = useAppStore((s) => s.pwaInstallable);
  const setInstallable = useAppStore((s) => s.setPwaInstallable);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent) && !/MSStream/.test(navigator.userAgent));
  }, []);

  if (dismissed) return null;
  if (!installable && !isIOS) return null;

  const onInstall = async () => {
    const evt = (window as unknown as { __pwaPrompt?: BeforeInstallPromptEvent }).__pwaPrompt;
    if (!evt) return;
    await evt.prompt();
    await evt.userChoice;
    (window as unknown as { __pwaPrompt?: BeforeInstallPromptEvent }).__pwaPrompt = undefined;
    setInstallable(false);
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, '1');
  };

  const onDismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, '1');
  };

  return (
    <div className="fixed bottom-3 left-3 right-3 z-50 mx-auto max-w-md rounded-md border border-border bg-bg-2/95 backdrop-blur p-3 shadow-xl flex items-center gap-3">
      <Download size={16} className="text-accent shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">Install Slate</p>
        <p className="text-xs text-text-dim mt-0.5">
          {isIOS
            ? 'Tap Share → Add to Home Screen to install. Slate works offline once installed.'
            : 'Install Slate to your home screen for offline access and a focused window.'}
        </p>
      </div>
      {!isIOS && (
        <Button variant="primary" size="sm" onClick={onInstall}>
          Install
        </Button>
      )}
      <Button variant="icon" size="none" onClick={onDismiss} aria-label="Dismiss">
        <X size={14} />
      </Button>
    </div>
  );
}
