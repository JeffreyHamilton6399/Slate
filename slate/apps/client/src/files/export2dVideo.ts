/**
 * Export the 2D canvas animation as an MP4 (or WebM fallback) video.
 *
 * Mirrors the 3D viewport's `onRenderAnimation` (viewport3d/Viewport3D.tsx):
 * capture the canvas as a MediaStream, drive time manually, stop at duration,
 * and download the blob. MP4/H.264 is preferred (universally playable);
 * browsers that can't encode MP4 from a canvas stream (e.g. Firefox) fall
 * back to WebM.
 *
 * Unlike the 3D version — which advances time on rAF and lets the recorder
 * sample whenever — the 2D timeline is frame-based (cel animation), so we
 * step one frame at a time at `1000 / fps` ms. That gives `captureStream`
 * time to sample every distinct frame: rAF alone is too fast and multiple
 * setAnimFrame() calls collapse into a single recorder sample.
 *
 * The engine's render loop only repaints when `animPreview` is true (see
 * canvas2d/engine.ts `loop`), so we hold it high for the whole render and
 * drop it back to false when we're done.
 */

import { useCanvasStore } from '../canvas2d/store';

export async function export2dVideo(opts: {
  canvas: HTMLCanvasElement;
  fps: number;
  duration: number; // seconds
  onProgress?: (pct: number) => void; // 0..1
}): Promise<void> {
  const { canvas, fps, duration, onProgress } = opts;
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
    throw new Error('This browser can’t record the canvas.');
  }

  // Prefer MP4/H.264 (universally playable); fall back to WebM where the
  // browser can't encode MP4 from a canvas stream (e.g. Firefox).
  const mime = [
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('No supported video MIME type for MediaRecorder.');
  const isMp4 = mime.startsWith('video/mp4');
  const ext = isMp4 ? 'mp4' : 'webm';

  const store = useCanvasStore.getState();
  // Freeze interactive playback; the export drives frames itself. The
  // animPreview flag must be true the whole time so the engine's render loop
  // repaints every rAF (see canvas2d/engine.ts loop guard).
  store.setAnimPlaying(false);
  store.setAnimFrame(0);
  store.setAnimPreview(true);

  const totalFrames = Math.max(1, Math.ceil(duration * Math.max(1, fps)));
  const stream = canvas.captureStream(Math.max(1, fps));
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `slate-animation.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      // Restore a clean static state: park on frame 0 and stop previewing.
      const s = useCanvasStore.getState();
      s.setAnimFrame(0);
      s.setAnimPreview(false);
      resolve();
    };
  });

  // Give the canvas one rAF to repaint at frame 0 before recording starts.
  await nextFrame();
  recorder.start();

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const frameMs = 1000 / Math.max(1, fps);

  for (let i = 0; i < totalFrames; i++) {
    const s = useCanvasStore.getState();
    s.setAnimFrame(i);
    // setAnimFrame(0) clears animPreview (only sets it when frame > 0 or
    // playing); flip it back on so the engine keeps repainting.
    s.setAnimPreview(true);
    // Wait one capture period so the recorder samples the freshly-painted
    // frame. One rAF alone is too tight — captureStream samples on its own
    // clock, not on rAF, so a too-short wait drops frames.
    await wait(frameMs);
    onProgress?.((i + 1) / totalFrames);
  }

  // Let the final frame paint, then stop the recorder and resolve.
  await nextFrame();
  recorder.stop();
  await done;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
