/**
 * notes.js — Apple Notes–style per-board notes panel for Slate.
 *
 * Each board gets its own list of notes "sections". A section is a small
 * card with a renamable title, a freeform multi-line body, and a checklist.
 * All edits sync live to peers via the existing window.slateNotes API +
 * pendingDiff plumbing in index.html.
 *
 * The panel registers itself with window.slateDock once the dock is ready,
 * so it slots into the same right-side dock used by Layers / Hierarchy.
 *
 * Loaded as a plain <script> tag at the end of index.html. Top-level vars
 * in index.html (doc, state, slateNotes) are accessible via window.* here.
 */
(function slateNotesPanel() {
  'use strict';

  /* ─── Styling ──────────────────────────────────────────────────────── */
  const css = document.createElement('style');
  css.textContent = `
    #notes-panel {
      display: flex; flex-direction: column;
      flex: 1; min-height: 0;
      font-size: 0.78rem;
      background: var(--bg2);
    }
    #notes-panel .nt-head {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px 6px;
      font-size: 0.68rem; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #notes-panel .nt-head-title { flex: 1; min-width: 0; }
    #notes-panel .nt-head-btn {
      background: none; border: 1px solid transparent; color: var(--text-mid);
      cursor: pointer; padding: 3px 6px; border-radius: 5px;
      font: inherit; line-height: 1;
      display: inline-flex; align-items: center; gap: 4px;
      transition: background .12s, color .12s, border-color .12s;
    }
    #notes-panel .nt-head-btn:hover {
      background: var(--bg3); color: var(--text);
      border-color: var(--border2);
    }
    #notes-panel .nt-list {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 6px;
      display: flex; flex-direction: column; gap: 6px;
    }
    #notes-panel .nt-empty {
      padding: 18px 14px; text-align: center;
      color: var(--text-dim); font-size: 0.78rem; line-height: 1.45;
    }
    #notes-panel .nt-empty button {
      margin-top: 10px;
      background: var(--accent-dim, rgba(124,106,255,0.16));
      color: var(--accent, #7c6aff);
      border: 1px solid rgba(124,106,255,0.4);
      padding: 5px 12px; border-radius: 6px;
      cursor: pointer; font: inherit;
    }
    .nt-section {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      transition: border-color .15s ease, transform .15s ease, opacity .15s ease;
    }
    .nt-section:focus-within { border-color: var(--accent, #7c6aff); }
    .nt-section.nt-drag-target { border-top-color: var(--accent, #7c6aff); border-top-width: 2px; }
    .nt-section.nt-just-added {
      animation: nt-section-pop .28s cubic-bezier(.2,.8,.3,1.2);
    }
    @keyframes nt-section-pop {
      from { opacity: 0; transform: translateY(-4px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)    scale(1);     }
    }
    .nt-sec-head {
      display: flex; align-items: center; gap: 4px;
      padding: 5px 6px 5px 8px;
      background: var(--bg4, rgba(255,255,255,0.03));
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
    }
    .nt-sec-twisty {
      width: 14px; flex-shrink: 0; color: var(--text-dim);
      display: inline-flex; align-items: center; justify-content: center;
      transition: transform .15s ease;
    }
    .nt-section.nt-collapsed .nt-sec-twisty { transform: rotate(-90deg); }
    .nt-sec-title {
      flex: 1; min-width: 0;
      background: transparent; border: none; outline: none;
      color: var(--text); font: inherit; font-weight: 600;
      padding: 2px 4px; border-radius: 4px;
      transition: background .12s;
    }
    .nt-sec-title:hover, .nt-sec-title:focus {
      background: rgba(255,255,255,0.04);
    }
    .nt-sec-author {
      font-size: 0.62rem; color: var(--text-dim); white-space: nowrap;
      margin-right: 4px; opacity: 0;
      transition: opacity .15s ease;
    }
    .nt-section:hover .nt-sec-author { opacity: 0.75; }
    .nt-sec-iconbtn {
      background: none; border: none; color: var(--text-dim);
      cursor: pointer; padding: 2px 4px; border-radius: 4px;
      line-height: 1; opacity: 0.55;
      transition: opacity .12s, color .12s, background .12s;
    }
    .nt-section:hover .nt-sec-iconbtn { opacity: 1; }
    .nt-sec-iconbtn:hover { background: var(--bg3); color: var(--text); }
    .nt-sec-iconbtn.nt-del:hover { color: var(--danger, #f87171); }
    .nt-sec-grip {
      cursor: grab; padding: 0 3px;
      color: var(--text-dim); opacity: 0.45;
      flex-shrink: 0; line-height: 0;
    }
    .nt-section:hover .nt-sec-grip { opacity: 0.85; }
    .nt-sec-grip:active { cursor: grabbing; }
    .nt-sec-body {
      padding: 6px 8px 8px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .nt-section.nt-collapsed .nt-sec-body { display: none; }
    .nt-text {
      width: 100%;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--text);
      font: inherit; line-height: 1.45;
      padding: 4px 6px;
      resize: none;
      outline: none;
      min-height: 22px;
      transition: background .12s, border-color .12s;
      overflow: hidden;
    }
    .nt-text:hover, .nt-text:focus {
      background: rgba(255,255,255,0.03);
      border-color: var(--border);
    }
    .nt-checklist {
      display: flex; flex-direction: column; gap: 2px;
    }
    .nt-item {
      display: flex; align-items: flex-start; gap: 6px;
      padding: 2px 2px 2px 4px;
      border-radius: 5px;
      transition: background .1s;
    }
    .nt-item:hover { background: rgba(255,255,255,0.025); }
    .nt-item-check {
      flex-shrink: 0;
      width: 14px; height: 14px;
      border: 1.4px solid var(--border2);
      border-radius: 4px;
      cursor: pointer;
      background: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      margin-top: 4px;
      transition: background .14s ease, border-color .14s ease, transform .12s ease;
      padding: 0;
    }
    .nt-item-check:hover { border-color: var(--accent, #7c6aff); }
    .nt-item-check.checked {
      background: var(--accent, #7c6aff);
      border-color: var(--accent, #7c6aff);
    }
    .nt-item-check.checked svg { opacity: 1; transform: scale(1); }
    .nt-item-check svg {
      opacity: 0; transform: scale(0.6);
      transition: opacity .14s ease, transform .14s ease;
      color: #fff;
    }
    .nt-item-text {
      flex: 1; min-width: 0;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text);
      font: inherit; line-height: 1.4;
      padding: 2px 5px; border-radius: 4px;
      outline: none; resize: none;
      transition: background .1s, color .12s, text-decoration-color .14s;
      overflow: hidden;
    }
    .nt-item-text:hover, .nt-item-text:focus {
      background: rgba(255,255,255,0.04);
    }
    .nt-item.done .nt-item-text {
      color: var(--text-dim);
      text-decoration: line-through;
      text-decoration-color: rgba(255,255,255,0.35);
    }
    .nt-item-del {
      flex-shrink: 0;
      background: none; border: none; color: var(--text-dim);
      cursor: pointer; padding: 2px 4px; border-radius: 4px;
      line-height: 1; opacity: 0;
      transition: opacity .12s, color .12s;
    }
    .nt-item:hover .nt-item-del { opacity: 0.75; }
    .nt-item-del:hover { color: var(--danger, #f87171); opacity: 1; }
    .nt-add-item {
      display: flex; align-items: center; gap: 5px;
      padding: 4px 6px; margin-top: 1px;
      font-size: 0.72rem; color: var(--text-dim);
      background: none; border: 1px dashed transparent;
      border-radius: 5px;
      cursor: pointer; text-align: left; width: 100%;
      transition: color .12s, border-color .12s, background .12s;
    }
    .nt-add-item:hover {
      color: var(--accent, #7c6aff);
      border-color: var(--border2);
      background: rgba(124,106,255,0.05);
    }
    /* Compact mobile layout — the dock collapses to a drawer on mobile, so
       just keep the controls finger-sized. */
    @media (max-width: 768px) {
      #notes-panel { font-size: 0.85rem; }
      .nt-item-check { width: 18px; height: 18px; margin-top: 2px; }
      .nt-sec-iconbtn { padding: 4px 6px; }
      .nt-text, .nt-item-text { padding: 6px 7px; }
      .nt-add-item { padding: 7px 8px; font-size: 0.8rem; }
    }
  `;
  document.head.appendChild(css);

  /* ─── DOM rendering ────────────────────────────────────────────────── */

  /** Map of sectionId -> { textareaEl, itemTextEls{itemId: el} } so we can
   *  avoid clobbering the user's caret when a remote diff arrives. */
  const inputRegistry = new Map();

  /** Section ids the local user has manually collapsed. UI-only, not synced. */
  const collapsedLocal = new Set(_loadLocalCollapsed());
  function _loadLocalCollapsed() {
    try { return JSON.parse(localStorage.getItem('slate_notes_collapsed') || '[]') || []; }
    catch (_) { return []; }
  }
  function _saveLocalCollapsed() {
    try { localStorage.setItem('slate_notes_collapsed', JSON.stringify([...collapsedLocal])); }
    catch (_) {}
  }

  let rootEl = null;

  function buildPanel(parent) {
    parent.innerHTML = '';
    rootEl = document.createElement('div');
    rootEl.id = 'notes-panel';
    rootEl.innerHTML = `
      <div class="nt-head">
        <span class="nt-head-title">Notes</span>
        <button type="button" class="nt-head-btn" id="nt-add-section-btn" title="New section">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/>
          </svg>
          New
        </button>
      </div>
      <div class="nt-list" id="nt-list" role="list"></div>
    `;
    parent.appendChild(rootEl);
    rootEl.querySelector('#nt-add-section-btn').addEventListener('click', () => {
      const s = window.slateNotes?.createSection();
      if (s) {
        renderAll();
        // Focus the new section's title for immediate rename.
        requestAnimationFrame(() => {
          const titleEl = rootEl.querySelector(`.nt-section[data-id="${s.id}"] .nt-sec-title`);
          if (titleEl) { titleEl.focus(); titleEl.select(); }
          const sectionEl = rootEl.querySelector(`.nt-section[data-id="${s.id}"]`);
          if (sectionEl) {
            sectionEl.classList.add('nt-just-added');
            setTimeout(() => sectionEl.classList.remove('nt-just-added'), 320);
          }
        });
        try { window.slateSfx?.play('add'); } catch (_) {}
      }
    });
    renderAll();
  }

  function renderAll() {
    if (!rootEl) return;
    const list = rootEl.querySelector('#nt-list');
    if (!list) return;
    const sections = (window.slateNotes?.sections) || [];
    const hasBoard = _currentBoardActive();
    const addBtn = rootEl.querySelector('#nt-add-section-btn');
    if (addBtn) {
      addBtn.disabled = !hasBoard;
      addBtn.style.opacity = hasBoard ? '' : '0.45';
      addBtn.style.cursor  = hasBoard ? '' : 'not-allowed';
      addBtn.title = hasBoard ? 'New section' : 'Join a board to add notes';
    }

    if (!sections.length) {
      list.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'nt-empty';
      empty.innerHTML = hasBoard ? `
        <div>No notes for this board yet.</div>
        <div style="margin-top:4px;opacity:.7;font-size:.72rem">Add a section to start jotting things down — everyone in the board will see your notes live.</div>
        <button type="button">+ Create first section</button>
      ` : `
        <div>Join or create a board to start taking notes.</div>
        <div style="margin-top:4px;opacity:.7;font-size:.72rem">Notes are saved with the board and shared with everyone in the session.</div>
      `;
      const createBtn = empty.querySelector('button');
      if (createBtn) {
        createBtn.addEventListener('click', () => {
          rootEl.querySelector('#nt-add-section-btn')?.click();
        });
      }
      list.appendChild(empty);
      inputRegistry.clear();
      return;
    }

    // Diff-render: keep DOM nodes whose id still exists so we don't drop
    // focus / caret position while the user is typing.
    const existing = new Map();
    list.querySelectorAll('.nt-section').forEach(el => existing.set(el.dataset.id, el));
    const remove = new Set(existing.keys());

    let prevNode = null;
    for (const sec of sections) {
      remove.delete(sec.id);
      let el = existing.get(sec.id);
      if (!el) {
        el = renderSection(sec);
      } else {
        updateSection(el, sec);
      }
      // Re-order in place if needed.
      const want = prevNode ? prevNode.nextSibling : list.firstChild;
      if (el !== want) list.insertBefore(el, want);
      prevNode = el;
    }
    remove.forEach(id => {
      existing.get(id)?.remove();
      inputRegistry.delete(id);
    });
  }

  /** Build a brand-new section DOM node (called when the section id is unknown). */
  function renderSection(sec) {
    const el = document.createElement('div');
    el.className = 'nt-section';
    el.dataset.id = sec.id;
    if (collapsedLocal.has(sec.id)) el.classList.add('nt-collapsed');
    el.innerHTML = `
      <div class="nt-sec-head" role="button" aria-label="Toggle section">
        <span class="nt-sec-twisty" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="2,3.5 5,7 8,3.5"/>
          </svg>
        </span>
        <span class="nt-sec-grip" title="Drag to reorder" draggable="true" aria-hidden="true">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="3" r="1"/><circle cx="7" cy="3" r="1"/>
            <circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/>
            <circle cx="3" cy="11" r="1"/><circle cx="7" cy="11" r="1"/>
          </svg>
        </span>
        <input type="text" class="nt-sec-title" maxlength="80" spellcheck="false" value="">
        <span class="nt-sec-author" title=""></span>
        <button type="button" class="nt-sec-iconbtn nt-del" title="Delete section" aria-label="Delete section">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <path d="M2.5 3.5h7M4.5 3.5V2.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M3.5 3.5l.4 6a1 1 0 0 0 1 .9h2.2a1 1 0 0 0 1-.9l.4-6"/>
          </svg>
        </button>
      </div>
      <div class="nt-sec-body">
        <textarea class="nt-text" rows="1" placeholder="Type here…" spellcheck="false"></textarea>
        <div class="nt-checklist"></div>
        <button type="button" class="nt-add-item" title="Add a checklist item">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/>
          </svg>
          Add item
        </button>
      </div>
    `;
    _wireSectionEvents(el, sec.id);
    updateSection(el, sec);
    return el;
  }

  /** Patch an existing section DOM node with the latest section data. */
  function updateSection(el, sec) {
    const titleEl = el.querySelector('.nt-sec-title');
    if (titleEl && document.activeElement !== titleEl && titleEl.value !== sec.title) {
      titleEl.value = sec.title;
    }
    const textEl = el.querySelector('.nt-text');
    if (textEl && document.activeElement !== textEl && textEl.value !== sec.body) {
      textEl.value = sec.body;
    }
    if (textEl) autoSize(textEl);
    const authorEl = el.querySelector('.nt-sec-author');
    if (authorEl) {
      const name = _authorNameFor(sec.peerId);
      authorEl.textContent = name ? `by ${name}` : '';
      authorEl.title = name ? `Created by ${name}` : '';
    }
    _renderChecklist(el, sec);

    let reg = inputRegistry.get(sec.id);
    if (!reg) { reg = { itemTextEls: new Map() }; inputRegistry.set(sec.id, reg); }
    reg.titleEl = titleEl;
    reg.textEl  = textEl;
  }

  function _renderChecklist(sectionEl, sec) {
    const list = sectionEl.querySelector('.nt-checklist');
    let reg  = inputRegistry.get(sec.id);
    if (!reg) {
      reg = { itemTextEls: new Map() };
      inputRegistry.set(sec.id, reg);
    }
    const existing = new Map();
    list.querySelectorAll('.nt-item').forEach(el => existing.set(el.dataset.itemId, el));
    const remove = new Set(existing.keys());

    let prev = null;
    for (const item of sec.items) {
      remove.delete(item.id);
      let row = existing.get(item.id);
      if (!row) {
        row = _buildItemRow(sec.id, item);
      } else {
        _updateItemRow(row, item);
      }
      const want = prev ? prev.nextSibling : list.firstChild;
      if (row !== want) list.insertBefore(row, want);
      prev = row;
    }
    remove.forEach(id => {
      existing.get(id)?.remove();
      reg.itemTextEls.delete(id);
    });
  }

  function _buildItemRow(sectionId, item) {
    const row = document.createElement('div');
    row.className = 'nt-item' + (item.done ? ' done' : '');
    row.dataset.itemId = item.id;
    row.innerHTML = `
      <button type="button" class="nt-item-check ${item.done ? 'checked' : ''}" role="checkbox" aria-checked="${item.done ? 'true' : 'false'}" title="Toggle done">
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="2,5.5 4,7.5 8,3"/>
        </svg>
      </button>
      <textarea class="nt-item-text" rows="1" placeholder="Item" spellcheck="false"></textarea>
      <button type="button" class="nt-item-del" title="Remove item" aria-label="Remove item">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/>
        </svg>
      </button>
    `;
    const text = row.querySelector('.nt-item-text');
    text.value = item.text;
    autoSize(text);

    const check = row.querySelector('.nt-item-check');
    check.addEventListener('click', () => {
      const sec  = window.slateNotes?.find(sectionId);
      const cur  = sec?.items.find(x => x.id === item.id);
      if (!cur) return;
      window.slateNotes?.setItemDone(sectionId, item.id, !cur.done);
      try { window.slateSfx?.play(!cur.done ? 'toggle' : 'click'); } catch (_) {}
    });
    text.addEventListener('input', () => {
      autoSize(text);
      _scheduleItemSave(sectionId, item.id, text.value);
    });
    text.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Push any pending text first so order is intuitive.
        _flushPendingItemSaves();
        const newItem = window.slateNotes?.addItem(sectionId, '');
        renderAll();
        if (newItem) {
          requestAnimationFrame(() => {
            const reg = inputRegistry.get(sectionId);
            const el  = reg?.itemTextEls.get(newItem.id);
            el?.focus();
          });
        }
      } else if (e.key === 'Backspace' && text.value === '') {
        e.preventDefault();
        _flushPendingItemSaves();
        // Focus previous item (if any) before removing.
        const sec = window.slateNotes?.find(sectionId);
        const idx = sec?.items.findIndex(x => x.id === item.id) ?? -1;
        window.slateNotes?.removeItem(sectionId, item.id);
        renderAll();
        if (idx > 0) {
          requestAnimationFrame(() => {
            const prevItem = sec.items[idx - 1];
            const reg = inputRegistry.get(sectionId);
            const el = prevItem && reg?.itemTextEls.get(prevItem.id);
            if (el) {
              el.focus();
              const v = el.value;
              el.setSelectionRange(v.length, v.length);
            }
          });
        }
      }
    });

    row.querySelector('.nt-item-del').addEventListener('click', () => {
      _flushPendingItemSaves();
      window.slateNotes?.removeItem(sectionId, item.id);
      renderAll();
    });

    const reg = inputRegistry.get(sectionId) || { itemTextEls: new Map() };
    reg.itemTextEls.set(item.id, text);
    inputRegistry.set(sectionId, reg);
    return row;
  }

  function _updateItemRow(row, item) {
    const check = row.querySelector('.nt-item-check');
    if (check) {
      check.classList.toggle('checked', !!item.done);
      check.setAttribute('aria-checked', item.done ? 'true' : 'false');
    }
    row.classList.toggle('done', !!item.done);
    const text = row.querySelector('.nt-item-text');
    if (text && document.activeElement !== text && text.value !== item.text) {
      text.value = item.text;
      autoSize(text);
    }
  }

  /* ─── Section-level wiring ─────────────────────────────────────────── */
  function _wireSectionEvents(el, sectionId) {
    const head    = el.querySelector('.nt-sec-head');
    const twisty  = el.querySelector('.nt-sec-twisty');
    const titleEl = el.querySelector('.nt-sec-title');
    const textEl  = el.querySelector('.nt-text');
    const delBtn  = el.querySelector('.nt-sec-iconbtn.nt-del');
    const addBtn  = el.querySelector('.nt-add-item');
    const grip    = el.querySelector('.nt-sec-grip');

    head.addEventListener('click', e => {
      // Title input click should focus the input, not toggle.
      if (e.target.closest('.nt-sec-title')) return;
      if (e.target.closest('.nt-sec-iconbtn')) return;
      if (e.target.closest('.nt-sec-grip')) return;
      const collapsed = el.classList.toggle('nt-collapsed');
      if (collapsed) collapsedLocal.add(sectionId);
      else           collapsedLocal.delete(sectionId);
      _saveLocalCollapsed();
    });

    titleEl.addEventListener('input', () => {
      _scheduleTitleSave(sectionId, titleEl.value);
    });
    titleEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      if (e.key === 'Escape') { titleEl.blur(); }
    });
    titleEl.addEventListener('blur', () => _flushPendingTitleSaves());

    textEl.addEventListener('input', () => {
      autoSize(textEl);
      _scheduleBodySave(sectionId, textEl.value);
    });
    textEl.addEventListener('blur', () => _flushPendingBodySaves());

    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      const sec = window.slateNotes?.find(sectionId);
      const isEmpty = !sec || (
        !sec.title.trim() && !sec.body.trim() &&
        !(sec.items || []).some(it => it.text.trim())
      );
      if (!isEmpty && !confirm(`Delete "${sec?.title || 'this section'}" and its contents?`)) return;
      el.style.transition = 'opacity .18s ease, transform .18s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateX(8px) scale(0.96)';
      setTimeout(() => {
        window.slateNotes?.removeSection(sectionId);
        renderAll();
      }, 160);
      try { window.slateSfx?.play('panel-close'); } catch (_) {}
    });

    addBtn.addEventListener('click', () => {
      _flushPendingItemSaves();
      const newItem = window.slateNotes?.addItem(sectionId, '');
      renderAll();
      if (newItem) {
        requestAnimationFrame(() => {
          const reg = inputRegistry.get(sectionId);
          reg?.itemTextEls.get(newItem.id)?.focus();
        });
      }
    });

    _bindGripDrag(el, grip, sectionId);
  }

  /* ─── Reorder via drag handle ──────────────────────────────────────── */
  function _bindGripDrag(sectionEl, grip, sectionId) {
    grip.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sectionId);
      sectionEl.style.opacity = '0.4';
    });
    grip.addEventListener('dragend', () => {
      sectionEl.style.opacity = '';
      rootEl?.querySelectorAll('.nt-section.nt-drag-target')
        .forEach(n => n.classList.remove('nt-drag-target'));
    });
    sectionEl.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      rootEl?.querySelectorAll('.nt-section.nt-drag-target')
        .forEach(n => n.classList.remove('nt-drag-target'));
      sectionEl.classList.add('nt-drag-target');
    });
    sectionEl.addEventListener('dragleave', () => {
      sectionEl.classList.remove('nt-drag-target');
    });
    sectionEl.addEventListener('drop', e => {
      e.preventDefault();
      sectionEl.classList.remove('nt-drag-target');
      const movedId = e.dataTransfer.getData('text/plain');
      if (!movedId || movedId === sectionId) return;
      const sections = window.slateNotes?.sections || [];
      const targetIdx = sections.findIndex(s => s.id === sectionId);
      const fromIdx   = sections.findIndex(s => s.id === movedId);
      if (targetIdx < 0 || fromIdx < 0) return;
      // Drop above the target if dragging downward; below otherwise.
      const toIdx = fromIdx < targetIdx ? targetIdx : targetIdx;
      window.slateNotes?.moveSection(movedId, toIdx);
      renderAll();
      try { window.slateSfx?.play('click'); } catch (_) {}
    });
  }

  /* ─── Debounced saves so peer broadcasts stay quiet while typing ──── */
  const pendingTitle = new Map(); // sectionId -> title
  const pendingBody  = new Map(); // sectionId -> body
  const pendingItem  = new Map(); // sectionId|itemId -> text
  let saveTimer = null;
  const SAVE_DEBOUNCE = 380;

  function _scheduleTitleSave(id, val) {
    pendingTitle.set(id, val);
    _kickSaveTimer();
  }
  function _scheduleBodySave(id, val) {
    pendingBody.set(id, val);
    _kickSaveTimer();
  }
  function _scheduleItemSave(sectionId, itemId, val) {
    pendingItem.set(sectionId + '|' + itemId, val);
    _kickSaveTimer();
  }
  function _kickSaveTimer() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(_flushAllPending, SAVE_DEBOUNCE);
  }
  function _flushPendingTitleSaves() {
    if (!pendingTitle.size) return;
    pendingTitle.forEach((val, id) => window.slateNotes?.renameSection(id, val));
    pendingTitle.clear();
  }
  function _flushPendingBodySaves() {
    if (!pendingBody.size) return;
    pendingBody.forEach((val, id) => window.slateNotes?.setBody(id, val));
    pendingBody.clear();
  }
  function _flushPendingItemSaves() {
    if (!pendingItem.size) return;
    pendingItem.forEach((val, key) => {
      const [sectionId, itemId] = key.split('|');
      window.slateNotes?.setItemText(sectionId, itemId, val);
    });
    pendingItem.clear();
  }
  function _flushAllPending() {
    saveTimer = null;
    _flushPendingTitleSaves();
    _flushPendingBodySaves();
    _flushPendingItemSaves();
  }
  // Flush on tab/window hide so we never lose typed-but-unsynced text.
  window.addEventListener('beforeunload', _flushAllPending);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flushAllPending();
  });

  /* ─── Helpers ──────────────────────────────────────────────────────── */
  function autoSize(textareaEl) {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = (textareaEl.scrollHeight + 2) + 'px';
  }

  function _currentBoardActive() {
    try {
      // eslint-disable-next-line no-undef
      return !!(state && state.currentBoard);
    } catch (_) { return false; }
  }

  function _authorNameFor(peerId) {
    if (!peerId) return '';
    // `state` is a top-level const in the inline index.html script; in non-
    // module scripts these bindings live in the shared Script record, so we
    // can reach it directly here. Wrapped in try/catch in case of unusual
    // loading orders during dev.
    try {
      // eslint-disable-next-line no-undef
      if (peerId === state.myId) return 'you';
      // eslint-disable-next-line no-undef
      const conn = state.connections?.[peerId];
      if (conn?.name) return conn.name;
      // eslint-disable-next-line no-undef
      const lobby = state.lobbyRegistry?.[peerId];
      if (lobby?.name) return lobby.name;
    } catch (_) {}
    return '';
  }

  /* ─── Registration with the dock ───────────────────────────────────── */
  function registerWithDock() {
    if (!window.slateDock || typeof window.slateDock.registerPanel !== 'function') {
      requestAnimationFrame(registerWithDock);
      return;
    }
    window.slateDock.registerPanel({
      id: 'notes',
      title: 'Notes',
      order: 6, // between Hierarchy (4) and Layers (10)
      mount(el) { buildPanel(el); },
    });
    // Subscribe to live model changes so remote diffs trigger a re-render
    // (the model knows when to call _emit() — see index.html slateNotes API).
    window.slateNotes?.onChange(() => {
      // If the user is actively typing, the input-registry-based diff render
      // will preserve their caret position.
      renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWithDock, { once: true });
  } else {
    registerWithDock();
  }
})();
