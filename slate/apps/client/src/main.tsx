import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary, clearCachesAndReload } from './app/ErrorBoundary';

// Stale-deploy self-heal: after a redeploy, a cached index.html can reference
// hashed chunks that no longer exist. Vite fires this event when a dynamic
// import fails — clear SW caches and reload once instead of black-screening.
window.addEventListener('vite:preloadError', (e) => {
  if (sessionStorage.getItem('slate.reloaded-once')) return;
  sessionStorage.setItem('slate.reloaded-once', '1');
  e.preventDefault();
  void clearCachesAndReload();
});

// Keep installed/long-lived sessions on the latest build: poll for a new
// service worker every minute. When one takes control, DON'T reload
// mid-session (mid-drawing reloads look like the user vanishing to their
// collaborators) — reload when the tab is next hidden instead.
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  let reloadPending = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      // First-ever install claiming the page — no need to reload.
      hadController = true;
      return;
    }
    if (document.hidden) window.location.reload();
    else reloadPending = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (reloadPending && document.hidden) window.location.reload();
  });
  window.setInterval(() => {
    void navigator.serviceWorker.getRegistration().then((r) => r?.update());
  }, 60_000);
}

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
