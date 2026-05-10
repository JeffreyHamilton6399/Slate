/**
 * features.js — Pro art-tool features for Slate.
 * Injected by server.js after patches.js.
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
  #color-history  { display:flex;align-items:center;gap:3px;flex-shrink:0; }
  .color-hist-swatch { transition:transform .1s,box-shadow .1s; }
  .color-hist-swatch:hover { transform:scale(1.25); box-shadow:0 2px 8px rgba(0,0,0,.45); }

  #minimap-wrap { position:absolute;bottom:16px;right:16px;z-index:30;
    border:1px solid var(--border2);border-radius:8px;overflow:hidden;
    box-shadow:0 4px 20px rgba(0,0,0,.5);transition:opacity .2s;cursor:crosshair; }
  #minimap-wrap:hover { opacity:1 !important; }

  #layers-panel { position:absolute;top:56px;right:16px;z-index:30;width:164px;
    border:1px solid var(--border2);border-radius:8px;background:var(--bg2);
    box-shadow:0 4px 20px rgba(0,0,0,.5);flex-direction:column;overflow:hidden; }
  .layer-row { display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;
    font-size:0.78rem;border-left:2px solid transparent;transition:background .1s,border-color .1s; }
  .layer-row:hover { background:var(--bg3); }
  .layer-vis-btn { background:none;border:none;padding:0;cursor:pointer;flex-shrink:0;line-height:1; }

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

// Patch drawStroke: apply opacity + Catmull-Rom smoothing for pen strokes
const _drawStrokeBase = window.drawStroke;
if (_drawStrokeBase) {
  window.drawStroke = function (s) {
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
    // Fallback for short / highlighter strokes
    if (op < 1) { ctx.save(); ctx.globalAlpha = op; _drawStrokeBase.call(this, s); ctx.restore(); }
    else _drawStrokeBase.call(this, s);
  };
}

// Patch drawShape for opacity
const _drawShapeBase = window.drawShape;
if (_drawShapeBase) {
  window.drawShape = function (s, preview) {
    const op = (s && s._opacity != null) ? s._opacity : 1;
    if (op < 1) { ctx.save(); ctx.globalAlpha = op; _drawShapeBase.call(this, s, preview); ctx.restore(); }
    else _drawShapeBase.call(this, s, preview);
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
  items.forEach(item => {
    const newId = genId();
    if (item.points) {
      const s = { ...item, id: newId, t: Date.now(),
        points: item.points.map(([x, y]) => [x + offset, y + offset]) };
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


/* ─────────────────────────────────────────────────────────────────────────
   COLOR HISTORY  — last 8 used colors
───────────────────────────────────────────────────────────────────────── */
let _colorHistory = (() => {
  try { return JSON.parse(localStorage.getItem('slate_color_history') || '["#1a1a2e"]'); } catch { return ['#1a1a2e']; }
})();

function injectColorHistory() {
  if (document.getElementById('color-history')) return;
  const picker = document.getElementById('color-picker');
  if (!picker) return;
  const hist = document.createElement('div');
  hist.id = 'color-history';
  hist.title = 'Recent colors';
  picker.parentNode.insertBefore(hist, picker.nextSibling);
  renderColorHistory();
  picker.addEventListener('change', e => addColor(e.target.value));
}

function addColor(color) {
  if (!color) return;
  _colorHistory = [color, ..._colorHistory.filter(c => c !== color)].slice(0, 8);
  try { localStorage.setItem('slate_color_history', JSON.stringify(_colorHistory)); } catch {}
  renderColorHistory();
}

