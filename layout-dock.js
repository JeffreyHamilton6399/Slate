/**
 * layout-dock.js — Left + right resizable docks, shared tab/float model.
 * Panels register with optional side: 'left' | 'right' (default 'right').
 * Tabs can be dragged to the other dock, floated, or redocked from the float edge.
 */
(function slateLayoutDock() {
  'use strict';

  const LS_SIDEBAR = 'slate_layout_sidebar_w';
  const LS_DOCK = 'slate_layout_dock_w';
  const LS_FLOATS = 'slate_dock_floats';
  const LS_ACTIVE_LEFT = 'slate_dock_active_left';
  const LS_ACTIVE_RIGHT = 'slate_dock_active_right';
  const LS_PANEL_SIDES = 'slate_dock_panel_sides';

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
      v = clamp(px, 120, Math.min(520, Math.floor(window.innerWidth * 0.5)));
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
    let startX, startW;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const root = getComputedStyle(document.documentElement);
      const cur = parseInt(root.getPropertyValue('--dock-w'), 10) || readNum(LS_DOCK, 220);
      startX = e.clientX;
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

  const panels = [];
  const floats = new Map();
  const dismissedPanels = new Map();

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

  function _tabsBody(side) {
    if (side === 'left') {
      return {
        tabs: document.getElementById('dock-tabs-left'),
        body: document.getElementById('dock-body-left'),
      };
    }
    return {
      tabs: document.getElementById('dock-tabs'),
      body: document.getElementById('dock-body'),
    };
  }

  function _entry(id) {
    return panels.find(p => p.id === id);
  }

  function _findPanelEl(id) {
    const nodes = document.querySelectorAll(`.dock-panel[data-panel="${id}"]`);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.closest('#dock-dismissed-pool')) continue;
      return el;
    }
    return null;
  }

  function _findTab(id) {
    return document.querySelector(
      `#dock-tabs .dock-tab[data-panel="${id}"], #dock-tabs-left .dock-tab[data-panel="${id}"]`
    );
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
        left: parseInt(win.style.left, 10) || 80,
        top: parseInt(win.style.top, 10) || 80,
        width: parseInt(win.style.width, 10) || 280,
        height: parseInt(win.style.height, 10) || 320,
      };
    });
    try { localStorage.setItem(LS_FLOATS, JSON.stringify(data)); } catch (_) {}
  }

  function _loadFloats() {
    try { return JSON.parse(localStorage.getItem(LS_FLOATS) || '{}'); } catch (_) { return {}; }
  }

  function _lsActiveKey(side) {
    return side === 'left' ? LS_ACTIVE_LEFT : LS_ACTIVE_RIGHT;
  }

  function _readPanelSides() {
    try {
      const raw = localStorage.getItem(LS_PANEL_SIDES);
      const o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function _persistPanelSide(panelId, side) {
    try {
      const o = _readPanelSides();
      o[panelId] = side === 'left' ? 'left' : 'right';
      localStorage.setItem(LS_PANEL_SIDES, JSON.stringify(o));
    } catch (_) {}
  }

  function _initialDockSideForPanel(panelId, defSide) {
    const saved = _readPanelSides()[panelId];
    if (saved === 'left' || saved === 'right') return saved;
    return defSide === 'left' ? 'left' : 'right';
  }

  /** Prefer geometry over elementFromPoint — the dragged tab often sits on top and steals hits. */
  function _pointInElClientRect(x, y, el) {
    if (!el) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
    } catch (_) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** Widen hit targets so tabs snap when dropped near (not only inside) a dock. */
  function _pointNearDockZone(x, y, el, pad) {
    if (!el) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
    } catch (_) {
      return false;
    }
    const r = el.getBoundingClientRect();
    const p = pad || 56;
    return x >= r.left - p && x <= r.right + p && y >= r.top - p && y <= r.bottom + p;
  }

  function _insertTabSorted(tabs, tab, panelId) {
    const po = _entry(panelId);
    const insertBefore = [...tabs.children].find(ch => {
      const p2 = _entry(ch.dataset.panel);
      return (p2?.order ?? 999) > (po?.order ?? 999);
    });
    if (insertBefore) tabs.insertBefore(tab, insertBefore);
    else tabs.appendChild(tab);
  }

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
      const maxLeft = window.innerWidth - win.offsetWidth;
      const maxTop = window.innerHeight - win.offsetHeight;
      win.style.left = clamp(e.clientX - dx, 0, maxLeft) + 'px';
      win.style.top = clamp(e.clientY - dy, 0, maxTop) + 'px';
    });
    bar.addEventListener('pointerup', e => {
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      win.classList.remove('dragging');
      const rect = win.getBoundingClientRect();
      const id = win.dataset.panel;
      if (window.innerWidth - rect.right < 48) {
        window.slateDock.dockPanel(id, 'right');
      } else if (rect.left < 56) {
        window.slateDock.dockPanel(id, 'left');
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
      const w = clamp(startW + (e.clientX - startX), 200, window.innerWidth - 40);
      const h = clamp(startH + (e.clientY - startY), 160, window.innerHeight - 40);
      win.style.width = w + 'px';
      win.style.height = h + 'px';
    });
    handle.addEventListener('pointerup', e => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      _saveFloats();
    });
  }

  function _isMobile() { return window.matchMedia('(max-width: 768px)').matches; }

  function _bindTabDetach(tab, panelId) {
    let down = false;
    let sx = 0, sy = 0, lastX = 0, lastY = 0;
    let beyond = false;
    tab.addEventListener('pointerdown', e => {
      if (e.button !== 0 || _isMobile()) return;
      down = true;
      sx = e.clientX; sy = e.clientY;
      lastX = sx; lastY = sy; beyond = false;
      try { tab.setPointerCapture(e.pointerId); } catch (_) {}
    });
    tab.addEventListener('pointermove', e => {
      if (!down) return;
      lastX = e.clientX; lastY = e.clientY;
      if (Math.hypot(lastX - sx, lastY - sy) > 18) beyond = true;
    });
    tab.addEventListener('pointerup', e => {
      if (!down) return;
      down = false;
      try { tab.releasePointerCapture(e.pointerId); } catch (_) {}
      if (_isMobile() || !beyond) return;
      const fromSide = tab.closest('#dock-tabs-left') ? 'left' : 'right';
      const hit = document.elementFromPoint(lastX, lastY);
      const onFloat = hit && hit.closest && hit.closest('.panel-float');
      const sidebar = document.getElementById('sidebar');
      const rightDock = document.getElementById('right-dock');
      const inSidebar = _pointNearDockZone(lastX, lastY, sidebar, 64);
      const inRightDock = _pointNearDockZone(lastX, lastY, rightDock, 64);
      const geom = {
        left: Math.max(12, Math.min(lastX - 100, window.innerWidth - 312)),
        top: Math.max(52, lastY - 20),
        width: 300,
        height: 360,
      };
      let xfer = null;
      if (!onFloat) {
        if (fromSide === 'right' && inSidebar && !inRightDock) xfer = 'left';
        else if (fromSide === 'left' && inRightDock && !inSidebar) xfer = 'right';
        else if (fromSide === 'right' && inSidebar && inRightDock) {
          const sr = sidebar.getBoundingClientRect();
          const rr = rightDock.getBoundingClientRect();
          const mid = sr.right > rr.left ? (sr.right + rr.left) / 2 : window.innerWidth / 2;
          xfer = lastX < mid ? 'left' : null;
        } else if (fromSide === 'left' && inSidebar && inRightDock) {
          const sr = sidebar.getBoundingClientRect();
          const rr = rightDock.getBoundingClientRect();
          const mid = sr.right > rr.left ? (sr.right + rr.left) / 2 : window.innerWidth / 2;
          xfer = lastX >= mid ? 'right' : null;
        }
      }
      if (xfer === 'left') window.slateDock.transferPanel(panelId, 'left');
      else if (xfer === 'right') window.slateDock.transferPanel(panelId, 'right');
      else window.slateDock.detachPanel(panelId, geom);
      beyond = false;
    });
    tab.addEventListener('pointercancel', () => { down = false; beyond = false; });
    tab.addEventListener('dblclick', ev => {
      ev.preventDefault();
      if (_isMobile()) return;
      if (floats.has(panelId)) return;
      const r = tab.getBoundingClientRect();
      window.slateDock.detachPanel(panelId, {
        left: Math.max(12, r.left),
        top: Math.max(52, r.top + 28),
        width: 300,
        height: 360,
      });
    });
  }

  function appendDockPanel(entry) {
    const defSide = entry.dockSide === 'left' ? 'left' : 'right';
    const side = _initialDockSideForPanel(entry.id, defSide);
    entry.dockSide = side;
    const { tabs, body } = _tabsBody(side);
    if (!tabs || !body) return;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'dock-tab';
    tab.dataset.panel = entry.id;
    tab.textContent = entry.title;
    tab.title = `${entry.title} — click · drag to other dock or float · double-click float`;
    tab.addEventListener('click', () => window.slateDock.setActive(entry.id));
    _bindTabDetach(tab, entry.id);
    _insertTabSorted(tabs, tab, entry.id);

    const mount = document.createElement('div');
    mount.className = 'dock-panel';
    mount.dataset.panel = entry.id;
    mount.style.display = 'none';
    mount.style.flexDirection = 'column';
    mount.style.flex = '1';
    mount.style.minHeight = '0';
    mount.style.overflow = 'hidden';
    body.appendChild(mount);
    try { entry.mount(mount); } catch (err) { console.error('slateDock mount', entry.id, err); }

    const want = localStorage.getItem(_lsActiveKey(side));
    const valid = want && [...tabs.querySelectorAll('.dock-tab')].some(t => t.dataset.panel === want && t.style.display !== 'none');
    if (valid) window.slateDock.setActive(want);
    else window.slateDock.setActive(entry.id);
  }

  window.slateDock = {
    registerPanel(def) {
      ensureLeftDockChrome();
      if (!def || !def.id || !def.title || typeof def.mount !== 'function') return;
      if (panels.some(p => p.id === def.id)) return;
      const entry = {
        ...def,
        order: def.order ?? 100,
        dockSide: def.side === 'left' ? 'left' : 'right',
      };
      panels.push(entry);
      panels.sort((a, b) => (a.order || 0) - (b.order || 0));
      appendDockPanel(entry);
      const savedFloats = _loadFloats();
      if (savedFloats[def.id] && !_isMobile()) {
        requestAnimationFrame(() => window.slateDock.detachPanel(def.id, savedFloats[def.id]));
      }
    },

    transferPanel(id, targetSide) {
      const entry = _entry(id);
      const panelEl = _findPanelEl(id);
      const tab = _findTab(id);
      if (!entry || !panelEl || !tab || floats.has(id)) return;
      const side = targetSide === 'left' ? 'left' : 'right';
      if (entry.dockSide === side) return;
      const dest = _tabsBody(side);
      if (!dest.tabs || !dest.body) return;
      const oldTabs = tab.parentElement;
      tab.remove();
      tab.classList.remove('dock-tab-dismissed');
      tab.style.display = '';
      _insertTabSorted(dest.tabs, tab, id);
      dest.body.appendChild(panelEl);
      entry.dockSide = side;
      _persistPanelSide(id, side);
      window.slateDock.setActive(id);
      requestAnimationFrame(() => {
        try { window.slateDock.setActive(id); } catch (_) {}
      });
      try { window.slateSfx?.play('panel-open'); } catch (_) {}
    },

    setActive(id) {
      if (floats.has(id)) {
        const w = floats.get(id);
        w.style.zIndex = String(_topFloatZ());
        return;
      }
      if (dismissedPanels.has(id)) {
        window.slateDock.detachPanel(id, _defaultFloatGeomBR());
        return;
      }
      const entry = _entry(id);
      if (!entry) return;
      const side = entry.dockSide === 'left' ? 'left' : 'right';
      const { tabs, body } = _tabsBody(side);
      if (!tabs || !body) return;
      tabs.querySelectorAll('.dock-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.panel === id);
      });
      const dockedTarget = body.querySelector(`:scope > .dock-panel[data-panel="${id}"]`);
      const globalPanel = _findPanelEl(id);
      if (dockedTarget) {
        body.querySelectorAll(':scope > .dock-panel').forEach(p => {
          p.style.display = p === dockedTarget ? 'flex' : 'none';
        });
      } else {
        body.querySelectorAll(':scope > .dock-panel').forEach(p => {
          p.style.display = 'none';
        });
      }
      // Panel may live in a float shell while detached from dock chrome.
      if (globalPanel && !floats.has(id) && !dismissedPanels.has(id)) {
        const inFloat = globalPanel.closest('.panel-float-body');
        if (!inFloat && globalPanel.parentElement !== body) {
          globalPanel.style.display = 'flex';
          globalPanel.style.flexDirection = 'column';
          globalPanel.style.flex = '1';
          globalPanel.style.minHeight = '0';
        }
      }
      try { localStorage.setItem(_lsActiveKey(side), id); } catch (_) {}
      try { localStorage.setItem('slate_dock_active', id); } catch (_) {}
    },

    getActive() {
      return localStorage.getItem(LS_ACTIVE_RIGHT) || localStorage.getItem('slate_dock_active')
        || panels.find(p => (p.dockSide || 'right') === 'right')?.id || panels[0]?.id;
    },

    revealPanel(id) {
      if (floats.has(id)) {
        const w = floats.get(id);
        w.style.zIndex = String(_topFloatZ());
        return;
      }
      if (dismissedPanels.has(id)) {
        window.slateDock.detachPanel(id, _defaultFloatGeomBR());
        return;
      }
      const entry = _entry(id);
      if (entry && entry.dockSide !== 'left') {
        const dock = document.getElementById('right-dock');
        if (dock) dock.classList.remove('dock-user-collapsed');
        const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-w'), 10) || 0;
        if (w < 80) applyDockW(readNum(LS_DOCK, 220));
      }
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

    dismissPanel(id) {
      const win = floats.get(id);
      if (!win) return;
      const panelEl = win.querySelector(`.dock-panel[data-panel="${id}"]`);
      if (!panelEl) return;
      panelEl.style.display = 'none';
      _ensureDismissPool().appendChild(panelEl);
      dismissedPanels.set(id, panelEl);
      win.remove();
      floats.delete(id);
      const tab = _findTab(id);
      if (tab) {
        tab.style.display = '';
        tab.classList.add('dock-tab-dismissed');
        tab.title = `${_entry(id)?.title || id} — click to reopen`;
      }
      let next = null;
      for (const s of ['left', 'right']) {
        const { tabs } = _tabsBody(s);
        const t = tabs && [...tabs.children].find(ch => ch.dataset.panel && ch.dataset.panel !== id && ch.style.display !== 'none' && !ch.classList.contains('dock-tab-dismissed'));
        if (t) { next = t.dataset.panel; break; }
      }
      if (next) window.slateDock.setActive(next);
      try { window.slateSfx?.play('panel-close'); } catch (_) {}
      _saveFloats();
    },

    detachPanel(id, geom) {
      if (floats.has(id)) return;
      const def = _entry(id);
      if (!def) return;
      let panelEl = _findPanelEl(id);
      if (!panelEl && dismissedPanels.has(id)) {
        panelEl = dismissedPanels.get(id);
        dismissedPanels.delete(id);
        const tab = _findTab(id);
        tab?.classList.remove('dock-tab-dismissed');
        if (tab) tab.title = `${def.title} — click · drag to other dock or float`;
      }
      if (!panelEl) return;

      const win = document.createElement('div');
      win.className = 'panel-float';
      win.dataset.panel = id;
      const g = geom || _defaultFloatGeomBR();
      win.style.left = g.left + 'px';
      win.style.top = g.top + 'px';
      win.style.width = g.width + 'px';
      win.style.height = g.height + 'px';
      win.style.zIndex = String(_topFloatZ());
      win.innerHTML = `
        <div class="panel-float-bar">
          <span class="panel-float-title">${def.title}</span>
          <button class="panel-float-close" title="Close panel" aria-label="Close panel">×</button>
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

      const tab = _findTab(id);
      if (tab) tab.style.display = 'none';

      _bindFloatDrag(win);
      _bindFloatResize(win);
      win.querySelector('.panel-float-close').addEventListener('click', () => window.slateDock.dismissPanel(id));
      try { window.slateSfx?.play('panel-open'); } catch (_) {}

      let next = null;
      for (const s of ['left', 'right']) {
        const { tabs } = _tabsBody(s);
        const t = tabs && [...tabs.children].find(ch => ch.dataset.panel && ch.dataset.panel !== id && ch.style.display !== 'none');
        if (t) { next = t.dataset.panel; break; }
      }
      if (next) window.slateDock.setActive(next);
      _saveFloats();
    },

    dockPanel(id, explicitSide) {
      const win = floats.get(id);
      if (!win) return;
      const entry = _entry(id);
      const side = explicitSide === 'left' || explicitSide === 'right'
        ? explicitSide
        : (entry?.dockSide === 'left' ? 'left' : 'right');
      const { tabs, body } = _tabsBody(side);
      if (!body) return;
      const panelEl = win.querySelector(`.dock-panel[data-panel="${id}"]`);
      if (panelEl) body.appendChild(panelEl);
      win.remove();
      floats.delete(id);
      if (entry) entry.dockSide = side;
      _persistPanelSide(id, side);
      const tab = _findTab(id);
      if (tab) {
        tab.style.display = '';
        tab.classList.remove('dock-tab-dismissed');
        if (entry) tab.title = `${entry.title} — click · drag to other dock or float`;
      }
      window.slateDock.setActive(id);
      try { window.slateSfx?.play('panel-close'); } catch (_) {}
      _saveFloats();
    },
  };

  /** Ensure left-dock tab strip + body exist inside #left-dock. */
  function ensureLeftDockChrome() {
    if (document.getElementById('dock-tabs-left')) return;
    const aside = document.getElementById('left-dock');
    if (!aside) return;
    const tabs = document.createElement('div');
    tabs.id = 'dock-tabs-left';
    tabs.className = 'dock-tabs dock-left-chrome';
    tabs.setAttribute('aria-label', 'Left tool panels');
    const body = document.createElement('div');
    body.id = 'dock-body-left';
    body.className = 'dock-body dock-left-chrome';
    body.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;';
    aside.appendChild(tabs);
    aside.appendChild(body);
  }

  function boot() {
    ensureLeftDockChrome();
    applySidebarW(readNum(LS_SIDEBAR, 260));
    applyDockW(readNum(LS_DOCK, 220));
    initSidebarResize();
    initDockResize();
    window.addEventListener('resize', () => {
      applySidebarW(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || readNum(LS_SIDEBAR, 260));
      applyDockW(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-w'), 10) || readNum(LS_DOCK, 220));
    });

    window.slateSetLeftDockTab = function (id) {
      let tabId = id === 'scene' || id === 'boards' ? id : 'scene';
      if (document.body.classList.contains('mode-2d') && tabId === 'scene') tabId = 'boards';
      try { localStorage.setItem('slate_left_dock_tab', tabId); } catch (_) {}
      const m = { scene: 'hierarchy', boards: 'boards' };
      const pid = m[tabId] || 'hierarchy';
      if (window.slateDock && typeof window.slateDock.setActive === 'function') {
        try { window.slateDock.setActive(pid); } catch (_) {}
      }
    };

    try {
      const saved = localStorage.getItem('slate_left_dock_tab');
      window.slateSetLeftDockTab(saved === 'boards' ? 'boards' : 'scene');
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
