/**
 * layout-dock.js — Resizable sidebar / right dock + extensible dock registry.
 * Loaded after index inline script; uses CSS variables on :root.
 */
(function slateLayoutDock() {
  'use strict';

  const LS_SIDEBAR = 'slate_layout_sidebar_w';
  const LS_DOCK = 'slate_layout_dock_w';

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function readNum(key, fallback) {
    const v = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(v) ? v : fallback;
  }

  function applySidebarW(px) {
    const w = clamp(px, 200, Math.min(480, Math.floor(window.innerWidth * 0.55)));
    document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    try { localStorage.setItem(LS_SIDEBAR, String(w)); } catch (_) {}
  }

  function applyDockW(px) {
    const w = clamp(px, 0, Math.min(420, Math.floor(window.innerWidth * 0.5)));
    document.documentElement.style.setProperty('--dock-w', w + 'px');
    try { localStorage.setItem(LS_DOCK, String(w)); } catch (_) {}
    const dock = document.getElementById('right-dock');
    if (dock) dock.classList.toggle('dock-collapsed', w < 8);
  }

  function initSidebarResize() {
    const handle = document.getElementById('sidebar-resize-handle');
    if (!handle) return;
    let startX, startW;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      startX = e.clientX;
      const cur = readNum(LS_SIDEBAR, 260);
      startW = cur;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      applySidebarW(startW + dx);
    });
    handle.addEventListener('pointerup', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
    });
    handle.addEventListener('pointercancel', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
    });
  }

  function initDockResize() {
    const handle = document.getElementById('dock-resize-handle');
    if (!handle) return;
    let startX, startW;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      startX = e.clientX;
      const root = getComputedStyle(document.documentElement);
      const cur = parseInt(root.getPropertyValue('--dock-w'), 10) || readNum(LS_DOCK, 220);
      startW = cur;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = startX - e.clientX;
      applyDockW(startW + dx);
    });
    handle.addEventListener('pointerup', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      document.getElementById('right-dock')?.classList.remove('dock-user-collapsed');
    });
    handle.addEventListener('pointercancel', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
    });
  }

  /** Extensible dock: registerPanel({ id, title, mount(el), order? }) — idempotent per id */
  const panels = [];
  window.slateDock = {
    registerPanel(def) {
      if (!def || !def.id || !def.title || typeof def.mount !== 'function') return;
      if (panels.some(p => p.id === def.id)) return;
      panels.push({ ...def, order: def.order ?? 100 });
      panels.sort((a, b) => (a.order || 0) - (b.order || 0));
      appendDockPanel(def);
    },
    setActive(id) {
      const tabs = document.getElementById('dock-tabs');
      if (!tabs) return;
      tabs.querySelectorAll('.dock-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.panel === id);
      });
      const body = document.getElementById('dock-body');
      if (!body) return;
      body.querySelectorAll('.dock-panel').forEach(p => {
        p.style.display = p.dataset.panel === id ? 'flex' : 'none';
      });
      try { localStorage.setItem('slate_dock_active', id); } catch (_) {}
    },
    getActive() {
      return localStorage.getItem('slate_dock_active') || (panels[0] && panels[0].id);
    },
    revealPanel(id) {
      const dock = document.getElementById('right-dock');
      if (dock) dock.classList.remove('dock-user-collapsed');
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-w'), 10) || 0;
      if (w < 80) applyDockW(readNum(LS_DOCK, 220));
      window.slateDock.setActive(id);
    },
    toggleCollapsed() {
      const dock = document.getElementById('right-dock');
      if (!dock) return;
      if (dock.classList.contains('dock-user-collapsed')) {
        dock.classList.remove('dock-user-collapsed');
        applyDockW(readNum(LS_DOCK, 220));
      } else {
        dock.classList.add('dock-user-collapsed');
        document.documentElement.style.setProperty('--dock-w', '0px');
      }
    },
  };

  function appendDockPanel(p) {
    const tabs = document.getElementById('dock-tabs');
    const body = document.getElementById('dock-body');
    if (!tabs || !body) return;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'dock-tab';
    tab.dataset.panel = p.id;
    tab.textContent = p.title;
    tab.title = p.title;
    tab.addEventListener('click', () => window.slateDock.setActive(p.id));
    const insertBefore = [...tabs.children].find(ch => {
      const po = panels.find(x => x.id === ch.dataset.panel);
      return (po?.order ?? 999) > p.order;
    });
    if (insertBefore) tabs.insertBefore(tab, insertBefore);
    else tabs.appendChild(tab);

    const mount = document.createElement('div');
    mount.className = 'dock-panel';
    mount.dataset.panel = p.id;
    mount.style.display = 'none';
    mount.style.flexDirection = 'column';
    mount.style.flex = '1';
    mount.style.minHeight = '0';
    mount.style.overflow = 'hidden';
    body.appendChild(mount);
    try { p.mount(mount); } catch (err) { console.error('slateDock mount', p.id, err); }

    const want = window.slateDock.getActive();
    const valid = [...tabs.children].some(t => t.dataset.panel === want);
    window.slateDock.setActive(valid ? want : p.id);
  }

  function boot() {
    applySidebarW(readNum(LS_SIDEBAR, 260));
    applyDockW(readNum(LS_DOCK, 220));
    initSidebarResize();
    initDockResize();
    window.addEventListener('resize', () => {
      applySidebarW(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || readNum(LS_SIDEBAR, 260));
      applyDockW(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-w'), 10) || readNum(LS_DOCK, 220));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
