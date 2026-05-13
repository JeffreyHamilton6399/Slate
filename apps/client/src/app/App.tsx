/**
 * App root: chooses Onboarding vs Workspace based on app store. Mounts
 * global providers (toast, tooltip) and registers built-in panels.
 */

import { useEffect } from 'react';
import { Onboarding } from './Onboarding';
import { Workspace } from './Workspace';
import { useAppStore } from './store';
import { ToastProvider } from '../ui/Toast';
import { TooltipProvider } from '../ui/Tooltip';
import { registerBuiltInPanels } from '../panels/registerBuiltInPanels';
import { InstallPrompt } from './InstallPrompt';

registerBuiltInPanels();

export function App() {
  const board = useAppStore((s) => s.currentBoard);
  const setPwaInstallable = useAppStore((s) => s.setPwaInstallable);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      (window as unknown as { __pwaPrompt?: Event }).__pwaPrompt = e;
      setPwaInstallable(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [setPwaInstallable]);

  return (
    <TooltipProvider>
      <ToastProvider>
        {board ? <Workspace /> : <Onboarding />}
        <InstallPrompt />
      </ToastProvider>
    </TooltipProvider>
  );
}
