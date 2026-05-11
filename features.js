/**
 * features.js — Pro art-tool features for Slate.
 * Loaded after the main inline script (and layout-dock.js when served via server.js).
 * Shares the same browser global scope as index.html scripts,
 * so top-level vars (doc, vp, canvas, ctx, genId, etc.) are directly accessible.
 */
(function slateFeatures() {

/* ─────────────────────────────────────────────────────────────────────────
   GLOBAL CSS for new features
───────────────────────────────────────────────────────────────────────── */
const featureCSS = document.createElement('style');
featureCSS.textContent = `
  #opacity-wrap { display:flex;align-items:center;gap:5px;flex-shrink:0;padding:0 6px; }
  #opacity-slider { width:54px;accent-color:var(--accent);cursor:pointer; }
  #opacity-label  { font-size:0.68rem;color:var(--text-dim);min-width:26px;text-align:right;
                    font-family:var(--mono,'monospace'); }
  #minimap-wrap { position:absolute;bottom:16px;right:16px;z-index:30;
    border:1px solid var(--border2);border-radius:8px;overflow:hidden;
    box-shadow:0 4px 20px rgba(0,0,0,.5);transition:opacity .2s;cursor:crosshair; }
  #minimap-wrap:hover { opacity:1 !important; }
  @media (max-width:768px) {
    #minimap-wrap {
      bottom: calc(70px + env(safe-area-inset-bottom, 0px)) !important;
      right: max(10px, env(safe-area-inset-right, 0px)) !important;
      border-radius: 12px;
      opacity: 0.96 !important;
      max-width: min(220px, 46vw);
      box-shadow: 0 8px 28px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.05);
    }
    #minimap-cvs { display: block; width: 100%; height: auto; border-radius: 10px; }
  }

  #layers-panel { position:absolute;top:56px;right:16px;z-index:30;width:164px;
    border:1px solid var(--border2);border-radius:8px;background:var(--bg2);
    box-shadow:0 4px 20px rgba(0,0,0,.5);flex-direction:column;overflow:hidden; }
  #dock-body #layers-panel,
  .dock-panel #layers-panel {
    position: relative !important; top: auto !important; right: auto !important;
    width: 100% !important; max-width: none !important; z-index: 1;
    box-shadow: none; flex: 1; min-height: 0; border-radius: 0; border: none;
    border-top: 1px solid var(--border);
  }
  .layer-row { display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;
    font-size:0.78rem;border-left:2px solid transparent;transition:background .1s,border-color .1s;
    border-top:2px solid transparent; }
  .layer-row:hover { background:var(--bg3); }
  .layer-row:hover .layer-del-btn { opacity: 1 !important; }
  .layer-row.layer-drop-target { border-top-color: var(--accent) !important; }
  .layer-vis-btn { background:none;border:none;padding:0;cursor:pointer;flex-shrink:0;line-height:1; }
  .layer-del-btn { transition: opacity .12s, color .12s; }
  .layer-del-btn:hover { color: var(--danger) !important; opacity:1 !important; }

  #shortcuts-overlay { position:fixed;inset:0;z-index:9000;
    background:rgba(0,0,0,.75);backdrop-filter:blur(4px);
    display:none;align-items:center;justify-content:center; }
  #shortcuts-overlay.open { display:flex; }
  #shortcuts-box { background:var(--bg2);border:1px solid var(--border2);border-radius:14px;
    padding:28px 32px;max-width:600px;width:90vw;max-height:80vh;overflow-y:auto;
    box-shadow:0 20px 60px rgba(0,0,0,.6); }
  #shortcuts-box kbd { font-family:var(--mono,'monospace');font-size:.7rem;padding:2px 6px;
    border-radius:4px;background:var(--bg3);border:1px solid var(--border2);
    color:var(--text);white-space:nowrap;flex-shrink:0; }
  .sc-row { display:flex;align-items:center;gap:8px;padding:4px 0;
    border-bottom:1px solid var(--border);font-size:.8rem;color:var(--text-mid); }
  .sc-head { grid-column:1/-1;margin-top:12px;margin-bottom:4px;font-size:.65rem;
    font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.12em; }

  #layers-toolbar-btn { display:flex;flex-shrink:0;align-items:center;gap:5px;
    padding:6px 11px;border-radius:6px;font-size:.78rem;font-weight:500;
    background:var(--bg3);border:1px solid var(--border2);color:var(--text-mid);
    cursor:pointer;transition:background .15s,color .15s,border-color .15s; }
  #layers-toolbar-btn.active { color:var(--accent);background:rgba(124,106,255,.1);
    border-color:rgba(124,106,255,.4); }
  #shortcuts-hint-btn { font-size:.85rem;font-weight:600;color:var(--text-dim); }
  #zoom-label { cursor:pointer; }
  #zoom-label:hover { color:var(--accent); }
`;
document.head.appendChild(featureCSS);


/* ─────────────────────────────────────────────────────────────────────────
   OPACITY CONTROL
───────────────────────────────────────────────────────────────────────── */
let _opacity = 1;

function injectOpacityControl() {
  if (document.getElementById('opacity-wrap')) return;
  const toolbar = document.getElementById('draw-toolbar');
  if (!toolbar) return;
  const wrap = document.createElement('div');
  wrap.id = 'opacity-wrap';
  wrap.title = 'Opacity';
  wrap.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="opacity:.5;flex-shrink:0">
      <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.4"/>
      <path d="M6 1v10" stroke="currentColor" stroke-width="1.4"/>
      <path d="M1 6a5 5 0 0 1 5-5v10A5 5 0 0 1 1 6z" fill="currentColor" opacity=".4"/>
    </svg>
    <input id="opacity-slider" type="range" min="5" max="100" value="100" title="Opacity">
    <span id="opacity-label">100%</span>
  `;
  toolbar.appendChild(wrap);
  document.getElementById('opacity-slider').addEventListener('input', e => {
    _opacity = parseInt(e.target.value) / 100;
    document.getElementById('opacity-label').textContent = e.target.value + '%';
  });
}

// Inject opacity onto stroke as soon as pointerdown starts (bubble phase = after main listener)
document.getElementById('board-canvas')?.addEventListener('pointerdown', () => {
  if (typeof currentStroke !== 'undefined' && currentStroke && _opacity < 1) {
    currentStroke._opacity = _opacity;
  }
}, false);

// Look up a layer by id from the canonical doc.layers (synced across peers).
function _findLayer(id) {
  const layers = (typeof doc !== 'undefined' && doc.layers) ? doc.layers : null;
  if (!layers) return null;
  return layers.find(l => l.id === id) || null;
}

// Patch drawStroke: layer visibility check (outermost) → opacity → Catmull-Rom smoothing
// Layer check MUST be outermost so hidden-layer strokes never reach the render path.
const _drawStrokeBase = window.drawStroke;
if (_drawStrokeBase) {
  // Inner wrapper: opacity + Catmull-Rom
  const _drawStrokeOpacity = function (s) {
    if (!s) { _drawStrokeBase.call(this, s); return; }
    const op = (s._opacity != null) ? s._opacity : 1;
    // Smooth pen strokes with Catmull-Rom spline (skip highlighter / short strokes)
    if (s.points && s.points.length >= 4 && !s.highlighter) {
      ctx.save();
      if (op < 1) ctx.globalAlpha = op;
      ctx.strokeStyle = s.color || '#1a1a2e';
      ctx.lineWidth   = s.size || 4;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      const pts = s.points;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
        const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (op < 1) { ctx.save(); ctx.globalAlpha = op; _drawStrokeBase.call(this, s); ctx.restore(); }
    else _drawStrokeBase.call(this, s);
  };
  // Outer wrapper: layer gate (checked first, every time)
  window.drawStroke = function (s) {
    if (s && s._layer) {
      const layer = _findLayer(s._layer);
      if (layer && !layer.visible) return; // hidden layer → skip entirely
    }
    _drawStrokeOpacity.call(this, s);
  };
  window.drawStroke._layerPatched = true;
}

// Patch drawShape for opacity + layer visibility
const _drawShapeBase = window.drawShape;
if (_drawShapeBase) {
  window.drawShape = function (s, preview) {
    if (s && s._layer) {
      const layer = _findLayer(s._layer);
      if (layer && !layer.visible) return;
    }
    const op = (s && s._opacity != null) ? s._opacity : 1;
    if (op < 1) { ctx.save(); ctx.globalAlpha = op; _drawShapeBase.call(this, s, preview); ctx.restore(); }
    else _drawShapeBase.call(this, s, preview);
  };
  window.drawShape._layerPatched = true;
}

function _layerGate(s) {
  if (!s || !s._layer) return true;
  const layer = _findLayer(s._layer);
  return !layer || layer.visible;
}

const _drawStrokeOnBase = window.drawStrokeOn;
if (_drawStrokeOnBase) {
  window.drawStrokeOn = function (c, s) {
    if (!_layerGate(s)) return;
    return _drawStrokeOnBase.call(this, c, s);
  };
}
const _drawShapeOnBase = window.drawShapeOn;
if (_drawShapeOnBase) {
  window.drawShapeOn = function (c, s) {
    if (!_layerGate(s)) return;
    return _drawShapeOnBase.call(this, c, s);
  };
}


/* ─────────────────────────────────────────────────────────────────────────
   COPY / PASTE / DUPLICATE / CUT / SELECT-ALL
───────────────────────────────────────────────────────────────────────── */
let _clipboard = [];

document.addEventListener('keydown', handleEditShortcuts, true);

function handleEditShortcuts(e) {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  // Copy
  if (e.ctrlKey && e.key === 'c') {
    if (typeof selItems === 'undefined' || !selItems.length) return;
    _clipboard = collectSelected();
    if (_clipboard.length) showToast(_clipboard.length + ' item' + (_clipboard.length > 1 ? 's' : '') + ' copied');
    e.preventDefault(); e.stopPropagation();
  }
  // Cut
  if (e.ctrlKey && e.key === 'x') {
    if (typeof selItems === 'undefined' || !selItems.length) return;
    _clipboard = collectSelected();
    if (typeof deleteSelectedItems === 'function') deleteSelectedItems();
    if (_clipboard.length) showToast(_clipboard.length + ' item' + (_clipboard.length > 1 ? 's' : '') + ' cut');
    e.preventDefault(); e.stopPropagation();
  }
  // Paste
  if (e.ctrlKey && e.key === 'v') {
    if (!_clipboard.length) return;
    doPaste(_clipboard, 24);
    e.preventDefault(); e.stopPropagation();
  }
  // Duplicate
  if (e.ctrlKey && e.key === 'd') {
    e.preventDefault(); e.stopPropagation();
    if (typeof selItems === 'undefined' || !selItems.length) return;
    doPaste(collectSelected(), 20);
  }
  // Select all
  if (e.ctrlKey && e.key === 'a') {
    e.preventDefault(); e.stopPropagation();
    if (typeof setTool === 'function') setTool('select');
    if (typeof selItems !== 'undefined') {
      selItems.length = 0;
      if (typeof doc !== 'undefined') {
        doc.shapes.forEach((_, id) => selItems.push({ kind: 'shape',  id }));
        doc.strokes.forEach((_, id) => selItems.push({ kind: 'stroke', id }));
      }
      if (typeof scheduleRender === 'function') scheduleRender();
      showToast('All items selected');
    }
  }
  // Zoom shortcuts
  if (!e.ctrlKey && !e.metaKey && (e.key === '=' || e.key === '+')) {
    if (typeof setZoom === 'function' && typeof vp !== 'undefined') { setZoom(vp.zoom * 1.2); e.preventDefault(); }
  }
  if (!e.ctrlKey && !e.metaKey && e.key === '-') {
    if (typeof setZoom === 'function' && typeof vp !== 'undefined') { setZoom(vp.zoom / 1.2); e.preventDefault(); }
  }
  if (e.ctrlKey && e.key === '0') {
    if (typeof fitViewport === 'function') { fitViewport(); if (typeof scheduleRender === 'function') scheduleRender(); }
    e.preventDefault();
  }
  // Shortcuts overlay
  if (e.key === '?') {
    const overlay = document.getElementById('shortcuts-overlay');
    if (overlay) { overlay.classList.toggle('open'); e.preventDefault(); }
  }
  // Toggle minimap
  if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey) {
    const mm = document.getElementById('minimap-wrap');
    if (mm) {
      const shown = mm.style.display !== 'none';
      mm.style.display = shown ? 'none' : 'block';
      showToast(shown ? 'Minimap hidden  (M)' : 'Minimap — click to navigate');
      e.preventDefault();
    }
  }
  // Toggle layers panel
  if (e.key === 'F2') {
    toggleLayersPanel();
    e.preventDefault();
  }
}

function collectSelected() {
  if (typeof selItems === 'undefined' || !selItems.length || typeof doc === 'undefined') return [];
  return selItems.map(it => {
    if (it.kind === 'shape')  { const s = doc.shapes.get(it.id);  return s ? { ...s } : null; }
    if (it.kind === 'stroke') { const s = doc.strokes.get(it.id); return s ? { ...s, points: s.points.map(p => [...p]) } : null; }
    return null;
  }).filter(Boolean);
}

function doPaste(items, offset) {
  if (!items.length) return;
  const newSel = [];
  const layerId = typeof window.__slateActiveLayerId === 'string' ? window.__slateActiveLayerId : null;
  items.forEach(item => {
    const newId = genId();
    if (item.points) {
      const s = { ...item, id: newId, t: Date.now(),
        points: item.points.map(([x, y]) => [x + offset, y + offset]) };
      if (layerId) s._layer = layerId;
      // Use exposed API if available, else directly set
      if (typeof docApplyShape === 'function' && !s.points) {
        docApplyShape(s);
      } else {
        doc.strokes.set(newId, s);
        if (typeof pendingDiff !== 'undefined' && pendingDiff.strokes) pendingDiff.strokes.push({ ...s });
      }
      newSel.push({ kind: 'stroke', id: newId });
    } else {
      const s = { ...item, id: newId, t: Date.now(), x: (item.x || 0) + offset, y: (item.y || 0) + offset };
      if (layerId) s._layer = layerId;
      if (typeof docApplyShape === 'function') docApplyShape(s);
      else {
        doc.shapes.set(newId, s);
        if (typeof pendingDiff !== 'undefined' && pendingDiff.added) pendingDiff.added.push({ ...s });
      }
      newSel.push({ kind: 'shape', id: newId });
    }
  });
  if (typeof scheduleDiff === 'function') scheduleDiff();
  if (typeof invalidateStatic === 'function') invalidateStatic();
  if (typeof scheduleRender === 'function') scheduleRender();
  // Select pasted items
  if (typeof selItems !== 'undefined' && typeof setTool === 'function') {
    setTool('select');
    selItems.length = 0;
    newSel.forEach(i => selItems.push(i));
    scheduleRender();
  }
}


/* Color history removed — Photoshop-style FG/BG widget lives in index.html. */
try { localStorage.removeItem('slate_color_history'); } catch (_) {}


/* ─────────────────────────────────────────────────────────────────────────
   MINIMAP
───────────────────────────────────────────────────────────────────────── */
function injectMinimap() {
  if (document.getElementById('minimap-wrap')) return;
  const area = document.getElementById('canvas-area');
  if (!area) return;

  const wrap = document.createElement('div');
  wrap.id = 'minimap-wrap';
  wrap.style.cssText = 'display:none;opacity:0.82;';
  wrap.innerHTML = '<canvas id="minimap-cvs" width="180" height="110"></canvas>';
  area.appendChild(wrap);

  document.getElementById('minimap-cvs').addEventListener('click', minimapClick);
  setInterval(renderMinimap, 300);
}

function minimapClick(e) {
  if (typeof vp === 'undefined' || typeof WORLD_W === 'undefined') return;
  const mc = e.currentTarget;
  const rect = mc.getBoundingClientRect();
  const mx = (e.clientX - rect.left) / rect.width;
  const my = (e.clientY - rect.top)  / rect.height;
  const wx = mx * WORLD_W - WORLD_W / 2;
  const wy = my * WORLD_H - WORLD_H / 2;
  vp.panX = canvas.width  / 2 - wx * vp.zoom;
  vp.panY = canvas.height / 2 - wy * vp.zoom;
  if (typeof clampViewport === 'function') clampViewport();
  if (typeof scheduleRender === 'function') scheduleRender();
}

function renderMinimap() {
  const mm = document.getElementById('minimap-cvs');
  const wrap = document.getElementById('minimap-wrap');
  if (!mm || !wrap || wrap.style.display === 'none') return;
  if (typeof doc === 'undefined' || typeof vp === 'undefined' || typeof WORLD_W === 'undefined') return;

  const mobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
  const logW = mobile ? Math.min(200, Math.max(120, wrap.clientWidth - 2 || 150)) : 180;
  const logH = Math.round(logW * (110 / 180));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.max(1, Math.floor(logW * dpr));
  const bh = Math.max(1, Math.floor(logH * dpr));
  if (mm.width !== bw || mm.height !== bh) {
    mm.width = bw;
    mm.height = bh;
    mm.style.width = logW + 'px';
    mm.style.height = logH + 'px';
  }

  const mc = mm.getContext('2d');
  mc.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = logW;
  const H = logH;
  const scX = W / WORLD_W, scY = H / WORLD_H;
  const offX = WORLD_W / 2, offY = WORLD_H / 2;

  mc.fillStyle = (typeof PAPER_COLOR !== 'undefined') ? PAPER_COLOR : '#f8f7f4';
  mc.fillRect(0, 0, W, H);

  doc.strokes.forEach(s => {
    if (s._layer) {
      const layer = _findLayer(s._layer);
      if (layer && !layer.visible) return;
    }
    if (!s.points?.length) return;
    mc.strokeStyle = s.color || '#333';
    mc.lineWidth = Math.max(0.5, (s.size || 2) * scX * 3);
    mc.globalAlpha = Math.min(1, (s._opacity || 1) * 0.7);
    mc.beginPath();
    s.points.forEach(([px, py], i) => {
      const x = (px + offX) * scX, y = (py + offY) * scY;
      i === 0 ? mc.moveTo(x, y) : mc.lineTo(x, y);
    });
    mc.stroke();
  });

  mc.globalAlpha = 1;
  doc.shapes.forEach(s => {
    if (s._layer) {
      const layer = _findLayer(s._layer);
      if (layer && !layer.visible) return;
    }
    if (s.type === 'image' || s.type === 'text') return;
    mc.fillStyle = s.fill || s.color || '#666';
    mc.globalAlpha = (s._opacity || 1) * 0.5;
    const x = ((s.x || 0) + offX) * scX;
    const y = ((s.y || 0) + offY) * scY;
    const w = Math.abs((s.w || 10) * scX) || 2;
    const h = Math.abs((s.h || 10) * scY) || 2;
    mc.fillRect(Math.min(x, x + (s.w || 0) * scX), Math.min(y, y + (s.h || 0) * scY), w, h);
  });

  mc.globalAlpha = 1;
  // Viewport rect
  if (typeof canvas !== 'undefined') {
    const vpWx = (-vp.panX / vp.zoom);
    const vpWy = (-vp.panY / vp.zoom);
    const vpW  = canvas.width  / vp.zoom * scX;
    const vpH  = canvas.height / vp.zoom * scY;
    const vpX  = (vpWx + offX) * scX;
    const vpY  = (vpWy + offY) * scY;
    mc.strokeStyle = 'rgba(124,106,255,0.9)';
    mc.lineWidth = 1.5;
    mc.strokeRect(vpX, vpY, vpW, vpH);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   LAYERS — Photoshop-style panel: add, rename (dblclick), reorder (drag),
   delete (trash), visibility toggle, active layer. Backed by doc.layers
   (synced across all peers via doc-snap + doc-diff).
───────────────────────────────────────────────────────────────────────── */
function _initActiveLayer() {
  const layers = (typeof doc !== 'undefined' && doc.layers) ? doc.layers : null;
  if (!layers || !layers.length) return;
  if (!layers.some(l => l.id === window.__slateActiveLayerId)) {
    window.__slateActiveLayerId = layers[0].id;
  }
}
_initActiveLayer();

function injectLayersPanel() {
  if (document.getElementById('layers-panel')) return;

  function buildPanel(parentEl) {
    const panel = document.createElement('div');
    panel.id = 'layers-panel';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.innerHTML = `
    <div style="padding:8px 10px 6px;font-size:.68rem;font-weight:600;color:var(--text-dim);
      letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border);
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      Layers
      <button id="layers-add-btn" title="Add layer" style="background:none;border:none;
        color:var(--text-mid);cursor:pointer;font-size:15px;padding:0 4px;line-height:1">+</button>
    </div>
    <div id="layers-list" style="flex:1;min-height:0;overflow-y:auto"></div>
  `;
    parentEl.appendChild(panel);
    renderLayersList();
    document.getElementById('layers-add-btn').addEventListener('click', () => {
      window.slateLayers?.add();
      renderLayersList();
    });
  }

  if (window.slateDock && typeof window.slateDock.registerPanel === 'function') {
    window.slateDock.registerPanel({
      id: 'layers',
      title: 'Layers',
      order: 100,
      mount(el) {
        buildPanel(el);
      },
    });
    return;
  }

  const area = document.getElementById('canvas-area');
  if (!area) return;
  buildPanel(area);
  const panel = document.getElementById('layers-panel');
  if (panel) panel.style.display = 'none';
}

function renderLayersList() {
  const list = document.getElementById('layers-list');
  if (!list) return;
  const api = window.slateLayers;
  const layers = api?.list || [];
  const activeId = api?.activeId;

  list.innerHTML = layers.map(l => {
    const active = l.id === activeId;
    const op = typeof l.opacity === 'number' && Number.isFinite(l.opacity) ? Math.round(l.opacity * 100) : 100;
    return `<div class="layer-row" draggable="true" data-lid="${l.id}" style="
      background:${active ? 'var(--bg4)' : 'transparent'};
      border-left-color:${active ? 'var(--accent)' : 'transparent'};
      color:${l.visible ? 'var(--text)' : 'var(--text-dim)'};
    ">
      <button class="layer-vis-btn" data-lid="${l.id}" title="Toggle visibility"
        style="color:${l.visible ? 'var(--text-mid)' : 'var(--border2)'}">
        ${l.visible
          ? `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="6.5" cy="6.5" rx="5.5" ry="3.5"/><circle cx="6.5" cy="6.5" r="2"/></svg>`
          : `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4"><line x1="2" y1="2" x2="11" y2="11"/><path d="M4.5 4.5a5 5 0 0 0-3 2 5.5 5.5 0 0 0 9 1M8 3.5A5.5 5.5 0 0 1 12 6.5"/></svg>`
        }
      </button>
      <span class="layer-name" data-lid="${l.id}" draggable="false" title="Double-click to rename" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.78rem;user-select:none;cursor:text">${_escape(l.name)}</span>
      <input type="range" class="layer-opacity" data-lid="${l.id}" min="0" max="100" value="${op}" title="Layer opacity"
        style="width:52px;flex-shrink:0;accent-color:var(--accent);opacity:${l.visible ? 1 : 0.35}" />
      <button class="layer-del-btn" data-lid="${l.id}" title="Delete layer" style="background:none;border:none;color:var(--text-dim);cursor:pointer;padding:0 2px;opacity:0.55;line-height:1;flex-shrink:0">
        <svg width="11" height="11" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4h7M5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4l.5 6.5a1 1 0 0 0 1 .9h2a1 1 0 0 0 1-.9L9 4"/></svg>
      </button>
    </div>`;
  }).join('');

  list.querySelectorAll('.layer-opacity').forEach(sl => {
    sl.addEventListener('click', e => e.stopPropagation());
    sl.addEventListener('pointerdown', e => e.stopPropagation());
    const apply = () => {
      window.slateLayers?.setOpacity(sl.dataset.lid, Number(sl.value) / 100);
    };
    sl.addEventListener('input', e => {
      e.stopPropagation();
      apply();
    });
    sl.addEventListener('change', e => {
      e.stopPropagation();
      apply();
    });
  });

  list.querySelectorAll('.layer-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.detail > 1) return;
      if (e.target.closest('.layer-vis-btn') || e.target.closest('.layer-del-btn') || e.target.closest('.layer-opacity')) return;
      if (row.querySelector('.layer-name input')) return;
      window.slateLayers?.setActive(row.dataset.lid);
      renderLayersList();
    });
    _bindLayerDragEvents(row);
  });

  list.querySelectorAll('.layer-vis-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.lid;
      const layer = api?.list.find(l => l.id === id);
      if (layer) api.setVisible(id, !layer.visible);
      renderLayersList();
    });
  });

  list.querySelectorAll('.layer-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.lid;
      if (!api) return;
      if (api.list.length <= 1) {
        if (typeof showToast === 'function') showToast('At least one layer required');
        return;
      }
      api.remove(id);
      renderLayersList();
    });
  });

  list.querySelectorAll('.layer-name').forEach(span => {
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      _beginLayerRename(span);
    });
  });
}
window.renderLayersList = renderLayersList;

function _escape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function _beginLayerRename(span) {
  const id = span.dataset.lid;
  const layer = window.slateLayers?.list?.find(l => l.id === id);
  const original = layer ? layer.name : span.textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.maxLength = 32;
  input.style.cssText = 'flex:1;min-width:0;font-size:.78rem;background:var(--bg);color:var(--text);border:1px solid var(--accent);border-radius:3px;padding:1px 4px;outline:none';
  span.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    if (val && val !== original) {
      window.slateLayers?.rename(id, val);
    }
    renderLayersList();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); committed = true; renderLayersList(); }
  });
}

let _dragLayerId = null;
function _bindLayerDragEvents(row) {
  row.addEventListener('dragstart', e => {
    _dragLayerId = row.dataset.lid;
    row.style.opacity = '0.4';
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _dragLayerId); } catch {}
  });
  row.addEventListener('dragend', () => {
    row.style.opacity = '';
    _dragLayerId = null;
    document.querySelectorAll('.layer-row').forEach(r => r.style.borderTopColor = '');
  });
  row.addEventListener('dragover', e => {
    if (!_dragLayerId || _dragLayerId === row.dataset.lid) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    row.style.borderTop = '2px solid var(--accent)';
  });
  row.addEventListener('dragleave', () => { row.style.borderTop = ''; });
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.style.borderTop = '';
    if (!_dragLayerId || _dragLayerId === row.dataset.lid) return;
    const api = window.slateLayers;
    if (!api) return;
    const list = api.list;
    const dropIdx = list.findIndex(l => l.id === row.dataset.lid);
    if (dropIdx < 0) return;
    api.move(_dragLayerId, dropIdx);
    renderLayersList();
  });
}

function toggleLayersPanel() {
  const panel = document.getElementById('layers-panel');
  const btn   = document.getElementById('layers-toolbar-btn');
  if (panel && panel.closest('#dock-body') && window.slateDock) {
    const dock = document.getElementById('right-dock');
    const collapsed = dock?.classList.contains('dock-user-collapsed');
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-w'), 10) || 0;
    if (collapsed || w < 48) {
      window.slateDock.revealPanel('layers');
      btn?.classList.add('active');
    } else {
      window.slateDock.toggleCollapsed();
      btn?.classList.remove('active');
    }
    return;
  }
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  panel.style.flexDirection = 'column';
  btn?.classList.toggle('active', !open);
}

/* ─────────────────────────────────────────────────────────────────────────
   KEYBOARD SHORTCUTS OVERLAY
───────────────────────────────────────────────────────────────────────── */
function injectShortcutsOverlay() {
  if (document.getElementById('shortcuts-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'shortcuts-overlay';
  const SHORTCUTS = [
    { head: 'Tools' },
    { key: 'P',           label: 'Pen' },
    { key: 'Y',           label: 'Highlighter' },
    { key: 'E',           label: 'Eraser' },
    { key: '(toolbar)', label: 'Shapes menu — rectangle, ellipse, triangle, line, arrow' },
    { key: 'R O G L A', label: 'Keyboard for the same shape tools' },
    { key: 'T',           label: 'Text (drag to size)' },
    { key: 'S',           label: 'Select / box-select' },
    { key: 'H or Space',  label: 'Pan (hand tool)' },
    { head: 'Editing' },
    { key: 'Ctrl+Z',           label: 'Undo' },
    { key: 'Ctrl+Shift+Z',     label: 'Redo' },
    { key: 'Ctrl+A',           label: 'Select all' },
    { key: 'Ctrl+C',           label: 'Copy selection' },
    { key: 'Ctrl+X',           label: 'Cut selection' },
    { key: 'Ctrl+V',           label: 'Paste' },
    { key: 'Ctrl+D',           label: 'Duplicate selection' },
    { key: 'Del / Backspace',  label: 'Delete selection' },
    { key: 'Esc',              label: 'Deselect / cancel' },
    { key: 'Shift + draw',     label: 'Constrain to square / snap to 15°' },
    { head: 'View' },
    { key: 'M',           label: 'Toggle minimap' },
    { key: 'F2',          label: 'Toggle layers panel' },
    { key: 'Ctrl+0',      label: 'Fit canvas (100%)' },
    { key: '+  /  −',     label: 'Zoom in / out' },
    { key: '?',           label: 'This shortcuts panel' },
    { head: 'Board' },
    { key: 'Ctrl+S',        label: 'Save board' },
    { key: 'Ctrl+E',        label: 'Export as PNG' },
    { key: 'Ctrl+/',        label: 'Shortcuts overlay' },
    { key: 'Ctrl+Shift+B',  label: 'Toggle visibility (host)' },
    { key: 'Ctrl+Shift+L',  label: 'Leave board' },
    { key: 'Ctrl+Shift+M',  label: 'Toggle minimap' },
  ];
  const rows = SHORTCUTS.map(s => s.head
    ? `<div class="sc-head" style="grid-column:1/-1">${s.head}</div>`
    : `<div class="sc-row"><kbd>${s.key}</kbd><span>${s.label}</span></div>`
  ).join('');
  overlay.innerHTML = `
    <div id="shortcuts-box">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
        <span style="font-size:1rem;font-weight:600;color:var(--text)">Keyboard Shortcuts</span>
        <button id="shortcuts-close" style="background:none;border:none;
          color:var(--text-dim);font-size:1.2rem;cursor:pointer;padding:4px">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 28px">${rows}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('shortcuts-close').addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
}


/* ─────────────────────────────────────────────────────────────────────────
   ANGLE / SQUARE CONSTRAINT  (Shift while drawing lines/shapes)
───────────────────────────────────────────────────────────────────────── */
document.addEventListener('keydown', e => { if (e.key === 'Shift') window._shiftHeld = true; },  true);
document.addEventListener('keyup',   e => { if (e.key === 'Shift') window._shiftHeld = false; }, true);

const _makeShapeBase = window.makeShape;
if (_makeShapeBase) {
  window.makeShape = function (wx, wy, preview) {
    if (window._shiftHeld && typeof shapeStart !== 'undefined' && shapeStart) {
      const tool = typeof currentTool !== 'undefined' ? currentTool : '';
      if (tool === 'line' || tool === 'arrow') {
        // Snap to 15° increments
        const dx = wx - shapeStart.wx, dy = wy - shapeStart.wy;
        const angle = Math.atan2(dy, dx);
        const snap  = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const dist  = Math.hypot(dx, dy);
        wx = shapeStart.wx + Math.cos(snap) * dist;
        wy = shapeStart.wy + Math.sin(snap) * dist;
      } else if (tool === 'rect' || tool === 'ellipse') {
        // Constrain to square/circle
        const dx   = wx - shapeStart.wx, dy = wy - shapeStart.wy;
        const side = Math.min(Math.abs(dx), Math.abs(dy));
        wx = shapeStart.wx + Math.sign(dx) * side;
        wy = shapeStart.wy + Math.sign(dy) * side;
      }
    }
    return _makeShapeBase.call(this, wx, wy, preview);
  };
}


/* ─────────────────────────────────────────────────────────────────────────
   TOOLBAR BUTTONS: Layers + Shortcuts-hint
───────────────────────────────────────────────────────────────────────── */
function injectToolbarExtras() {
  const toolbar = document.getElementById('draw-toolbar');
  if (!toolbar) return;

  if (!document.getElementById('layers-toolbar-btn')) {
    const btn = document.createElement('button');
    btn.id = 'layers-toolbar-btn';
    btn.title = 'Layers (F2)';
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <rect x="1" y="1" width="11" height="2.5" rx="1"/>
        <rect x="1" y="5.25" width="11" height="2.5" rx="1"/>
        <rect x="1" y="9.5" width="11" height="2" rx="1"/>
      </svg>
      Layers`;
    btn.addEventListener('click', toggleLayersPanel);
    toolbar.appendChild(btn);
  }

  if (!document.getElementById('shortcuts-hint-btn')) {
    const btn = document.createElement('button');
    btn.id = 'shortcuts-hint-btn';
    btn.className = 'tool-btn';
    btn.title = 'Keyboard shortcuts (?)';
    btn.textContent = '?';
    btn.addEventListener('click', () => {
      document.getElementById('shortcuts-overlay')?.classList.add('open');
    });
    toolbar.appendChild(btn);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   ZOOM LABEL — click to type exact %
───────────────────────────────────────────────────────────────────────── */
function patchZoomLabel() {
  const zl = document.getElementById('zoom-label');
  if (!zl || zl.dataset.featurePatched) return;
  zl.dataset.featurePatched = '1';
  zl.title = 'Click to set exact zoom %';
  zl.addEventListener('click', () => {
    const cur = zl.textContent.replace('%', '').trim();
    const raw = prompt('Set zoom % — 100% = fit canvas to screen:', cur);
    if (!raw) return;
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct > 0 && typeof fitZoom !== 'undefined' && typeof setZoom === 'function') {
      setZoom(fitZoom * pct / 100);
    }
  });
}


/* ─────────────────────────────────────────────────────────────────────────
   MINIMAP auto show/hide with board
───────────────────────────────────────────────────────────────────────── */
function hookMinimapToBoard() {
  const _origJoin  = window.joinBoard;
  const _origLeave = window.leaveBoard;
  if (_origJoin && !_origJoin._mmHooked) {
    window.joinBoard = function () {
      const r = _origJoin.apply(this, arguments);
      const mm = document.getElementById('minimap-wrap');
      if (mm) mm.style.display = 'block';
      return r;
    };
    window.joinBoard._mmHooked = true;
  }
  if (_origLeave && !_origLeave._mmHooked) {
    window.leaveBoard = function () {
      const r = _origLeave.apply(this, arguments);
      const mm = document.getElementById('minimap-wrap');
      if (mm) mm.style.display = 'none';
      return r;
    };
    window.leaveBoard._mmHooked = true;
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   TOAST helper  (use existing or create minimal one)
───────────────────────────────────────────────────────────────────────── */
function showToast(msg) {
  if (typeof toast === 'function') { toast(msg, 'info'); return; }
  let t = document.getElementById('_feat_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_feat_toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:var(--bg3);border:1px solid var(--border2);color:var(--text);' +
      'padding:8px 16px;border-radius:8px;font-size:.82rem;z-index:8000;' +
      'pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = '0'; }, 2000);
}


let _propsDockRegistered = false;
function injectPropsDockPlaceholder() {
  if (_propsDockRegistered) return;
  if (!window.slateDock || typeof window.slateDock.registerPanel !== 'function') return;
  if (!document.body.classList.contains('mode-3d')) return;
  window.slateDock.registerPanel({
    id: 'props',
    title: 'Properties',
    order: 98,
    mount(el) {
      el.innerHTML = '<p style="margin:12px 14px;font-size:0.78rem;line-height:1.45;color:var(--text-dim)">Selection and tool options will appear here. Register panels with <code style="font-size:0.7rem;font-family:var(--mono,monospace)">slateDock.registerPanel()</code>.</p>';
    },
  });
  _propsDockRegistered = true;
}
window.slateEnsurePropsPanel = injectPropsDockPlaceholder;

/* ─────────────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────────────── */
function init() {
  injectOpacityControl();
  injectMinimap();
  injectLayersPanel();
  injectShortcutsOverlay();
  injectToolbarExtras();
  patchZoomLabel();
  hookMinimapToBoard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 60);   // Let main script + layout-dock finish first
}

})();