function renderColorHistory() {
  const hist = document.getElementById('color-history');
  if (!hist) return;
  hist.innerHTML = _colorHistory.map(c => `
    <button class="color-hist-swatch" data-color="${c}" title="${c}" style="
      width:16px;height:16px;border-radius:4px;
      border:1.5px solid rgba(255,255,255,0.15);
      background:${c};cursor:pointer;flex-shrink:0;padding:0;">
    </button>
  `).join('');
  hist.querySelectorAll('.color-hist-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      const picker = document.getElementById('color-picker');
      if (picker) { picker.value = color; picker.dispatchEvent(new Event('input', { bubbles: true })); }
    });
  });
}


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
  const mx = (e.clientX - rect.left) / mc.width;
  const my = (e.clientY - rect.top)  / mc.height;
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

  const mc = mm.getContext('2d');
  const W = mm.width, H = mm.height;
  const scX = W / WORLD_W, scY = H / WORLD_H;
  const offX = WORLD_W / 2, offY = WORLD_H / 2;

  mc.fillStyle = (typeof PAPER_COLOR !== 'undefined') ? PAPER_COLOR : '#f8f7f4';
  mc.fillRect(0, 0, W, H);

  doc.strokes.forEach(s => {
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
   LAYERS  — 5 layers, visibility toggle, active layer
───────────────────────────────────────────────────────────────────────── */
const _layers = [
  { id: 'l5', name: 'Layer 5', visible: true },
  { id: 'l4', name: 'Layer 4', visible: true },
  { id: 'l3', name: 'Layer 3', visible: true },
  { id: 'l2', name: 'Layer 2', visible: true },
  { id: 'l1', name: 'Layer 1', visible: true },
];
let _activeLayerId = 'l1';

function injectLayersPanel() {
  if (document.getElementById('layers-panel')) return;
  const area = document.getElementById('canvas-area');
  if (!area) return;
  const panel = document.createElement('div');
  panel.id = 'layers-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div style="padding:8px 10px 6px;font-size:.68rem;font-weight:600;color:var(--text-dim);
      letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border);
      display:flex;align-items:center;justify-content:space-between">
      Layers
      <button id="layers-add-btn" title="Add layer" style="background:none;border:none;
        color:var(--text-mid);cursor:pointer;font-size:15px;padding:0 2px;line-height:1">+</button>
    </div>
    <div id="layers-list"></div>
  `;
  area.appendChild(panel);
  renderLayersList();
  document.getElementById('layers-add-btn').addEventListener('click', () => {
    const id = 'l' + Date.now();
    _layers.unshift({ id, name: 'Layer ' + (_layers.length + 1), visible: true });
    _activeLayerId = id;
    renderLayersList();
  });
}

function renderLayersList() {
  const list = document.getElementById('layers-list');
  if (!list) return;
  list.innerHTML = _layers.map(l => {
    const active = l.id === _activeLayerId;
    return `<div class="layer-row" data-lid="${l.id}" style="
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
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.78rem">${l.name}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.layer-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.layer-vis-btn')) return;
      _activeLayerId = row.dataset.lid;
      renderLayersList();
    });
  });
  list.querySelectorAll('.layer-vis-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const layer = _layers.find(l => l.id === btn.dataset.lid);
      if (layer) {
        layer.visible = !layer.visible;
        renderLayersList();
        if (typeof invalidateStatic === 'function') invalidateStatic();
        if (typeof scheduleRender === 'function') scheduleRender();
      }
    });
  });
}

function toggleLayersPanel() {
  const panel = document.getElementById('layers-panel');
  const btn   = document.getElementById('layers-toolbar-btn');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  panel.style.flexDirection = 'column';
  btn?.classList.toggle('active', !open);
}

// Tag new strokes with active layer
document.getElementById('board-canvas')?.addEventListener('pointerdown', () => {
  setTimeout(() => {
    if (typeof currentStroke !== 'undefined' && currentStroke) {
      currentStroke._layer = _activeLayerId;
    }
  }, 0);
}, false);

// Patch rendering to respect layer visibility
function patchLayerVisibility() {
  const _origDrawStroke2 = window.drawStroke;
  if (_origDrawStroke2 && !_origDrawStroke2._layerPatched) {
    const wrapped = function (s) {
      if (s?._layer) {
        const layer = _layers.find(l => l.id === s._layer);
        if (layer && !layer.visible) return;
      }
      _origDrawStroke2.call(this, s);
    };
    wrapped._layerPatched = true;
    window.drawStroke = wrapped;
  }
  const _origDrawShape2 = window.drawShape;
  if (_origDrawShape2 && !_origDrawShape2._layerPatched) {
    const wrapped = function (s, preview) {
      if (s?._layer) {
        const layer = _layers.find(l => l.id === s._layer);
        if (layer && !layer.visible) return;
      }
      _origDrawShape2.call(this, s, preview);
    };
    wrapped._layerPatched = true;
    window.drawShape = wrapped;
  }
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
    { key: 'R',           label: 'Rectangle' },
    { key: 'O',           label: 'Ellipse' },
    { key: 'L',           label: 'Line' },
    { key: 'A',           label: 'Arrow' },
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


/* ─────────────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────────────── */
function init() {
  injectOpacityControl();
  injectColorHistory();
  injectMinimap();
  injectLayersPanel();
  injectShortcutsOverlay();
  injectToolbarExtras();
  patchZoomLabel();
  patchLayerVisibility();
  hookMinimapToBoard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 60);   // Let main script + patches.js finish first
}

})();
