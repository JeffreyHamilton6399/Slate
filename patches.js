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

  // ── 13. BOARD LIST: auto-prune empty boards on every lobby update ──────────
  // Bug: liveBoards keeps empty boards forever (pruneEmptyBoards only runs once at startup).
  // Fix: wrap scheduleRenderBoards to prune first.
  const _origScheduleRB = window.scheduleRenderBoards;
  window.scheduleRenderBoards = function (filter) {
    if (typeof pruneEmptyBoards === 'function') {
      try { pruneEmptyBoards(); } catch {}
    }
    if (_origScheduleRB) _origScheduleRB.apply(this, arguments);
  };
  // Also prune periodically so boards disappear even without a lobby update
  setInterval(() => {
    if (typeof pruneEmptyBoards === 'function') {
      try { const n = pruneEmptyBoards(); if (n && typeof scheduleRenderBoards === 'function') scheduleRenderBoards(); } catch {}
    }
  }, 12000);

  // ── 14. HOST ELECTION: don't eagerly claim host if lobby shows others ───────
  // Bug: joinBoard calls getPeersInBoard which checks conn.open — but the connection
  // hasn't opened yet, so it returns 0 even when others ARE in the board.
  // Both peers then set isBoardHost=true until host-changed arrives.
  // Fix: also check the lobby registry before claiming host.
  const _origJoinBoardHost = window.joinBoard;
  window.joinBoard = function (board) {
    const r = _origJoinBoardHost && _origJoinBoardHost.apply(this, arguments);
    // If lobby registry shows other peers in this board, relinquish early host claim
    if (typeof state !== 'undefined' && typeof state.lobbyRegistry !== 'undefined') {
      const othersInBoard = Object.entries(state.lobbyRegistry)
        .filter(([id, info]) => id !== state.myId && info.board === board);
      if (othersInBoard.length > 0) {
        // Others are already here — we don't know who the host is yet.
        // Reset isBoardHost so we don't broadcast a false host-changed.
        state.isBoardHost = false;
        state.boardHostId = null;
      }
    }
    return r;
  };

  // ── 15. VOICE: auto-request mic when joining a board ───────────────────────
  // Clicking a board item is a valid user gesture — use it to trigger getUserMedia
  // so voice chat is ready immediately without needing to find and click the mic btn.
  const _origJoinBoardVoice = window.joinBoard;
  window.joinBoard = function (board) {
    const r = _origJoinBoardVoice && _origJoinBoardVoice.apply(this, arguments);
    if (typeof voiceState !== 'undefined' && !voiceState.localStream) {
      if (typeof joinVoice === 'function') {
        setTimeout(() => joinVoice(), 400);
      }
    }
    return r;
  };

  // ── 16. MOBILE CSS: fix layout for small screens ───────────────────────────
  const mobilePatchCSS = document.createElement('style');
  mobilePatchCSS.textContent = `
    /* Prevent horizontal overflow of new toolbar items on mobile */
    @media (max-width: 768px) {
      #draw-toolbar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      #opacity-wrap { display: none !important; } /* hide opacity on narrow screens */
      #layers-toolbar-btn { display: none !important; }
      #shortcuts-hint-btn { display: none !important; }
      #color-history { display: none !important; }
      #minimap-wrap { bottom: 60px; right: 8px; }

      /* Board header: tighten up new buttons */
      #leave-board-btn span { display: none; } /* icon only on mobile */
      #leave-board-btn { padding: 6px 8px !important; }

      /* Layers panel + minimap: reposition for mobile */
      #layers-panel { top: 50px; right: 8px; width: 148px; }
    }

    @media (max-height: 500px) and (max-width: 1024px) {
      #opacity-wrap { display: none !important; }
      #layers-toolbar-btn { display: none !important; }
      #shortcuts-hint-btn { display: none !important; }
      #minimap-wrap { bottom: 48px; right: 8px; }
    }

    /* Fix mod-menu visibility: ensure it always appears above everything */
    #mod-menu { z-index: 9000 !important; }

    /* Mic button in member row — make it clearly tappable on mobile */
    #mute-btn { min-width: 36px; min-height: 32px; touch-action: manipulation; }
    .member-row { min-height: 40px; touch-action: manipulation; }
  `;
  document.head.appendChild(mobilePatchCSS);

})();
