/**
 * patches.js — Runtime DOM patches applied to Slate without modifying index.html.
 * Injected by server.js before </body>.
 */
(function () {
  'use strict';

  // ── 1. VOICE BAR: restore open-mic toggle button ──────────────────────────
  // The voice-bar div was set display:none. Restore it with a proper toggle btn.
  const voiceBar = document.getElementById('voice-bar');
  if (voiceBar) {
    voiceBar.style.display = 'flex';
    voiceBar.style.alignItems = 'center';
    // If the toggle button doesn't already exist, add it
    if (!document.getElementById('voice-toggle-btn')) {
      voiceBar.innerHTML = `
        <button id="voice-toggle-btn" title="Join open mic" style="
          display:flex;align-items:center;gap:5px;
          padding:5px 10px;border-radius:6px;
          background:var(--bg3);border:1px solid var(--border2);
          color:var(--text-mid);cursor:pointer;font-size:0.75rem;font-weight:500;
          transition:background 0.15s,color 0.15s,border-color 0.15s
        ">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="1" width="5" height="7" rx="2.5"/>
            <path d="M2 6.5A4.5 4.5 0 0 0 11 6.5M6.5 11v1.5"/>
          </svg>
          <span id="voice-toggle-label">Mic off</span>
        </button>`;
      // Wire the toggle button to the existing voice logic
      document.getElementById('voice-toggle-btn').addEventListener('click', () => {
        if (typeof toggleMute === 'function') {
          // If no mic yet, acquire it; otherwise toggle mute
          if (typeof voiceState !== 'undefined' && !voiceState.localStream) {
            if (typeof joinVoice === 'function') joinVoice();
          } else {
            toggleMute();
          }
        }
        updateVoiceToggleBtn();
      });
    }
  }

  function updateVoiceToggleBtn() {
    const btn = document.getElementById('voice-toggle-btn');
    const lbl = document.getElementById('voice-toggle-label');
    if (!btn || typeof voiceState === 'undefined') return;
    const hasStream = !!voiceState.localStream;
    const muted = voiceState.isMuted;
    btn.style.color = hasStream && !muted ? 'var(--green)' : 'var(--text-mid)';
    btn.style.borderColor = hasStream && !muted ? 'rgba(34,211,165,0.4)' : 'var(--border2)';
    btn.style.background = hasStream && !muted ? 'rgba(34,211,165,0.08)' : 'var(--bg3)';
    if (lbl) lbl.textContent = !hasStream ? 'Mic off' : muted ? 'Muted' : 'Live';
    btn.title = !hasStream ? 'Click to join open mic' : muted ? 'Click to unmute' : 'Click to mute';
  }

  // Patch updateMuteBtn to also update our toggle button
  const _origUpdateMuteBtn = window.updateMuteBtn;
  window.updateMuteBtn = function () {
    if (_origUpdateMuteBtn) _origUpdateMuteBtn.apply(this, arguments);
    updateVoiceToggleBtn();
  };

  // ── 2. VIS TOGGLE: icon-only (remove text label) ──────────────────────────
  const visLabel = document.querySelector('#vis-toggle-btn .vis-label');
  if (visLabel) visLabel.remove();
  const visBtn = document.getElementById('vis-toggle-btn');
  if (visBtn) {
    visBtn.style.padding = '7px 8px';
    visBtn.style.gap = '0';
  }

  // ── 3. ERASER ICON: replace eyedropper-looking icon with block eraser ─────
  const eraserBtn = document.querySelector('[data-tool="eraser"]');
  if (eraserBtn) {
    const svg = eraserBtn.querySelector('svg');
    if (svg) {
      svg.innerHTML = `
        <path d="M5 3L13 11H7L2 11V8L5 3Z" fill="rgba(248,113,113,0.18)" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="5" y1="3" x2="13" y2="11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;
    }
  }

  // ── 4. COLOR SWATCHES: remove swatches, keep only color picker ────────────
  const swatchContainer = document.getElementById('color-swatches');
  if (swatchContainer) {
    // Remove all swatch buttons
    swatchContainer.querySelectorAll('.swatch').forEach(s => s.remove());
    // Keep the color picker but make it bigger/nicer
    const picker = document.getElementById('color-picker');
    if (picker) {
      picker.style.width = '32px';
      picker.style.height = '32px';
      picker.style.padding = '2px';
      picker.style.borderRadius = '8px';
      picker.style.border = '1.5px solid var(--border2)';
      picker.style.background = 'var(--bg3)';
      picker.style.cursor = 'pointer';
    }
    swatchContainer.style.gap = '4px';
    swatchContainer.style.alignItems = 'center';
  }

  // ── 5. GRID DOTS: remove grid (plain white paper) ─────────────────────────
  // Patch _drawGridOn to do nothing — plain clean paper
  if (typeof window._drawGridOn === 'function') {
    window._drawGridOn = function () {}; // no-op
  }
  // Also try patching the module-level function
  setTimeout(() => {
    if (typeof _drawGridOn !== 'undefined') {
      try { window._drawGridOn = function () {}; } catch {}
    }
  }, 100);

  // ── 6. LEAVE BOARD BUTTON: add to board header ─────────────────────────────
  const header = document.getElementById('board-header');
  if (header && !document.getElementById('leave-board-btn')) {
    const leaveBtn = document.createElement('button');
    leaveBtn.id = 'leave-board-btn';
    leaveBtn.title = 'Leave board';
    leaveBtn.style.cssText = `
      display:none;flex-shrink:0;align-items:center;gap:5px;
      padding:5px 10px;border-radius:6px;font-size:0.75rem;font-weight:500;
      background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);
      color:var(--danger);cursor:pointer;transition:background 0.15s;
    `;
    leaveBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 2H11V11H8"/>
        <line x1="4" y1="6.5" x2="10" y2="6.5"/>
        <polyline points="6,4.5 4,6.5 6,8.5"/>
      </svg>
      Leave`;
    leaveBtn.addEventListener('click', () => {
      if (typeof leaveBoard === 'function') leaveBoard();
    });
    // Insert before the chat button
    const chatBtn = document.getElementById('chat-btn');
    if (chatBtn) header.insertBefore(leaveBtn, chatBtn);
    else header.appendChild(leaveBtn);

    // Show/hide when in/out of a board
    const _origJoinBoard = window.joinBoard;
    window.joinBoard = function () {
      const r = _origJoinBoard && _origJoinBoard.apply(this, arguments);
      leaveBtn.style.display = 'flex';
      return r;
    };
    const _origLeaveBoard = window.leaveBoard;
    window.leaveBoard = function () {
      const r = _origLeaveBoard && _origLeaveBoard.apply(this, arguments);
      leaveBtn.style.display = 'none';
      return r;
    };
  }

  // ── 7. VOTE TO CLEAR: require unanimous vote ───────────────────────────────
  // Patch initiateVoteClear and handleVoteResp for unanimous requirement
  const _origInitiateVoteClear = window.initiateVoteClear;
  window.initiateVoteClear = function () {
    // If only 1 person in board, just clear
    if (typeof state !== 'undefined' && typeof doc !== 'undefined') {
      const memberCount = Object.values(state.connections || {})
        .filter(c => c.board === state.currentBoard && c.conn && c.conn.open).length + 1;
      if (memberCount <= 1) {
        if (typeof docClear === 'function') {
          docClear();
          if (typeof broadcastAll === 'function') broadcastAll({ type: 'doc-clear' });
          if (typeof invalidateStatic === 'function') invalidateStatic();
          if (typeof scheduleRender === 'function') scheduleRender();
        }
        return;
      }
    }
    if (_origInitiateVoteClear) _origInitiateVoteClear.apply(this, arguments);
  };

  // ── 8. LIGHT/DARK THEME: add to settings ──────────────────────────────────
  // Add theme toggle after loading
  setTimeout(addThemeSettings, 200);

  function addThemeSettings() {
    const aboutSection = document.querySelector('.settings-section:last-of-type');
    if (!aboutSection || document.getElementById('theme-toggle-checkbox')) return;

    // Insert a new section before the About section
    const themeSection = document.createElement('div');
    themeSection.className = 'settings-section';
    themeSection.innerHTML = `
      <div class="settings-section-title">Appearance</div>
      <div class="setting-row">
        <div>
          <div class="setting-row-label">Light theme</div>
          <div class="setting-row-sub">Switch to light / whiteboard mode</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="theme-toggle-checkbox">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-row-label">Grid on canvas</div>
          <div class="setting-row-sub">Show dot grid on the whiteboard</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="grid-toggle-checkbox">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-row-label">Auto-rejoin last board</div>
          <div class="setting-row-sub">Return to your board when you reopen the app</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="autojoin-toggle-checkbox">
          <span class="toggle-track"></span>
        </label>
      </div>`;
    aboutSection.parentNode.insertBefore(themeSection, aboutSection);

    // Theme toggle logic
    const savedTheme = localStorage.getItem('slate_theme') || 'dark';
    applyTheme(savedTheme);

    function applyTheme(theme) {
      document.body.classList.toggle('light', theme === 'light');
      const cb = document.getElementById('theme-toggle-checkbox');
      if (cb) cb.checked = (theme === 'light');
      localStorage.setItem('slate_theme', theme);
      // Update meta theme-color
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = theme === 'light' ? '#f4f4f7' : '#0c0c0e';
    }

    document.getElementById('theme-toggle-checkbox')?.addEventListener('change', e => {
      applyTheme(e.target.checked ? 'light' : 'dark');
    });

    // Grid toggle
    const savedGrid = localStorage.getItem('slate_grid') !== 'off';
    const gridCb = document.getElementById('grid-toggle-checkbox');
    if (gridCb) {
      gridCb.checked = savedGrid;
      gridCb.addEventListener('change', e => {
        localStorage.setItem('slate_grid', e.target.checked ? 'on' : 'off');
        window._slateGridEnabled = e.target.checked;
        if (typeof scheduleRender === 'function') scheduleRender();
      });
    }
    window._slateGridEnabled = savedGrid;

    // Auto-rejoin toggle
    const savedAutoJoin = localStorage.getItem('slate_autojoin') === 'on';
    const ajCb = document.getElementById('autojoin-toggle-checkbox');
    if (ajCb) {
      ajCb.checked = savedAutoJoin;
      ajCb.addEventListener('change', e => {
        localStorage.setItem('slate_autojoin', e.target.checked ? 'on' : 'off');
      });
    }
  }

  // ── 9. LIGHT THEME CSS ────────────────────────────────────────────────────
  const lightCSS = document.createElement('style');
  lightCSS.textContent = `
    body.light {
      --bg:      #f4f4f7;
      --bg2:     #eaeaef;
      --bg3:     #e0e0e8;
      --bg4:     #d5d5e0;
      --border:  #c8c8d8;
      --border2: #b8b8cc;
      --accent:  #5b4de0;
      --accent2: #8b3fcf;
      --accent-dim: #8b7ff0;
      --accent-glow: rgba(91,77,224,0.14);
      --green:   #0d9e7a;
      --danger:  #d93535;
      --text:    #1a1a2e;
      --text-dim:#7070a0;
      --text-mid:#444468;
    }
    body.light #sidebar,
    body.light #board-header,
    body.light #member-panel,
    body.light #chat-panel,
    body.light #draw-toolbar { background: var(--bg2); }
    body.light #canvas-area { background: #d0d0dc; }
  `;
  document.head.appendChild(lightCSS);

  // ── 10. MEMBER CLICK: show member name even for non-hosts ─────────────────
  // Patch renderMembers so all members can click (already done in index.html,
  // but ensure the menu shows something useful for non-hosts)
  const _origShowModMenu = window.showModMenu;
  window.showModMenu = function (peerId, anchorEl) {
    if (_origShowModMenu) _origShowModMenu.apply(this, arguments);
    // If no host actions are visible, make the menu at least show the name prominently
    if (typeof state !== 'undefined' && !state.isBoardHost) {
      const menu = document.getElementById('mod-menu');
      if (menu) {
        // Add/show a "view only" hint if no actions are visible
        let hint = menu.querySelector('.non-host-hint');
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'non-host-hint';
          hint.style.cssText = 'padding:6px 12px 8px;font-size:0.73rem;color:var(--text-dim);font-style:italic';
          hint.textContent = 'Only hosts can moderate members';
          menu.appendChild(hint);
        }
        hint.style.display = '';
      }
    } else {
      const hint = document.querySelector('.non-host-hint');
      if (hint) hint.style.display = 'none';
    }
  };

  // ── 11. GRID: respect the grid toggle setting ─────────────────────────────
  // Wrap _drawGridOn so it can be toggled at runtime
  setTimeout(() => {
    const _rawGrid = window._drawGridOn;
    if (_rawGrid) {
      window._drawGridOn = function (c) {
        if (window._slateGridEnabled) _rawGrid.call(this, c);
      };
    }
  }, 150);

  // ── 12. MEMBER CLICK: stop propagation so mod-menu stays open ─────────────
  // Bug: click on member row bubbles to document which fires the "close menu"
  // handler immediately, so the menu opens and vanishes in <1 ms.
  // Fix: clone the row to remove old listeners, then attach with stopPropagation.
  const _origRenderMembers = window.renderMembers;
  window.renderMembers = function () {
    _origRenderMembers.apply(this, arguments);
    const list = document.getElementById('member-list');
    if (!list) return;
    list.querySelectorAll('.member-row[data-peer]').forEach(row => {
      const clone = row.cloneNode(true);
      row.parentNode.replaceChild(clone, row);
      clone.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof showModMenu === 'function') showModMenu(clone.dataset.peer, clone);
      });
    });
  };

  // ── 13. BOARD LIST: fix lobbyBroadcast for PeerJS v1.x API ──────────────────
  // PeerJS v1 exposes connections as peer.connections (not peer._connections).
  // If _connections is undefined, lobbyBroadcast sends to nobody → boards never
  // propagate to other users, requiring a full page refresh to see new boards.
  window.lobbyBroadcast = function (data) {
    if (!state.lobbyPeer) return;
    const connsObj = state.lobbyPeer.connections || state.lobbyPeer._connections || {};
    Object.values(connsObj).forEach(conns => {
      const arr = Array.isArray(conns) ? conns : (conns ? [conns] : []);
      arr.forEach(conn => { try { if (conn && conn.open) conn.send(data); } catch {} });
    });
  };
  // Also prune empty boards periodically (NOT in scheduleRenderBoards — that
  // would erase boards before they're rendered when someone just joined).
  setInterval(() => {
    if (typeof pruneEmptyBoards === 'function') {
      try { const n = pruneEmptyBoards(); if (n && typeof scheduleRenderBoards === 'function') scheduleRenderBoards(); } catch {}
    }
  }, 20000);

  // ── 14. HOST ELECTION: robust fix using lobby registry + delayed re-check ───
  // Root bug: setupDataConn's conn.on('open') callback fires while joinBoard is
  // still on the call stack with isBoardHost=true, so the joiner sends a false
  // host-changed to the real host before any election runs.
  // Fix A — block the early host claim when lobby shows others are already there.
  // Fix B — 2.5s after joining, re-run ensureBoardHost to correct any race.
  const _origJoinBoardHost = window.joinBoard;
  window.joinBoard = function (board) {
    const r = _origJoinBoardHost && _origJoinBoardHost.apply(this, arguments);
    if (typeof state !== 'undefined') {
      const othersInBoard = Object.entries(state.lobbyRegistry || {})
        .some(([id, info]) => id !== state.myId && info.board === board);
      if (othersInBoard) {
        state.isBoardHost = false;
        state.boardHostId = null;
      }
    }
    // Delayed re-election: after connections open and hellos arrive, re-compute host
    setTimeout(() => {
      if (state.currentBoard === board && typeof ensureBoardHost === 'function') {
        ensureBoardHost();
      }
    }, 2500);
    return r;
  };

  // ── 15. VOICE: auto-request mic when joining a board ───────────────────────
  const _origJoinBoardVoice = window.joinBoard;
  window.joinBoard = function (board) {
    const r = _origJoinBoardVoice && _origJoinBoardVoice.apply(this, arguments);
    if (typeof voiceState !== 'undefined' && !voiceState.localStream) {
      if (typeof joinVoice === 'function') setTimeout(() => joinVoice(), 400);
    }
    return r;
  };

  // ── 16. REMOTE CURSORS: draw other users' cursors on the canvas ─────────────
  // Cursor world-coords already arrive via 'presence' messages and are stored in
  // state.connections[pid].cursor. We just need to render them.
  const _origRenderFrame = window.renderFrame;
  window.renderFrame = function () {
    _origRenderFrame && _origRenderFrame.apply(this, arguments);
    if (typeof state === 'undefined' || !state.currentBoard) return;
    Object.entries(state.connections).forEach(([pid, info]) => {
      if (info.board !== state.currentBoard || !info.cursor) return;
      const sx = info.cursor.x * vp.zoom + vp.panX;
      const sy = info.cursor.y * vp.zoom + vp.panY;
      if (sx < -20 || sy < -20 || sx > canvas.width + 20 || sy > canvas.height + 20) return;
      const col = typeof peerColor === 'function' ? peerColor(info.name || pid) : '#7c6aff';
      ctx.save();
      // Cursor arrow (pointer shape)
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 8, sy + 14);
      ctx.lineTo(sx + 3.5, sy + 11);
      ctx.lineTo(sx + 2, sy + 17);
      ctx.lineTo(sx - 0.5, sy + 11);
      ctx.lineTo(sx - 5, sy + 13);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      // Name label
      const label = info.name || 'User';
      ctx.font = 'bold 11px Inter,sans-serif';
      const tw = ctx.measureText(label).width;
      const lx = sx + 10, ly = sy + 10;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(lx - 3, ly - 10, tw + 8, 15, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 1, ly);
      ctx.restore();
    });
  };

  // ── 17. SFX: lightweight sounds for events ───────────────────────────────────
  let _sfxCtx = null;
  function sfx(type) {
    try {
      if (!_sfxCtx) _sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ac = _sfxCtx;
      if (ac.state === 'suspended') ac.resume();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      const t = ac.currentTime;
      const configs = {
        join:     { f: [440, 523], dur: 0.18, g: 0.12 },
        leave:    { f: [523, 349], dur: 0.18, g: 0.08 },
        chat:     { f: [880, 1047], dur: 0.09, g: 0.08 },
        board:    { f: [523, 659, 784], dur: 0.28, g: 0.10 },
        click:    { f: [600], dur: 0.05, g: 0.06 },
        error:    { f: [220, 196], dur: 0.22, g: 0.10 },
      };
      const cfg = configs[type] || configs.click;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(cfg.f[0], t);
      cfg.f.forEach((freq, i) => osc.frequency.setValueAtTime(freq, t + i * cfg.dur / cfg.f.length));
      gain.gain.setValueAtTime(cfg.g, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + cfg.dur);
      osc.start(t);
      osc.stop(t + cfg.dur);
    } catch {}
  }
  window._slateSfx = sfx;

  // Hook SFX to peer events
  const _origHandleData = window.handleData;
  window.handleData = function (peerId, data) {
    const prevBoard = typeof state !== 'undefined' ? state.connections[peerId]?.board : null;
    _origHandleData && _origHandleData.apply(this, arguments);
    if (typeof state === 'undefined') return;
    try {
      if (data.type === 'hello') {
        const nowBoard = state.connections[peerId]?.board;
        if (nowBoard === state.currentBoard && prevBoard !== state.currentBoard) sfx('join');
      }
      if (data.type === 'leave') sfx('leave');
      if (data.type === 'chat')  sfx('chat');
      if (data.type === 'doc-clear') sfx('error');
    } catch {}
  };

  // SFX when we ourselves join a board
  const _origJoinBoardSfx = window.joinBoard;
  window.joinBoard = function (board) {
    const r = _origJoinBoardSfx && _origJoinBoardSfx.apply(this, arguments);
    setTimeout(() => sfx('board'), 200);
    return r;
  };

  // ── 18. MOBILE CSS: fix layout for small screens ───────────────────────────
  const mobilePatchCSS = document.createElement('style');
  mobilePatchCSS.textContent = `
    /* Toolbar scrollable on mobile; hide desktop-only extras */
    @media (max-width: 768px) {
      #draw-toolbar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch;
        scrollbar-width: none; padding: 0 6px; }
      #draw-toolbar::-webkit-scrollbar { display: none; }
      #opacity-wrap, #layers-toolbar-btn, #shortcuts-hint-btn, #color-history { display: none !important; }
      #minimap-wrap { bottom: 62px; right: 8px; opacity: 0.9; }
      #layers-panel { top: 50px; right: 8px; width: 148px; }
      /* Board header: compact */
      #leave-board-btn svg ~ * { display: none; }
      #leave-board-btn { padding: 6px 8px !important; min-width: 34px; }
      /* Ensure canvas fills remaining height */
      #canvas-area { flex: 1; min-height: 0; }
      /* Member panel takes half width on mobile */
      #member-panel, #chat-panel { width: min(300px, 90vw) !important; }
    }
    @media (max-width: 480px) {
      #board-header { padding: 0 6px; gap: 4px; }
      #board-name-display { font-size: 0.78rem; max-width: 100px; }
      .btn { padding: 5px 8px; font-size: 0.72rem; }
    }
    @media (max-height: 500px) and (max-width: 1024px) {
      #opacity-wrap, #layers-toolbar-btn, #shortcuts-hint-btn { display: none !important; }
      #minimap-wrap { bottom: 48px; right: 8px; }
      #draw-toolbar { padding: 0 4px; }
    }
    /* Mod-menu always on top */
    #mod-menu { z-index: 9000 !important; }
    /* Tap targets */
    #mute-btn { min-width: 36px; min-height: 32px; touch-action: manipulation; }
    .member-row { min-height: 40px; touch-action: manipulation; }
    /* Canvas cursor indicator: smooth rendering */
    #board-canvas { image-rendering: auto; }
  `;
  document.head.appendChild(mobilePatchCSS);

  // ── 19. UI REDESIGN: sleek, minimal, spatial ───────────────────────────────
  const uiCSS = document.createElement('style');
  uiCSS.textContent = `

  /* ── Design token overrides ── */
  :root {
    --sidebar-w: 232px;
    --header-h:  44px;
    --toolbar-h: 50px;
    --radius:    8px;
    --radius-sm: 6px;
  }

  /* ── Sidebar ── */
  #sidebar {
    width: var(--sidebar-w);
    border-right: 1px solid rgba(255,255,255,0.045);
    background: var(--bg);
    display: flex; flex-direction: column;
  }
  .sidebar-header {
    padding: 0 12px;
    height: 44px;
    border-bottom: 1px solid rgba(255,255,255,0.045);
  }
  .sidebar-logo {
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    gap: 7px;
  }
  #sidebar-settings-btn {
    width: 28px; height: 28px;
    border-radius: 7px;
    opacity: 0.55;
    transition: opacity 0.15s, background 0.15s;
  }
  #sidebar-settings-btn:hover { opacity: 1; background: var(--bg3); }

  .sidebar-section { padding: 18px 12px 4px; }
  .sidebar-section-label {
    font-size: 0.6rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }

  /* Board list items */
  #board-scroll { flex: 1; overflow-y: auto; padding: 4px 0; }
  .board-item {
    display: flex; align-items: center; gap: 8px;
    margin: 1px 8px; padding: 7px 10px;
    border-radius: 7px;
    border: none;
    border-left: 2px solid transparent;
    transition: background 0.12s, border-color 0.12s;
    cursor: pointer;
  }
  .board-item:hover { background: var(--bg3); }
  .board-item.active {
    background: rgba(124,106,255,0.10);
    border-left-color: var(--accent);
    color: var(--text);
  }
  .board-item__icon {
    width: 24px; height: 24px;
    font-size: 0.68rem; font-weight: 700;
    border-radius: 6px;
    background: var(--bg3);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: var(--text-mid);
  }
  .board-item.active .board-item__icon {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .board-item__name {
    flex: 1; font-size: 0.82rem; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .board-item__count {
    font-size: 0.65rem; font-family: var(--mono);
    color: var(--text-dim); min-width: 14px; text-align: right;
  }
  .board-item__count:empty { display: none; }
  .board-item__trash {
    opacity: 0; background: none; border: none;
    color: var(--text-dim); cursor: pointer;
    width: 20px; height: 20px; display: flex; align-items: center;
    justify-content: center; border-radius: 4px;
    transition: opacity 0.1s, background 0.1s, color 0.1s;
    flex-shrink: 0;
  }
  .board-item:hover .board-item__trash { opacity: 0.5; }
  .board-item__trash:hover { opacity: 1 !important; background: rgba(248,113,113,0.12); color: var(--danger); }

  /* Create / join section */
  .sidebar-create {
    border-top: 1px solid rgba(255,255,255,0.045);
    padding: 10px 10px 12px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .create-row {
    display: flex; align-items: center; gap: 4px;
  }
  #create-board-input, #join-private-input {
    flex: 1; background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 7px 10px;
    font-size: 0.8rem;
    color: var(--text);
    outline: none;
    transition: border-color 0.15s;
    font-family: var(--sans);
  }
  #create-board-input:focus, #join-private-input:focus {
    border-color: var(--accent);
  }
  #create-board-input::placeholder, #join-private-input::placeholder {
    color: var(--text-dim);
  }
  #create-board-btn, #join-private-btn {
    flex-shrink: 0;
    width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 7px; font-size: 1rem; font-weight: 600;
    padding: 0;
  }
  #join-private-row { display: flex; gap: 4px; }

  /* ── Header ── */
  #board-header {
    height: 44px;
    padding: 0 10px;
    gap: 6px;
    border-bottom: 1px solid rgba(255,255,255,0.045);
    background: var(--bg);
    flex-shrink: 0;
  }
  #sidebar-toggle {
    opacity: 0.6; transition: opacity 0.15s;
    width: 30px; height: 30px; border-radius: 7px; padding: 5px;
  }
  #sidebar-toggle:hover { opacity: 1; background: var(--bg3); }
  #board-name-display {
    font-size: 0.88rem; font-weight: 600;
    letter-spacing: -0.01em; max-width: 160px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text);
  }
  #board-topic-input {
    flex: 1; max-width: 220px;
    background: transparent;
    border: none; border-bottom: 1px solid transparent;
    border-radius: 0; padding: 0 6px;
    font-size: 0.78rem; color: var(--text-dim);
    outline: none;
    transition: border-color 0.15s, color 0.15s;
  }
  #board-topic-input:focus { border-bottom-color: var(--accent); color: var(--text); }
  #board-topic-input::placeholder { color: var(--text-dim); opacity: 0.5; }

  /* Header icon buttons */
  .btn-icon {
    width: 30px; height: 30px;
    border-radius: 7px; padding: 6px;
    color: var(--text-dim); background: transparent; border: none;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s, color 0.12s;
    flex-shrink: 0;
  }
  .btn-icon:hover { background: var(--bg3); color: var(--text); }
  #members-toggle, #chat-btn { position: relative; }

  /* Export / Save as compact text+icon buttons */
  #export-btn, #save-board-btn {
    font-size: 0.72rem; font-weight: 500;
    padding: 5px 9px; gap: 4px;
    border-radius: 7px;
    border-color: rgba(255,255,255,0.08);
  }
  #export-btn:hover, #save-board-btn:hover {
    background: var(--bg3); border-color: var(--border2);
  }

  /* Voice bar */
  #voice-bar { flex-shrink: 0; }
  #voice-toggle-btn {
    border-radius: 7px !important;
    font-size: 0.72rem !important;
    padding: 5px 9px !important;
  }

  /* ── Drawing toolbar ── */
  #draw-toolbar {
    height: var(--toolbar-h);
    min-height: var(--toolbar-h);
    padding: 5px 12px;
    gap: 1px;
    background: var(--bg);
    border-top: none;
    border-bottom: 1px solid rgba(255,255,255,0.045);
    overflow-x: auto; overflow-y: hidden;
    scrollbar-width: none;
    flex-shrink: 0;
    align-items: center;
  }
  #draw-toolbar::-webkit-scrollbar { display: none; }

  /* Tool buttons */
  .tool-btn {
    width: 34px; height: 34px;
    border-radius: 8px;
    padding: 7px;
    color: var(--text-dim);
    background: transparent; border: none;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.1s, color 0.1s, transform 0.08s;
    flex-shrink: 0; cursor: pointer;
    position: relative;
  }
  .tool-btn:hover:not(.active):not(:disabled) {
    background: var(--bg3);
    color: var(--text);
  }
  .tool-btn:active { transform: scale(0.92); }
  .tool-btn.active {
    background: rgba(124,106,255,0.14);
    color: var(--accent);
  }
  /* Active dot indicator */
  .tool-btn.active::after {
    content: '';
    position: absolute;
    bottom: 3px; left: 50%;
    transform: translateX(-50%);
    width: 4px; height: 4px;
    border-radius: 2px;
    background: var(--accent);
  }
  .tool-btn:disabled { opacity: 0.3; cursor: default; }

  /* Toolbar separator */
  .toolbar-sep {
    width: 1px; height: 20px;
    background: rgba(255,255,255,0.07);
    margin: 0 5px; flex-shrink: 0;
    border: none; display: block;
  }
  .toolbar-spacer { flex: 1; }

  /* Stroke size */
  #stroke-size-wrap {
    display: flex; align-items: center; gap: 5px;
    padding: 0 4px; flex-shrink: 0;
  }
  #stroke-size { width: 60px; accent-color: var(--accent); }

  /* Color area */
  #color-swatches {
    display: flex; align-items: center; gap: 3px;
    flex-shrink: 0;
  }
  .swatch {
    width: 18px; height: 18px; border-radius: 5px;
    border: 1.5px solid rgba(255,255,255,0.1);
    cursor: pointer; flex-shrink: 0;
    transition: transform 0.1s, border-color 0.1s, box-shadow 0.1s;
    padding: 0;
  }
  .swatch:hover { transform: scale(1.2); border-color: rgba(255,255,255,0.3); }
  .swatch.active {
    border-color: #fff;
    box-shadow: 0 0 0 1.5px var(--accent);
    transform: scale(1.1);
  }
  #color-picker {
    width: 28px; height: 28px; padding: 2px;
    border-radius: 7px; border: 1.5px solid rgba(255,255,255,0.12);
    cursor: pointer; background: var(--bg3);
  }
  #color-history { flex-shrink: 0; display: flex; align-items: center; gap: 2px; }

  /* Fill toggle */
  #fill-toggle-wrap {
    display: flex; align-items: center; gap: 3px;
    flex-shrink: 0;
  }
  #fill-color { width: 26px; height: 26px; border-radius: 6px; cursor: pointer; padding: 2px; border: 1.5px solid var(--border2); }
  .fill-none-btn {
    font-size: 0.85rem; padding: 3px 6px;
    border: 1px solid var(--border); border-radius: 5px;
    background: transparent; color: var(--text-dim);
    cursor: pointer; transition: background 0.1s, color 0.1s;
  }
  .fill-none-btn.active { background: var(--bg3); color: var(--text); }

  /* Font size */
  #font-size-wrap {
    display: flex; align-items: center; gap: 4px; flex-shrink: 0;
  }
  #font-size-input { width: 46px; border-radius: 5px; text-align: center; font-size: 0.78rem; }

  /* Zoom controls */
  #zoom-wrap {
    display: flex; align-items: center; gap: 1px; flex-shrink: 0;
  }
  #zoom-label {
    font-family: var(--mono); font-size: 0.68rem;
    color: var(--text-dim); min-width: 38px; text-align: center;
    cursor: pointer; padding: 2px 4px; border-radius: 4px;
    transition: background 0.1s, color 0.1s;
  }
  #zoom-label:hover { background: var(--bg3); color: var(--text); }

  /* ── Member panel ── */
  #member-panel {
    background: var(--bg);
    border-left: 1px solid rgba(255,255,255,0.045);
  }
  .panel-header {
    height: 44px; padding: 0 14px;
    border-bottom: 1px solid rgba(255,255,255,0.045);
    display: flex; align-items: center; justify-content: space-between;
  }
  .member-row {
    padding: 7px 12px;
    border-radius: 8px;
    margin: 1px 6px;
    transition: background 0.1s;
  }
  .member-row:hover { background: var(--bg3); }
  .member-avatar {
    width: 30px; height: 30px;
    font-size: 0.72rem;
    border-radius: 9px;
    flex-shrink: 0;
  }
  .member-name { font-size: 0.82rem; font-weight: 500; }
  .member-badge { font-size: 0.62rem; }

  /* ── Mod menu ── */
  #mod-menu {
    border-radius: 10px !important;
    padding: 6px !important;
    background: var(--bg2) !important;
    box-shadow: 0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06) !important;
    z-index: 9000 !important;
  }
  #mod-menu-peer-name {
    font-size: 0.72rem !important;
    padding: 6px 10px 4px !important;
    color: var(--text) !important;
    font-weight: 600 !important;
  }
  .mod-menu-item {
    border-radius: 6px !important;
    padding: 8px 12px !important;
    font-size: 0.8rem !important;
    transition: background 0.1s !important;
  }
  .mod-menu-item:hover { background: var(--bg4) !important; }
  .mod-menu-item.danger:hover { background: rgba(248,113,113,0.12) !important; color: var(--danger) !important; }

  /* ── Chat panel ── */
  #chat-panel {
    border-left: 1px solid rgba(255,255,255,0.045);
    background: var(--bg);
  }
  .chat-msg-bubble {
    border-radius: 10px !important;
    font-size: 0.82rem !important;
  }

  /* ── Visibility chip ── */
  .visibility-chip {
    font-size: 0.6rem;
    padding: 2px 7px;
    border-radius: 20px;
    letter-spacing: 0.06em;
  }
  .chip-public  { background: rgba(34,211,165,0.1); color: var(--green); border: 1px solid rgba(34,211,165,0.2); }
  .chip-private { background: rgba(248,113,113,0.1); color: var(--danger); border: 1px solid rgba(248,113,113,0.2); }

  /* ── No board hint ── */
  #no-board-hint {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    text-align: center; pointer-events: none;
    opacity: 0.35;
  }

  /* ── Toast ── */
  #toast {
    border-radius: 10px !important;
    font-size: 0.8rem !important;
    padding: 9px 16px !important;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4) !important;
    backdrop-filter: blur(8px) !important;
  }

  /* ── Buttons ── */
  .btn {
    border-radius: 7px;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 7px 14px;
    transition: background 0.12s, border-color 0.12s, transform 0.08s;
  }
  .btn:active { transform: scale(0.97); }
  .btn-primary {
    background: var(--accent);
    border: 1px solid transparent;
  }
  .btn-primary:hover { background: var(--accent2); }
  .btn-ghost {
    background: transparent;
    border: 1px solid var(--border2);
    color: var(--text-mid);
  }
  .btn-ghost:hover { background: var(--bg3); color: var(--text); border-color: var(--border2); }

  /* ── Settings modal ── */
  .settings-section { padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.045); }
  .settings-section-title {
    font-size: 0.62rem; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--text-dim); font-weight: 600; margin-bottom: 10px;
  }
  .setting-row {
    padding: 7px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .setting-row:last-child { border-bottom: none; }
  .setting-row-label { font-size: 0.83rem; font-weight: 500; color: var(--text); }
  .setting-row-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }

  /* ── Leave + mini-buttons in header ── */
  #leave-board-btn {
    border-radius: 7px !important;
    font-size: 0.72rem !important;
  }

  /* ── Layers panel ── */
  #layers-panel { border-radius: 10px !important; }
  .layer-row { border-radius: 6px !important; }

  /* ── Minimap ── */
  #minimap-wrap { border-radius: 10px !important; }

  /* ── Onboarding ── */
  .onboard-card {
    border-radius: 16px;
    padding: 36px 32px;
    background: var(--bg2);
    border: 1px solid rgba(255,255,255,0.06);
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    max-width: 360px;
    width: 90vw;
  }
  .onboard-logo { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.03em; gap: 10px; }
  .onboard-tagline { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 24px; }
  .input-styled {
    border-radius: 8px;
    font-size: 0.88rem;
    padding: 10px 13px;
    background: var(--bg3);
    border: 1px solid var(--border);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .input-styled:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(124,106,255,0.12);
  }

  /* ── Scrollbars ── */
  ::-webkit-scrollbar { width: 3px; height: 3px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
  ::-webkit-scrollbar-track { background: transparent; }

  /* ── Focus rings ── */
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Mobile adjustments on top of the new tokens */
  @media (max-width: 768px) {
    :root { --sidebar-w: min(260px, 88vw); --header-h: 44px; }
    #board-topic-input { display: none; }
    #board-name-display { max-width: 120px; }
    .board-item { margin: 1px 6px; }
  }

  `;
  document.head.appendChild(uiCSS);

  // ── 20. VIS TOGGLE DOM patch moved to section 27 (sprite-swap square) ──────

  // Section 20 vis-toggle CSS intentionally removed — replaced by section 27 sprite-swap square.

  // ── 21. COMPACT MIC BUTTON — hidden in header by section 27 ────────────────

  // ── 22. LEAVE BUTTON: always icon-only ────────────────────────────────────
  (function compactLeave() {
    setTimeout(() => {
      const lb = document.getElementById('leave-board-btn');
      if (!lb) return;
      // Kill any text nodes / spans that aren't SVG
      [...lb.childNodes].forEach(n => {
        if (n.nodeType === Node.TEXT_NODE) n.remove();
        if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'SVG' && n.tagName.toLowerCase() !== 'svg') n.remove();
      });
      lb.style.cssText += `padding:6px 7px!important;font-size:0!important;gap:0!important;`;
      lb.title = 'Leave board';
    }, 400);
  })();

  // ── 23. HOST-CONTROLLED AUDIO MUTE ────────────────────────────────────────
  (function patchAudioMute() {
    // Extend state
    setTimeout(() => {
      if (typeof state !== 'undefined') {
        if (!state.audioMutedPeers) state.audioMutedPeers = new Set();
        if (!('isAudioMuted' in state)) state.isAudioMuted = false;
      }
    }, 300);

    // Add "Mute mic" item to mod menu after existing items load
    setTimeout(() => {
      const menu = document.getElementById('mod-menu');
      if (!menu) return;
      const kickBtn = document.getElementById('mod-kick-btn');
      if (!kickBtn) return;

      const audioMuteBtn = document.createElement('button');
      audioMuteBtn.id = 'mod-audiomute-btn';
      audioMuteBtn.className = 'mod-menu-item';
      audioMuteBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="1" width="5" height="7" rx="2.5"/>
          <path d="M2 6.5A4.5 4.5 0 0 0 11 6.5M6.5 11v1.5"/>
          <line x1="2" y1="2" x2="11" y2="11" stroke="var(--danger)" stroke-width="1.8"/>
        </svg>
        <span id="mod-audiomute-label">Mute mic</span>
      `;
      audioMuteBtn.onclick = () => {
        const targetId = menu._targetPeerId;
        if (!targetId) return;
        modAudioMute(targetId);
        menu.classList.remove('open');
      };
      menu.insertBefore(audioMuteBtn, kickBtn);
    }, 500);

    // Update label when menu opens
    const _origShowModMenu = window.showModMenu;
    if (typeof _origShowModMenu === 'function') {
      window.showModMenu = function(peerId, x, y) {
        _origShowModMenu.call(this, peerId, x, y);
        setTimeout(() => {
          const menu = document.getElementById('mod-menu');
          if (!menu) return;
          const lbl = document.getElementById('mod-audiomute-label');
          if (!lbl) return;
          const isMuted = state?.audioMutedPeers?.has(peerId);
          lbl.textContent = isMuted ? 'Unmute mic' : 'Mute mic';
          const audioMuteBtn = document.getElementById('mod-audiomute-btn');
          if (audioMuteBtn) audioMuteBtn.style.display = state?.isBoardHost ? '' : 'none';
        }, 10);
      };
    }

    // Patch handleData to process new message types
    const _origHandleData = window.handleData;
    if (typeof _origHandleData === 'function') {
      window.handleData = function(peerId, data) {
        if (data.type === 'mod-audio-mute') {
          state.isAudioMuted = true;
          // Disable mic tracks
          if (typeof voiceState !== 'undefined' && voiceState.localStream) {
            voiceState.localStream.getAudioTracks().forEach(t => { t.enabled = false; });
          }
          // Show lock badge on self in member list
          const selfRow = document.querySelector('.member-row[data-peer-id="me"], .member-row.self');
          if (selfRow) {
            let badge = selfRow.querySelector('.audio-muted-badge');
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'audio-muted-badge draw-muted-badge';
              badge.textContent = 'mic muted';
              const nameEl = selfRow.querySelector('.member-name');
              if (nameEl) nameEl.after(badge);
            }
          }
          // Disable the mute-btn so user can't self-unmute
          const muteBtn = document.getElementById('mute-btn');
          if (muteBtn) {
            muteBtn.disabled = true;
            muteBtn.title = 'Your mic was muted by the host';
            muteBtn.style.opacity = '0.4';
            muteBtn.style.pointerEvents = 'none';
          }
          if (typeof toast === 'function') toast('Your mic was muted by the host', 'red');
          return;
        }
        if (data.type === 'mod-audio-unmute') {
          state.isAudioMuted = false;
          // Re-enable mic tracks
          if (typeof voiceState !== 'undefined' && voiceState.localStream) {
            voiceState.localStream.getAudioTracks().forEach(t => { t.enabled = !voiceState.isMuted; });
          }
          const muteBtn = document.getElementById('mute-btn');
          if (muteBtn) {
            muteBtn.disabled = false;
            muteBtn.title = 'Toggle mic';
            muteBtn.style.opacity = '';
            muteBtn.style.pointerEvents = '';
          }
          if (typeof toast === 'function') toast('Your mic was unmuted', 'info');
          return;
        }
        return _origHandleData.call(this, peerId, data);
      };
    }
  })();

  // Host function: toggle audio mute for a peer
  window.modAudioMute = function(peerId) {
    if (!state?.isBoardHost) return;
    if (!state.audioMutedPeers) state.audioMutedPeers = new Set();
    const name = state.connections?.[peerId]?.name || peerId;
    if (state.audioMutedPeers.has(peerId)) {
      state.audioMutedPeers.delete(peerId);
      try { state.connections[peerId]?.conn.send({ type: 'mod-audio-unmute' }); } catch {}
      if (typeof toast === 'function') toast(`Unmuted mic for ${name}`);
    } else {
      state.audioMutedPeers.add(peerId);
      try { state.connections[peerId]?.conn.send({ type: 'mod-audio-mute' }); } catch {}
      if (typeof toast === 'function') toast(`Mic muted for ${name}`, 'red');
    }
    if (typeof renderMembers === 'function') renderMembers();
  };

  // ── 24. DRAW-MUTE = FULL BLOCK (pan + zoom too) ───────────────────────────
  (function patchDrawMuteFullBlock() {
    const _origOnPointerDown = window.onPointerDown;
    // Wrap canvas events at capture phase
    setTimeout(() => {
      const cv = document.getElementById('board-canvas');
      if (!cv) return;
      cv.addEventListener('pointerdown', e => {
        if (state?.isDrawMuted) { e.stopImmediatePropagation(); e.preventDefault(); }
      }, true);
      cv.addEventListener('wheel', e => {
        if (state?.isDrawMuted) { e.stopImmediatePropagation(); e.preventDefault(); }
      }, { capture: true, passive: false });
    }, 800);

    // Also show a clear "locked" overlay when draw-muted
    const lockStyle = document.createElement('style');
    lockStyle.textContent = `
      #board-canvas.draw-muted {
        cursor: not-allowed !important;
        outline: 2px solid rgba(248,113,113,0.35) !important;
        outline-offset: -2px;
      }
      #draw-muted-overlay {
        position: absolute; inset: 0; z-index: 10;
        display: none; align-items: center; justify-content: center;
        pointer-events: none;
      }
      #draw-muted-overlay.active { display: flex; }
      .draw-muted-msg {
        background: rgba(248,113,113,0.12);
        border: 1px solid rgba(248,113,113,0.3);
        color: var(--danger);
        padding: 6px 12px; border-radius: 8px;
        font-size: 0.75rem; font-weight: 600;
        letter-spacing: 0.04em;
        pointer-events: none;
      }
    `;
    document.head.appendChild(lockStyle);

    // Create overlay
    setTimeout(() => {
      const area = document.getElementById('canvas-area');
      if (!area) return;
      area.style.position = 'relative';
      const overlay = document.createElement('div');
      overlay.id = 'draw-muted-overlay';
      overlay.innerHTML = `<span class="draw-muted-msg">Drawing muted by host</span>`;
      area.appendChild(overlay);

      // Observer for draw-muted class on canvas
      const obs = new MutationObserver(() => {
        const cv = document.getElementById('board-canvas');
        const ov = document.getElementById('draw-muted-overlay');
        if (!cv || !ov) return;
        ov.classList.toggle('active', cv.classList.contains('draw-muted'));
      });
      const cv2 = document.getElementById('board-canvas');
      if (cv2) obs.observe(cv2, { attributes: true, attributeFilter: ['class'] });
    }, 900);
  })();

  // ── 25. DRAGGABLE / DETACHABLE PANELS ─────────────────────────────────────
  const panelDragCSS = document.createElement('style');
  panelDragCSS.textContent = `
    .panel-grip {
      cursor: grab; background: none; border: none;
      padding: 4px; border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0.35; transition: opacity 0.15s;
      flex-shrink: 0;
    }
    .panel-grip:hover { opacity: 0.8; background: var(--bg3); }
    .panel-grip:active { cursor: grabbing; }
    .panel--floating {
      border-radius: 12px !important;
      box-shadow: 0 20px 56px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.07) !important;
      overflow: hidden;
      resize: both;
    }
    .panel--floating .panel-grip { opacity: 0.6; }
    .panel-dock-btn {
      width: 24px; height: 24px;
      border-radius: 5px; border: none;
      background: var(--bg3); color: var(--text-dim);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; margin-left: auto; flex-shrink: 0;
      transition: background 0.1s, color 0.1s;
    }
    .panel-dock-btn:hover { background: var(--accent-dim); color: var(--accent); }
  `;
  document.head.appendChild(panelDragCSS);

  (function setupDraggablePanels() {
    const CONFIGS = [
      { id: 'member-panel', headerSel: '.member-panel-header' },
      { id: 'chat-panel',   headerSel: '.chat-header' },
    ];
    const SNAP_EDGE_PX = 80;

    CONFIGS.forEach(({ id, headerSel }) => {
      const panel = document.getElementById(id);
      if (!panel) return;
      const header = panel.querySelector(headerSel);
      if (!header) return;

      let floating = false, dragging = false, ox = 0, oy = 0;

      // Drag grip icon
      const grip = document.createElement('button');
      grip.className = 'panel-grip';
      grip.title = 'Drag to float · double-click to re-dock';
      grip.innerHTML = `<svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
        <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
        <circle cx="3" cy="6"   r="1.2"/><circle cx="7" cy="6"   r="1.2"/>
        <circle cx="3" cy="9.5" r="1.2"/><circle cx="7" cy="9.5" r="1.2"/>
      </svg>`;
      header.insertBefore(grip, header.firstChild);

      function detach() {
        if (floating) return;
        const rect = panel.getBoundingClientRect();
        panel._savedParent = panel.parentElement;
        panel._savedNext   = panel.nextElementSibling;
        document.body.appendChild(panel);
        Object.assign(panel.style, {
          position: 'fixed',
          left: rect.left + 'px',
          top:  rect.top  + 'px',
          width:  rect.width  + 'px',
          height: rect.height + 'px',
          zIndex: '8400',
          display: 'flex',
          flexDirection: 'column',
        });
        panel.classList.add('panel--floating');
        floating = true;

        // Dock button in header
        if (!header.querySelector('.panel-dock-btn')) {
          const dockBtn = document.createElement('button');
          dockBtn.className = 'panel-dock-btn';
          dockBtn.title = 'Dock panel back';
          dockBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 6h8M7 3l3 3-3 3"/></svg>`;
          dockBtn.addEventListener('click', e => { e.stopPropagation(); dock(); });
          header.appendChild(dockBtn);
        }
      }

      function dock() {
        if (!floating) return;
        const parent  = panel._savedParent;
        const nextSib = panel._savedNext;
        if (parent) {
          if (nextSib && nextSib.parentElement === parent) parent.insertBefore(panel, nextSib);
          else parent.appendChild(panel);
        }
        ['position','left','top','width','height','zIndex'].forEach(p => panel.style[p] = '');
        panel.classList.remove('panel--floating');
        const db = header.querySelector('.panel-dock-btn');
        if (db) db.remove();
        floating = false;
      }

      // Grip mouse drag
      grip.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        if (!floating) detach();
        const rect = panel.getBoundingClientRect();
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;
        dragging = true;
      });

      // Grip touch drag
      grip.addEventListener('touchstart', e => {
        e.preventDefault();
        if (!floating) detach();
        const t = e.touches[0];
        const rect = panel.getBoundingClientRect();
        ox = t.clientX - rect.left;
        oy = t.clientY - rect.top;
        dragging = true;
      }, { passive: false });

      document.addEventListener('mousemove', e => {
        if (!dragging || !floating) return;
        panel.style.left = (e.clientX - ox) + 'px';
        panel.style.top  = (e.clientY - oy) + 'px';
      });

      document.addEventListener('touchmove', e => {
        if (!dragging || !floating) return;
        const t = e.touches[0];
        panel.style.left = (t.clientX - ox) + 'px';
        panel.style.top  = (t.clientY - oy) + 'px';
      }, { passive: false });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        // Snap back to right edge if close enough
        if (floating) {
          const x = parseFloat(panel.style.left) || 0;
          if (x + (panel.offsetWidth || 280) > window.innerWidth - SNAP_EDGE_PX) {
            dock();
          }
        }
      });

      document.addEventListener('touchend', () => { dragging = false; });

      // Double-click header to toggle float/dock
      header.addEventListener('dblclick', e => {
        if (e.target === grip) return;
        floating ? dock() : detach();
      });
    });
  })();

  // ── 26. COMPREHENSIVE UI POLISH (CSS) ────────────────────────────────────
  // See section 27 below for DOM / behaviour changes.
  (function applyUIPolish() {
    const css = document.createElement('style');
    css.id = 'slate-ui-polish';
    css.textContent = `

/* ══════════════════════════════════════════════════════════════
   DESIGN FOUNDATION
══════════════════════════════════════════════════════════════ */
:root {
  --header-h:  46px;
  --toolbar-h: 46px;
  --sidebar-w: 228px;
  --panel-border: rgba(255,255,255,0.055);
  --bg-chrome: #0e0e11;
  --chrome-sep: rgba(255,255,255,0.06);
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════════════════════════ */
#sidebar {
  width: var(--sidebar-w);
  background: var(--bg-chrome);
  border-right: 1px solid var(--panel-border);
  display: flex; flex-direction: column;
}

/* Logo row */
.sidebar-header {
  height: var(--header-h);
  padding: 0 14px;
  display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--chrome-sep);
  flex-shrink: 0;
}
.sidebar-logo {
  font-size: 0.92rem; font-weight: 700;
  letter-spacing: -0.025em; gap: 7px;
  color: var(--text);
}
.sidebar-logo svg { opacity: 0.9; }

#conn-pill {
  font-size: 0.65rem; padding: 2px 7px;
  border-radius: 20px;
}

#sidebar-settings-btn {
  margin-left: auto;
  width: 28px; height: 28px; padding: 6px;
  border-radius: 7px; background: transparent;
  border: none; color: var(--text-dim);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
  flex-shrink: 0;
}
#sidebar-settings-btn:hover { opacity: 1; background: var(--bg3); }

/* Boards section */
.sidebar-section {
  padding: 14px 14px 6px;
  flex-shrink: 0;
}
.sidebar-section-label {
  font-size: 0.6rem; font-family: var(--mono);
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--text-dim); font-weight: 600;
}

#board-scroll {
  flex: 1; overflow-y: auto;
  padding: 2px 0 4px;
}

/* Board items */
.board-item {
  display: flex; align-items: center; gap: 8px;
  margin: 1px 8px; padding: 7px 10px;
  border-radius: 8px; cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.12s, border-color 0.12s;
  position: relative;
}
.board-item:hover { background: rgba(255,255,255,0.045); }
.board-item.active {
  background: rgba(124,106,255,0.10);
  border-left-color: var(--accent);
}
.board-item__icon {
  width: 26px; height: 26px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.055);
  font-size: 0.7rem; font-weight: 700; color: var(--text-mid);
  flex-shrink: 0;
}
.board-item.active .board-item__icon {
  background: rgba(124,106,255,0.2); color: var(--accent);
}
.board-item.active-drawing .board-item__icon {
  box-shadow: 0 0 0 2px var(--green);
}
.board-item__name {
  flex: 1; font-size: 0.82rem; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-mid);
}
.board-item.active .board-item__name { color: var(--text); }
.board-item__count {
  font-size: 0.65rem; font-family: var(--mono);
  color: var(--text-dim); flex-shrink: 0;
  min-width: 16px; text-align: right;
}
.board-item.active .board-item__count { color: rgba(255,255,255,0.45); }

/* Saved boards */
.saved-folder-header {
  font-size: 0.78rem; font-weight: 500;
  color: var(--text-dim);
  padding: 4px 10px; border-radius: 7px;
  transition: background 0.1s, color 0.1s;
}
.saved-folder-header:hover { background: rgba(255,255,255,0.045); color: var(--text); }

/* ── Sidebar bottom: Create / Join ── */
.sidebar-create {
  border-top: 1px solid var(--chrome-sep);
  padding: 10px 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
  flex-shrink: 0;
}

/* Shared input style for create + join rows */
.sidebar-create input[type="text"] {
  flex: 1; min-width: 0;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 7px 11px;
  font-size: 0.81rem; font-family: var(--sans);
  color: var(--text); outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.sidebar-create input[type="text"]::placeholder { color: var(--text-dim); }
.sidebar-create input[type="text"]:focus {
  border-color: rgba(124,106,255,0.5);
  background: rgba(124,106,255,0.06);
}

/* Row layout */
.create-row {
  display: flex; align-items: center; gap: 5px;
}
#join-private-row {
  display: flex; align-items: center; gap: 5px;
}

/* Create button (+) */
#create-board-btn {
  width: 30px; height: 30px; padding: 0; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; font-size: 1.1rem; font-weight: 500;
  background: var(--accent); color: #fff; border: none;
  transition: background 0.15s, transform 0.1s;
}
#create-board-btn:hover { background: var(--accent2); }
#create-board-btn:active { transform: scale(0.94); }

/* Join button (→) */
#join-private-btn {
  width: 30px; height: 30px; padding: 0; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; font-size: 1rem;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.1);
  color: var(--text-mid);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
#join-private-btn:hover {
  background: rgba(255,255,255,0.07);
  border-color: rgba(255,255,255,0.18); color: var(--text);
}

/* Vis toggle pill */
#vis-toggle-btn.vis-toggle {
  flex-shrink: 0;
}

/* ══════════════════════════════════════════════════════════════
   HEADER
══════════════════════════════════════════════════════════════ */
#board-header {
  height: var(--header-h);
  background: var(--bg-chrome);
  border-bottom: 1px solid var(--chrome-sep);
  display: flex; align-items: center;
  padding: 0 10px; gap: 4px;
  flex-shrink: 0; z-index: 5;
}

#sidebar-toggle {
  width: 30px; height: 30px; padding: 6px;
  border-radius: 7px; background: transparent; border: none;
  color: var(--text-dim); opacity: 0.6;
  display: none; align-items: center; justify-content: center;
  transition: opacity 0.15s, background 0.15s; cursor: pointer;
}
#sidebar-toggle:hover { opacity: 1; background: rgba(255,255,255,0.06); }
@media (max-width: 768px) { #sidebar-toggle { display: flex; } }

/* Board name */
#board-name-display {
  font-size: 0.88rem; font-weight: 600;
  letter-spacing: -0.015em; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 140px; flex-shrink: 0;
}

/* Divider after board name area */
#board-header-sep {
  width: 1px; height: 18px;
  background: var(--chrome-sep);
  flex-shrink: 0; margin: 0 4px;
}

/* Topic input — grows to fill space */
#board-topic-input {
  flex: 1; min-width: 0;
  background: transparent; border: none;
  font-size: 0.8rem; font-family: var(--sans);
  color: var(--text-dim); outline: none;
  padding: 4px 8px;
  border-bottom: 1px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
#board-topic-input:focus { color: var(--text); border-bottom-color: var(--accent); }
#board-topic-input::placeholder { color: rgba(255,255,255,0.2); }

/* Visibility chip */
.visibility-chip {
  font-size: 0.6rem; font-family: var(--mono);
  padding: 2px 8px; border-radius: 20px;
  letter-spacing: 0.06em; flex-shrink: 0;
}
.chip-public  { background: rgba(34,211,165,0.1);  color: var(--green);  border: 1px solid rgba(34,211,165,0.22); }
.chip-private { background: rgba(248,113,113,0.08); color: var(--danger); border: 1px solid rgba(248,113,113,0.2); }

/* Header action group: share, save, export, voice, leave, chat, members */
/* All icon buttons in header share one style */
#board-header .btn-icon {
  width: 30px; height: 30px; padding: 6px;
  border-radius: 7px; background: transparent; border: none;
  color: var(--text-dim);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
#board-header .btn-icon:hover { background: rgba(255,255,255,0.07); color: var(--text); }

/* Compact text-icon buttons in header (Save, Export PNG) */
#save-board-btn,
#export-btn {
  display: none; /* shown via JS when in board */
  align-items: center; gap: 4px;
  padding: 5px 9px; border-radius: 7px;
  font-size: 0.72rem; font-weight: 500; flex-shrink: 0;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.09);
  color: var(--text-dim);
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  cursor: pointer;
  white-space: nowrap;
}
#save-board-btn:hover, #export-btn:hover {
  background: rgba(255,255,255,0.06);
  color: var(--text); border-color: rgba(255,255,255,0.16);
}

/* Vertical spacer in header to push actions right */
#header-spacer {
  flex: 1;
}

/* Voice button */
#voice-toggle-btn {
  width: 30px !important; height: 30px !important;
  padding: 6px !important; border-radius: 7px !important;
  font-size: 0 !important; gap: 0 !important;
  background: transparent !important;
  border: 1px solid rgba(255,255,255,0.09) !important;
  color: var(--text-dim) !important;
  display: flex !important; align-items: center !important; justify-content: center !important;
  flex-shrink: 0 !important; position: relative !important;
  transition: background 0.12s !important, color 0.12s !important;
}
#voice-toggle-btn:hover { background: rgba(255,255,255,0.07) !important; color: var(--text) !important; }
#voice-toggle-btn .voice-dot {
  position: absolute; top: 5px; right: 5px;
  width: 6px; height: 6px; border-radius: 3px;
  background: var(--text-dim);
  transition: background 0.2s; pointer-events: none;
}
#voice-toggle-btn[data-live="true"] .voice-dot { background: var(--green); }
#voice-toggle-label { display: none !important; }

/* Leave board: icon-only in header */
#leave-board-btn {
  width: 30px !important; height: 30px !important;
  padding: 6px !important; border-radius: 7px !important;
  font-size: 0 !important; gap: 0 !important;
  background: transparent !important;
  border: 1px solid rgba(248,113,113,0.2) !important;
  color: var(--danger) !important; opacity: 0.7 !important;
  transition: background 0.12s !important, opacity 0.12s !important;
}
#leave-board-btn:hover { background: rgba(248,113,113,0.1) !important; opacity: 1 !important; }

/* ══════════════════════════════════════════════════════════════
   DRAWING TOOLBAR
══════════════════════════════════════════════════════════════ */
#draw-toolbar {
  height: var(--toolbar-h);
  background: var(--bg-chrome);
  border-bottom: 1px solid var(--chrome-sep);
  padding: 0 8px;
  gap: 1px;
  display: flex; align-items: center;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none; flex-shrink: 0;
}
#draw-toolbar::-webkit-scrollbar { display: none; }

/* Tool buttons */
.tool-btn {
  width: 32px; height: 32px; padding: 6px;
  border-radius: 7px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-dim);
  transition: background 0.1s, color 0.1s, transform 0.08s;
  position: relative;
}
.tool-btn:hover:not(.active) { background: rgba(255,255,255,0.06); color: var(--text); }
.tool-btn.active {
  background: rgba(124,106,255,0.14); color: var(--accent);
}
/* Active dot */
.tool-btn.active::after {
  content: '';
  position: absolute; bottom: 2px; left: 50%;
  transform: translateX(-50%);
  width: 3px; height: 3px; border-radius: 2px;
  background: var(--accent);
}
.tool-btn:active { transform: scale(0.9); }
.tool-btn:disabled { opacity: 0.25; cursor: default; pointer-events: none; }

/* Separators — visual groups */
.toolbar-sep {
  width: 1px; height: 18px;
  background: rgba(255,255,255,0.07);
  margin: 0 5px; flex-shrink: 0;
}
.toolbar-spacer { flex: 1; min-width: 4px; }

/* Stroke size */
#stroke-size-wrap {
  display: flex; align-items: center; gap: 4px;
  padding: 0 2px; flex-shrink: 0;
}
#stroke-size { width: 56px; accent-color: var(--accent); }

/* Color swatches */
#color-swatches {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0;
}
.swatch {
  width: 17px; height: 17px; border-radius: 5px;
  border: 1.5px solid rgba(255,255,255,0.1);
  cursor: pointer; flex-shrink: 0; padding: 0;
  transition: transform 0.1s, border-color 0.1s, box-shadow 0.1s;
}
.swatch:hover { transform: scale(1.2); border-color: rgba(255,255,255,0.3); }
.swatch.active { border-color: #fff; box-shadow: 0 0 0 1.5px var(--accent); transform: scale(1.1); }

#color-picker {
  width: 28px; height: 28px; border-radius: 7px;
  border: 1.5px solid rgba(255,255,255,0.12);
  background: var(--bg3); cursor: pointer; padding: 2px;
  overflow: hidden;
}
#color-picker::-webkit-color-swatch-wrapper { padding: 0; }
#color-picker::-webkit-color-swatch { border: none; border-radius: 4px; }

/* Color history (features.js) */
#color-history { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
.color-hist-swatch { border-radius: 5px !important; }

/* Fill controls */
#fill-toggle-wrap {
  display: flex; align-items: center; gap: 3px; flex-shrink: 0;
}
#fill-color {
  width: 26px; height: 26px; border-radius: 7px;
  border: 1.5px solid rgba(255,255,255,0.1);
  background: var(--bg3); cursor: pointer; padding: 2px;
}
.fill-none-btn {
  font-size: 0.82rem; padding: 4px 7px;
  border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
  background: transparent; color: var(--text-dim); cursor: pointer;
  transition: background 0.1s, color 0.1s;
  line-height: 1;
}
.fill-none-btn:hover { background: rgba(255,255,255,0.06); color: var(--text); }
.fill-none-btn.active { background: rgba(255,255,255,0.08); color: var(--text); border-color: rgba(255,255,255,0.18); }

/* Font size (text tool) */
#font-size-wrap {
  display: flex; align-items: center; gap: 4px;
  flex-shrink: 0;
  color: var(--text-dim);
}
#font-size-input {
  width: 46px; text-align: center;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; color: var(--text);
  font-family: var(--mono); font-size: 0.76rem;
  padding: 3px 5px; outline: none;
  transition: border-color 0.15s;
}
#font-size-input:focus { border-color: var(--accent); }

/* Opacity (features.js) */
#opacity-wrap {
  display: flex; align-items: center; gap: 4px;
  padding: 0 4px; flex-shrink: 0;
}
#opacity-slider { width: 52px; accent-color: var(--accent); }
#opacity-label {
  font-size: 0.67rem; color: var(--text-dim);
  font-family: var(--mono); min-width: 26px; text-align: right;
}

/* Zoom controls */
#zoom-wrap {
  display: flex; align-items: center; gap: 1px; flex-shrink: 0;
}
#zoom-label {
  font-family: var(--mono); font-size: 0.68rem;
  color: var(--text-dim); min-width: 38px; text-align: center;
  cursor: pointer; padding: 2px 5px; border-radius: 5px;
  transition: background 0.1s, color 0.1s;
  user-select: none;
}
#zoom-label:hover { background: rgba(255,255,255,0.06); color: var(--text); }

/* Layers + shortcuts (features.js) */
#layers-toolbar-btn {
  height: 30px; padding: 5px 10px !important;
  border-radius: 7px !important; font-size: 0.76rem !important;
}
#shortcuts-hint-btn { font-size: 0.82rem !important; }

/* ══════════════════════════════════════════════════════════════
   MEMBER & CHAT PANELS
══════════════════════════════════════════════════════════════ */
#member-panel, #chat-panel {
  background: var(--bg-chrome);
  border-left: 1px solid var(--panel-border);
}

.member-panel-header, .chat-header {
  height: var(--header-h);
  padding: 0 14px;
  border-bottom: 1px solid var(--chrome-sep);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}

.member-panel-title, .chat-header-title {
  font-size: 0.62rem; font-family: var(--mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--text-dim); font-weight: 600;
}

.member-row {
  display: flex; align-items: center;
  margin: 1px 6px; padding: 6px 10px;
  border-radius: 8px; cursor: pointer; gap: 8px;
  transition: background 0.1s;
}
.member-row:hover { background: rgba(255,255,255,0.045); }

.member-avatar {
  width: 30px; height: 30px;
  border-radius: 9px; font-size: 0.72rem; font-weight: 700;
  flex-shrink: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
}

/* ══════════════════════════════════════════════════════════════
   TOAST & MODALS
══════════════════════════════════════════════════════════════ */
#toast {
  border-radius: 10px !important;
  font-size: 0.8rem !important;
  padding: 8px 16px !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
}

.modal-card {
  border-radius: 14px; background: var(--bg2);
  border: 1px solid rgba(255,255,255,0.07);
  box-shadow: 0 24px 60px rgba(0,0,0,0.6);
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS PANEL
══════════════════════════════════════════════════════════════ */
.settings-panel { border-radius: 14px !important; }
.settings-header {
  height: 50px; padding: 0 18px;
  border-bottom: 1px solid var(--chrome-sep) !important;
  display: flex; align-items: center;
}
.settings-body { padding: 8px 0 16px; }
.settings-section {
  padding: 12px 18px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  gap: 8px;
}
.settings-section:last-child { border-bottom: none; }
.settings-section-title {
  font-size: 0.6rem; font-family: var(--mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--text-dim); margin-bottom: 10px;
}
.setting-row {
  background: transparent !important;
  border: none !important;
  border-bottom: 1px solid rgba(255,255,255,0.04) !important;
  border-radius: 0 !important;
  padding: 8px 0 !important;
}
.setting-row:last-child { border-bottom: none !important; }
.setting-row-label { font-size: 0.84rem; font-weight: 500; }
.setting-row-sub { font-size: 0.72rem; color: var(--text-dim); margin-top: 2px; }

/* ══════════════════════════════════════════════════════════════
   ONBOARDING
══════════════════════════════════════════════════════════════ */
.onboard-card {
  max-width: 360px; width: calc(100vw - 40px);
  border-radius: 18px; padding: 36px 32px;
  background: var(--bg2);
  border: 1px solid rgba(255,255,255,0.065);
  box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px var(--accent-glow);
}
.onboard-logo { font-size: 1.4rem; letter-spacing: -0.03em; gap: 10px; }
.onboard-tagline { font-size: 0.8rem; margin-top: -14px; }
.input-styled { border-radius: 9px; padding: 10px 13px; font-size: 0.87rem; }

/* ══════════════════════════════════════════════════════════════
   LAYERS + MINIMAP (features.js)
══════════════════════════════════════════════════════════════ */
#layers-panel { border-radius: 11px !important; }
#minimap-wrap { border-radius: 10px !important; }

/* ══════════════════════════════════════════════════════════════
   GLOBAL SCROLLBARS
══════════════════════════════════════════════════════════════ */
::-webkit-scrollbar { width: 3px; height: 3px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
::-webkit-scrollbar-track { background: transparent; }

/* ══════════════════════════════════════════════════════════════
   FOCUS RINGS
══════════════════════════════════════════════════════════════ */
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus-visible  { outline: none; }

/* ══════════════════════════════════════════════════════════════
   MOBILE
══════════════════════════════════════════════════════════════ */
@media (max-width: 768px) {
  :root { --sidebar-w: min(260px, 88vw); }
  #board-topic-input { display: none; }
  #board-name-display { max-width: 100px; }
  #save-board-btn span, #export-btn span { display: none; }
  #save-board-btn, #export-btn { padding: 6px 7px !important; }
}
    `;
    document.head.appendChild(css);
  })(); // end applyUIPolishCSS

  // ── 27. DOM & BEHAVIOUR OVERHAUL ──────────────────────────────────────────
  // Addresses screenshot feedback:
  //  a) Hide hamburger + MEMBERS button on desktop (show on mobile)
  //  b) Hide the voice/mute button in header (it lives in the members panel)
  //  c) Replace the iOS vis-toggle pill with a clean square sprite-swap button
  //  d) Move visibility into the header as a small inline icon toggle (not pill)
  //  e) Fast board list refresh + fast vis-change broadcast to all peers
  (function domOverhaul() {

    /* ── a. Hide hamburger & members toggle on desktop ── */
    const hideOnDesktopCSS = document.createElement('style');
    hideOnDesktopCSS.textContent = `
      /* Desktop: sidebar is always visible, no need for hamburger or members btn */
      @media (min-width: 769px) {
        #sidebar-toggle  { display: none !important; }
        #members-toggle  { display: none !important; }
      }
      /* Mobile: show them */
      @media (max-width: 768px) {
        #sidebar-toggle { display: flex !important; }
        #members-toggle { display: flex !important; }
      }

      /* ── Hide voice/mute button from the header entirely ── */
      /* It already exists in the members panel on your own row */
      #voice-bar,
      #voice-toggle-btn,
      #mute-btn { display: none !important; }

      /* ── Vis-toggle: clean square icon button ── */
      #vis-toggle-btn.vis-toggle {
        width: 30px !important; height: 30px !important;
        padding: 0 !important; border-radius: 8px !important;
        display: inline-flex !important; align-items: center !important;
        justify-content: center !important;
        background: transparent !important;
        transition: background 0.12s, border-color 0.12s !important;
        overflow: visible !important; gap: 0 !important;
        flex-shrink: 0 !important;
        position: relative !important;
      }
      #vis-toggle-btn[aria-label="public"] {
        border: 1px solid rgba(34,211,165,0.35) !important;
        color: var(--green) !important;
        background: rgba(34,211,165,0.08) !important;
      }
      #vis-toggle-btn[aria-label="private"] {
        border: 1px solid rgba(248,113,113,0.35) !important;
        color: var(--danger) !important;
        background: rgba(248,113,113,0.08) !important;
      }
      #vis-toggle-btn .vt-knob { display: none !important; }
      #vis-toggle-btn .vis-label { display: none !important; }
      #vis-toggle-btn .vis-pub-icon,
      #vis-toggle-btn .vis-priv-icon {
        position: static !important; width: 14px !important; height: 14px !important;
        display: block !important; pointer-events: none; flex-shrink: 0;
      }
      /* Tooltip hover */
      #vis-toggle-btn:hover { filter: brightness(1.15) !important; }

      /* ── Header: flex spacer so actions cluster right ── */
      #header-spacer {
        flex: 1; min-width: 4px; pointer-events: none;
      }

      /* ── Header: remove the stand-alone public/private chip pill ── */
      #vis-chip { display: none !important; }

      /* ── Fast-update: make board-list re-render animation instant ── */
      .board-item { transition: background 0.08s, border-color 0.08s !important; }
    `;
    document.head.appendChild(hideOnDesktopCSS);

    /* ── b. Replace iOS vis-toggle with sprite-swap square ── */
    (function fixVisToggle() {
      const btn = document.getElementById('vis-toggle-btn');
      if (!btn) return;
      const currentLabel = btn.getAttribute('aria-label') || 'public';
      btn.innerHTML = `
        <svg class="vis-pub-icon" width="14" height="14" viewBox="0 0 14 14"
          fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
          style="${currentLabel === 'private' ? 'display:none' : ''}; pointer-events:none">
          <circle cx="7" cy="7" r="5.5"/>
          <path d="M7 1.5S5 4.5 5 7s2 5.5 2 5.5M7 1.5s2 3 2 5.5S7 12.5 7 12.5M1.5 7h11"/>
        </svg>
        <svg class="vis-priv-icon" width="14" height="14" viewBox="0 0 14 14"
          fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
          style="${currentLabel === 'private' ? '' : 'display:none'}; pointer-events:none">
          <rect x="2.5" y="6" width="9" height="7" rx="1.5"/>
          <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6"/>
        </svg>
        <span class="vis-label" style="display:none"></span>
      `;
      // Keep the original click handler — it calls toggleBoardVisibility() internally
      // but also intercept to broadcast immediately to all peers (see fast-sync below)
    })();

    /* ── c. Header flex spacer (board name left, actions right) ── */
    setTimeout(() => {
      const header = document.getElementById('board-header');
      if (!header || header.querySelector('#header-spacer')) return;
      const shareBtn = document.getElementById('share-board-btn');
      if (shareBtn) {
        const spacer = document.createElement('div');
        spacer.id = 'header-spacer';
        header.insertBefore(spacer, shareBtn);
      }
    }, 30);

    /* ── d. Fast board-list refresh: poll every 1.5 s instead of 10 s ── */
    // The lobby sync interval is set inside initPeer/setupLobby — we patch the
    // window-level scheduleRenderBoards to also fire immediately when called.
    let _lastRender = 0;
    const _origSched = window.scheduleRenderBoards;
    window.scheduleRenderBoards = function () {
      const now = Date.now();
      if (now - _lastRender > 200) { // debounce 200 ms
        _lastRender = now;
        if (typeof renderBoards === 'function') renderBoards();
      }
      if (_origSched) _origSched.apply(this, arguments);
    };

    // Kick a fast re-poll for lobby registry updates every 1.5 s
    setInterval(() => {
      if (typeof scheduleRenderBoards === 'function') scheduleRenderBoards();
    }, 1500);

    /* ── e. Fast vis-change: broadcast immediately when toggled ── */
    // Patch the existing toggleBoardVisibility to call lobbyBroadcast right away
    setTimeout(() => {
      const _origToggleVis = window.toggleBoardVisibility;
      if (_origToggleVis) {
        window.toggleBoardVisibility = function () {
          const r = _origToggleVis.apply(this, arguments);
          // Immediately tell lobby about the change
          try {
            if (typeof lobbyBroadcast === 'function' && typeof state !== 'undefined') {
              lobbyBroadcast({
                type: 'lobby-reg',
                id: state.myId,
                board: state.currentBoard,
                name: state.myName,
                visibility: typeof boardVisibility !== 'undefined'
                  ? (boardVisibility[state.currentBoard] || 'public')
                  : 'public',
              });
            }
          } catch (e) {}
          return r;
        };
      }
    }, 800);

    /* ── f. Keep vis-toggle sprites in sync after original click handler runs ── */
    setTimeout(() => {
      const btn = document.getElementById('vis-toggle-btn');
      if (!btn) return;
      const obs = new MutationObserver(() => {
        const label = btn.getAttribute('aria-label');
        const pub  = btn.querySelector('.vis-pub-icon');
        const priv = btn.querySelector('.vis-priv-icon');
        if (!pub || !priv) return;
        if (label === 'private') {
          pub.style.display  = 'none';
          priv.style.display = 'block';
        } else {
          pub.style.display  = 'block';
          priv.style.display = 'none';
        }
      });
      obs.observe(btn, { attributes: true, attributeFilter: ['aria-label'] });
    }, 400);

  })(); // end domOverhaul

})();
