/**
 * Slate SFX — tiny, synthesized, airy interface sounds.
 *
 * All sounds are generated on-demand with the Web Audio API so the app stays
 * single-file-friendly (no audio assets to ship). The design goal is
 * "barely there" — short envelopes, gentle filtering, very low gain.
 *
 * Public API:
 *   window.slateSfx.play(name, opts?)
 *   window.slateSfx.setEnabled(bool)
 *   window.slateSfx.setVolume(0..1)
 *
 * The audio context is created lazily on the first user gesture so we don't
 * trip browser autoplay policies.
 */
(function () {
  const LS_ENABLED = 'slate_sfx_enabled';
  const LS_VOLUME  = 'slate_sfx_volume';

  let ctx        = null;
  let masterGain = null;
  let enabled    = true;
  let volume     = 0.45;
  let lastPlay   = new Map(); // name -> last play timestamp, prevents spam

  try { if (localStorage.getItem(LS_ENABLED) === '0') enabled = false; } catch (_) {}
  try {
    const v = parseFloat(localStorage.getItem(LS_VOLUME));
    if (!Number.isNaN(v) && v >= 0 && v <= 1) volume = v;
  } catch (_) {}

  function _ensureCtx() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(ctx.destination);
    } catch (_) { ctx = null; }
    return ctx;
  }

  // Resume the audio context on the first user interaction.
  function _unlockOnGesture() {
    const onAny = () => {
      _ensureCtx();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      window.removeEventListener('pointerdown', onAny, true);
      window.removeEventListener('keydown', onAny, true);
      window.removeEventListener('touchstart', onAny, true);
    };
    window.addEventListener('pointerdown', onAny, true);
    window.addEventListener('keydown', onAny, true);
    window.addEventListener('touchstart', onAny, true);
  }
  _unlockOnGesture();

  /* A short softening filter chain shared by most sounds for "airy" feel. */
  function _airyChain(input, { highShelf = -4, lowPass = 7200 } = {}) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowPass;
    lp.Q.value = 0.7;
    const hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 5000;
    hs.gain.value = highShelf;
    input.connect(lp);
    lp.connect(hs);
    hs.connect(masterGain);
    return hs;
  }

  /* A tiny sine-blip "click" used as the base of most UI sounds. */
  function _blip({ freq = 1400, dur = 0.045, peak = 0.06, type = 'sine', detune = 0, slide = 0 }) {
    if (!_ensureCtx()) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), now + dur);
    if (detune) osc.detune.value = detune;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    _airyChain(env);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  function _chord(freqs, { dur = 0.4, peak = 0.05, type = 'sine', stagger = 0.05 } = {}) {
    if (!_ensureCtx()) return;
    const now = ctx.currentTime;
    freqs.forEach((freq, i) => {
      const t = now + i * stagger;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(env);
      _airyChain(env, { lowPass: 6000 });
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
  }

  /* A filtered-noise whoosh — useful for panels and mode changes. */
  function _whoosh({ dur = 0.22, peak = 0.04, startFreq = 2400, endFreq = 700 } = {}) {
    if (!_ensureCtx()) return;
    const now = ctx.currentTime;
    const bufSize = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(startFreq, now);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, endFreq), now + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp); bp.connect(env);
    _airyChain(env, { highShelf: -2 });
    src.start(now);
    src.stop(now + dur + 0.05);
  }

  /* Throttle a named sound to avoid stacking on top of itself. */
  function _throttle(name, ms) {
    const now = performance.now();
    const last = lastPlay.get(name) || 0;
    if (now - last < ms) return false;
    lastPlay.set(name, now);
    return true;
  }

  /* Master dispatch — every UI sound is one entry below. */
  const PRESETS = {
    click:        () => _blip({ freq: 1500, dur: 0.04, peak: 0.045 }),
    hover:        () => _blip({ freq: 1100, dur: 0.02, peak: 0.018 }),
    tool:         () => _blip({ freq: 1850, dur: 0.045, peak: 0.05, slide: -200 }),
    toggle:       () => _blip({ freq: 1300, dur: 0.05, peak: 0.045, slide: 250 }),
    'panel-open':  () => _blip({ freq: 720,  dur: 0.16, peak: 0.04, slide: 720, type: 'triangle' }),
    'panel-close': () => _blip({ freq: 1440, dur: 0.14, peak: 0.035, slide: -800, type: 'triangle' }),
    'mode-switch': () => { _whoosh({ dur: 0.32, peak: 0.035, startFreq: 1800, endFreq: 600 }); _blip({ freq: 1700, dur: 0.06, peak: 0.04, slide: -600 }); },
    join:         () => _chord([523.25, 659.25, 783.99], { dur: 0.5, peak: 0.045, stagger: 0.06 }),
    leave:        () => _chord([783.99, 523.25],          { dur: 0.45, peak: 0.04, stagger: 0.10 }),
    save:         () => _chord([659.25, 880.00],          { dur: 0.42, peak: 0.05, stagger: 0.07 }),
    'save-silent': () => _blip({ freq: 1200, dur: 0.035, peak: 0.025, slide: 300 }),
    error:        () => _blip({ freq: 220, dur: 0.18, peak: 0.06, slide: -90, type: 'sawtooth' }),
    pop:          () => _blip({ freq: 980, dur: 0.06, peak: 0.04, slide: -300, type: 'sine' }),
    success:      () => _chord([880, 1318.5], { dur: 0.32, peak: 0.045, stagger: 0.05 }),
    notify:       () => _chord([1318.5, 1760], { dur: 0.28, peak: 0.035, stagger: 0.04 }),
  };

  function play(name, opts = {}) {
    if (!enabled) return;
    if (!ctx) _ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const fn = PRESETS[name];
    if (!fn) return;
    const throttle = opts.throttleMs ?? (name === 'click' ? 25 : 60);
    if (!_throttle(name, throttle)) return;
    try { fn(opts); } catch (_) {}
  }

  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem(LS_ENABLED, enabled ? '1' : '0'); } catch (_) {}
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (masterGain) masterGain.gain.value = volume;
    try { localStorage.setItem(LS_VOLUME, String(volume)); } catch (_) {}
  }
  function isEnabled() { return enabled; }
  function getVolume() { return volume; }

  /* Auto-wire common UI elements (idempotent — safe to call repeatedly). */
  function _autoWire() {
    if (window.__slateSfxWired) return;
    window.__slateSfxWired = true;
    // Buttons and tool icons get a soft click.
    document.addEventListener('pointerdown', (e) => {
      if (!enabled) return;
      const el = e.target?.closest?.('button, .tool-btn, .t3d-btn, .dock-tab, [role="button"], .btn-icon');
      if (!el) return;
      if (el.classList.contains('tool-btn') || el.classList.contains('t3d-btn')) play('tool');
      else play('click');
    }, true);
    // Focus changes on tool-toggle inputs (color swap etc.) get a tiny click.
    document.addEventListener('change', (e) => {
      if (!enabled) return;
      const el = e.target;
      if (!el) return;
      if (el.type === 'checkbox' || el.type === 'radio') play('toggle');
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoWire, { once: true });
  } else {
    _autoWire();
  }

  window.slateSfx = { play, setEnabled, setVolume, isEnabled, getVolume };
})();
