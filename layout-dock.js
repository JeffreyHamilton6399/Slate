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
    const mobile = window.matchMedia('(max-width: 768px)').matches;
    let v;
    if (mobile) {
      v = clamp(px, 0, Math.min(420, Math.floor(window.innerWidth * 0.5)));
    } else {
      v = clamp(px, 120, Math.min(520, Math.floor(window.innerHeight * 0.62)));
    }
    document.documentElement.style.setProperty('--dock-w', v + 'px');
    try { localStorage.setItem(LS_DOCK, String(v)); } catch (_) {}
    const dock = document.getElementById('right-dock');
    if (dock) dock.classList.toggle('dock-collapsed', mobile ? v < 8 : v < 24);
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
    let startX, startY, startW;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const root = getComputedStyle(document.documentElement);
      const cur = parseInt(root.getPropertyValue('--dock-w'), 10) || readNum(LS_DOCK, 220);
      if (window.matchMedia('(max-width: 768px)').matches) {
        startX = e.clientX;
        startW = cur;
      } else {
        startY = e.clientY;
        startW = cur;
      }
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      if (window.matchMedia('(max-width: 768px)').matches) {
        const dx = startX - e.clientX;
        applyDockW(startW + dx);
      } else {
        const dy = startY - e.clientY;
        applyDockW(startW + dy);
      }
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
  /** id -> floating window element (only set while floating) */
  const floats = new Map();
  /** id -> panel element hidden after user closed a floating panel (×). */
  const dismissedPanels = new Map();
  const LS_FLOATS = 'slate_dock_floats';

  function _ensureDismissPool() {
    let el = document.getElementById('dock-dismissed-pool');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dock-dismissed-pool';
      el.setAttribute('hidden', '');
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return el;
  }

  function _defaultFloatGeomBR() {
    const w = 300;
    const h = 340;
    return {
      left: Math.max(12, window.innerWidth - w - 18),
      top: Math.max(52, window.innerHeight - h - 20),
      width: w,
      height: h,
    };
  }

  function _saveFloats() {
    const data = {};
    floats.forEach((win, id) => {
      data[id] = {
        left:   parseInt(win.style.left, 10)   || 80,
        top:    parseInt(win.style.top, 10)    || 80,
        width:  parseInt(win.style.width, 10)  || 280,
        height: parseInt(win.style.height, 10) || 320,
      };
    });
    try { localStorage.setItem(LS_FLOATS, JSON.stringify(data)); } catch (_) {}
  }
  function _loadFloats() {
    try { return JSON.parse(localStorage.getItem(LS_FLOATS) || '{}'); } catch (_) { return {}; }
  }

  window.slateDock = {
    registerPanel(def) {
      if (!def || !def.id || !def.title || typeof def.mount !== 'function') return;
      if (panels.some(p => p.id === def.id)) return;
      panels.push({ ...def, order: def.order ?? 100 });
      panels.sort((a, b) => (a.order || 0) - (b.order || 0));
      appendDockPanel(def);
      // Restore floating state if it was floating before — desktop only;
      // on mobile, floating panels are confusing so we keep things docked.
      const savedFloats = _loadFloats();
      if (savedFloats[def.id] && !window.matchMedia('(max-width: 768px)').matches) {
        requestAnimationFrame(() => window.slateDock.detachPanel(def.id, savedFloats[def.id]));
      }
    },
    setActive(id) {
      // If the target panel is currently floating, just bring it to the front
      // instead of toggling dock tabs (and leave the previously active dock
      // panel alone so the user keeps their context).
      if (floats.has(id)) {
        const w = floats.get(id);
        w.style.zIndex = String(_topFloatZ());
        return;
      }
      if (dismissedPanels.has(id)) {
        window.slateDock.detachPanel(id, _defaultFloatGeomBR());
        return;
      }
      const tabs = document.getElementById('dock-tabs');
      if (!tabs) return;
      tabs.querySelectorAll('.dock-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.panel === id);
      });
      const body = document.getElementById('dock-body');
      if (!body) return;
      body.querySelectorAll('.dock-panel').forEach(p => {
        // Don't override floating panels' display (they're parented elsewhere).
        if (p.parentElement === body) {
          p.style.display = p.dataset.panel === id ? 'flex' : 'none';
        }
      });
      try { localStorage.setItem('slate_dock_active', id); } catch (_) {}
    },
    getActive() {
      return localStorage.getItem('slate_dock_active') || (panels[0] && panels[0].id);
    },
    revealPanel(id) {
      // If panel is floating, just focus the floating window.
      if (floats.has(id)) {
        const w = floats.get(id);
        w.style.zIndex = String(_topFloatZ());
        return;
      }
      if (dismissedPanels.has(id)) {
        window.slateDock.detachPanel(id, _defaultFloatGeomBR());
        return;
      }
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
        try { window.slateSfx?.play('panel-open'); } catch (_) {}
      } else {
        dock.classList.add('dock-user-collapsed');
        document.documentElement.style.setProperty('--dock-w', '0px');
        try { window.slateSfx?.play('panel-close'); } catch (_) {}
      }
    },
    /** Pop a docked panel out into a floating window (Photoshop-style). */
    dismissPanel(id) {
      const win = floats.get(id);
      if (!win) return;
      const tabs = document.getElementById('dock-tabs');
      const panelEl = win.querySelector(`.dock-panel[data-panel="${id}"]`);
      if (!panelEl) return;
      panelEl.style.display = 'none';
      _ensureDismissPool().appendChild(panelEl);
      dismissedPanels.set(id, panelEl);
      win.remove();
      floats.delete(id);
      const tab = tabs?.querySelector(`.dock-tab[data-panel="${id}"]`);
      if (tab) {
        tab.style.display = '';
        tab.classList.add('dock-tab-dismissed');
        tab.title = `${panels.find(p => p.id === id)?.title || id} — click to reopen`;
      }
      const stillVisible = tabs && [...tabs.children].find(t => t.style.display !== 'none' && t.dataset.panel !== id);
      if (stillVisible) window.slateDock.setActive(stillVisible.dataset.panel);
      try { window.slateSfx?.play('panel-close'); } catch (_) {}
      _saveFloats();
    },
    detachPanel(id, geom) {
      if (floats.has(id)) return;
      const def = panels.find(p => p.id === id);
      if (!def) return;
      const body = document.getElementById('dock-body');
      const tabs = document.getElementById('dock-tabs');
      if (!body || !tabs) return;
      let panelEl = body.querySelector(`.dock-panel[data-panel="${id}"]`);
      if (!panelEl && dismissedPanels.has(id)) {
        panelEl = dismissedPanels.get(id);
        dismissedPanels.delete(id);
        const tab = tabs.querySelector(`.dock-tab[data-panel="${id}"]`);
        tab?.classList.remove('dock-tab-dismissed');
        if (tab) tab.title = `${def.title} — click to focus · drag to float · double-click to pop out`;
      }
      if (!panelEl) return;

      const win = document.createElement('div');
      win.className = 'panel-float';
      win.dataset.panel = id;
      const g = geom || _defaultFloatGeomBR();
      win.style.left   = g.left + 'px';
      win.style.top    = g.top + 'px';
      win.style.width  = g.width + 'px';
      win.style.height = g.height + 'px';
      win.style.zIndex = String(_topFloatZ());
      win.innerHTML = `
        <div class="panel-float-bar">
          <span class="panel-float-title">${def.title}</span>
          <button class="panel-float-close" title="Close panel (reopen from dock tab)" aria-label="Close panel">×</button>
        </div>
        <div class="panel-float-body"></div>
        <div class="panel-float-resize" title="Drag to resize"></div>
      `;
      const fbody = win.querySelector('.panel-float-body');
      fbody.appendChild(panelEl);
      panelEl.style.display = 'flex';
      panelEl.style.flex = '1';
      panelEl.style.minHeight = '0';
      document.body.appendChild(win);
      floats.set(id, win);

      // Hide the dock tab for this panel while floating; redock returns it.
      const tab = tabs.querySelector(`.dock-tab[data-panel="${id}"]`);
      if (tab) tab.style.display = 'none';

      _bindFloatDrag(win);
      _bindFloatResize(win);
      win.querySelector('.panel-float-close').addEventListener('click', () => window.slateDock.dismissPanel(id));
      try { window.slateSfx?.play('panel-open'); } catch (_) {}

      // If detached panel was active, switch the dock to a different one.
      const stillVisible = [...tabs.children].find(t => t.style.display !== 'none' && t.dataset.panel !== id);
      if (stillVisible) window.slateDock.setActive(stillVisible.dataset.panel);
      _saveFloats();
    },
    /** Return a floating panel back into the dock body. */
    dockPanel(id) {
      const win = floats.get(id);
      if (!win) return;
      const body = document.getElementById('dock-body');
      const tabs = document.getElementById('dock-tabs');
      if (!body) return;
      const panelEl = win.querySelector(`.dock-panel[data-panel="${id}"]`);
      if (panelEl) body.appendChild(panelEl);
      win.remove();
      floats.delete(id);
      const tab = tabs?.querySelector(`.dock-tab[data-panel="${id}"]`);
      if (tab) {
        tab.style.display = '';
        tab.classList.remove('dock-tab-dismissed');
        const def = panels.find(p => p.id === id);
        if (def) tab.title = `${def.title} — click to focus · drag to float · double-click to pop out`;
      }
      window.slateDock.setActive(id);
      try { window.slateSfx?.play('panel-close'); } catch (_) {}
      _saveFloats();
    },
  };

  let _floatZ = 200;
  function _topFloatZ() { return ++_floatZ; }

  function _bindFloatDrag(win) {
    const bar = win.querySelector('.panel-float-bar');
    let dx = 0, dy = 0;
    bar.addEventListener('pointerdown', e => {
      if (e.target.closest('.panel-float-close')) return;
      bar.setPointerCapture(e.pointerId);
      win.style.zIndex = String(_topFloatZ());
      const rect = win.getBoundingClientRect();
      dx = e.clientX - rect.left; dy = e.clientY - rect.top;
      win.classList.add('dragging');
    });
    bar.addEventListener('pointermove', e => {
      if (!bar.hasPointerCapture(e.pointerId)) return;
      const maxLeft = window.innerWidth  - win.offsetWidth;
      const maxTop  = window.innerHeight - win.offsetHeight;
      win.style.left = clamp(e.clientX - dx, 0, maxLeft) + 'px';
      win.style.top  = clamp(e.clientY - dy, 0, maxTop)  + 'px';
    });
    bar.addEventListener('pointerup', e => {
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      win.classList.remove('dragging');
      // If dropped near the right edge of the viewport, redock automatically.
      const rect = win.getBoundingClientRect();
      if (window.innerWidth - rect.right < 40) {
        window.slateDock.dockPanel(win.dataset.panel);
      } else {
        _saveFloats();
      }
    });
    bar.addEventListener('pointercancel', () => win.classList.remove('dragging'));
  }
  function _bindFloatResize(win) {
    const handle = win.querySelector('.panel-float-resize');
    let startX, startY, startW, startH;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const rect = win.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const w = clamp(startW + (e.clientX - startX), 200, window.innerWidth  - 40);
      const h = clamp(startH + (e.clientY - startY), 160, window.innerHeight - 40);
      win.style.width  = w + 'px';
      win.style.height = h + 'px';
    });
    handle.addEventListener('pointerup', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      _saveFloats();
    });
  }

  function appendDockPanel(p) {
    const tabs = document.getElementById('dock-tabs');
    const body = document.getElementById('dock-body');
    if (!tabs || !body) return;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'dock-tab';
    tab.dataset.panel = p.id;
    tab.textContent = p.title;
    tab.title = `${p.title} — click to focus · drag to float · double-click to pop out`;
    tab.addEventListener('click', () => window.slateDock.setActive(p.id));
    _bindTabDetach(tab);
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

  /* A small drag-distance threshold on tab pointer events lets us tell apart
     "click to activate" from "drag to detach". Detaching is disabled below
     the mobile breakpoint where the dock slides in/out instead. */
  function _isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function _bindTabDetach(tab) {
    let downX = 0, downY = 0, isDown = false;
    tab.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (_isMobile()) return;
      isDown = true; downX = e.clientX; downY = e.clientY;
    });
    tab.addEventListener('pointermove', e => {
      if (!isDown) return;
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (Math.hypot(dx, dy) > 18) {
        isDown = false;
        const id = tab.dataset.panel;
        window.slateDock.detachPanel(id, {
          left: Math.max(12, Math.min(e.clientX - 100, window.innerWidth - 312)),
          top: Math.max(52, e.clientY - 20),
          width: 300,
          height: 360,
        });
      }
    });
    tab.addEventListener('pointerup', () => { isDown = false; });
    tab.addEventListener('pointercancel', () => { isDown = false; });
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (_isMobile()) return;
      const id = tab.dataset.panel;
      if (floats.has(id)) return;
      const r = tab.getBoundingClientRect();
      window.slateDock.detachPanel(id, {
        left: Math.max(12, r.left),
        top: Math.max(52, r.top + 28),
        width: 300,
        height: 360,
      });
    });
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
