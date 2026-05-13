/**
 * Profile-driven doc-diff throttle: larger boards back off broadcast rate slightly
 * to keep the main thread responsive during heavy drawing sessions.
 * Loaded before the main Slate inline script (see index.html).
 */
(function (w) {
  w.slateGetDiffThrottleMs = function slateGetDiffThrottleMs(doc) {
    const n = (doc && doc.shapes && doc.strokes)
      ? doc.shapes.size + doc.strokes.size
      : 0;
    if (n > 1200) return 100;
    if (n > 600) return 66;
    if (n > 200) return 50;
    return 33;
  };
})(typeof window !== 'undefined' ? window : globalThis);
