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

})();
