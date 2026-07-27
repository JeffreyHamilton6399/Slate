/**
 * Export a slide to a PNG by drawing its elements onto an offscreen canvas.
 *
 * Draws directly with canvas 2D (no SVG/foreignObject round-trip) so remote
 * bucket-hosted images work: they load through crossOrigin="anonymous" Image
 * elements, which SVG-as-image would refuse to fetch.
 */

import { SLIDE_W, SLIDE_H, type Slide, type SlideElement } from '@slate/sync-protocol';

const escAttr = (v: string) => v.replace(/"/g, '&quot;');
const escText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One element as absolutely-positioned HTML inside the 1280×720 stage. */
function elementHtml(el: SlideElement): string {
  const base =
    `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;` +
    (el.rotation ? `transform:rotate(${el.rotation}rad);` : '');
  switch (el.kind) {
    case 'text':
      return (
        `<div style="${base}color:${escAttr(el.color ?? '#e0dff5')};font-size:${el.fontSize ?? 32}px;` +
        `font-weight:${el.bold ? 700 : 400};text-align:${el.align ?? 'left'};line-height:1.25;` +
        `white-space:pre-wrap;overflow-wrap:break-word;padding:8px;">${escText(el.text ?? '')}</div>`
      );
    case 'image':
      return el.src
        ? `<img src="${escAttr(el.src)}" alt="" style="${base}object-fit:fill;" />`
        : '';
    case 'rect':
    case 'ellipse':
      return (
        `<div style="${base}background:${escAttr(el.fill ?? 'transparent')};` +
        `border:${el.strokeWidth ?? 2}px solid ${escAttr(el.stroke ?? '#c9c7e8')};` +
        `border-radius:${el.kind === 'ellipse' ? '50%' : '6px'};"></div>`
      );
    case 'line':
    case 'arrow': {
      const sw = el.strokeWidth ?? 3;
      const c = escAttr(el.stroke ?? '#c9c7e8');
      const head =
        el.kind === 'arrow'
          ? `<path d="M ${el.w - 14} ${el.h / 2 - 7} L ${el.w} ${el.h / 2} L ${el.w - 14} ${el.h / 2 + 7}" stroke="${c}" stroke-width="${sw}" fill="none" stroke-linecap="round" />`
          : '';
      return (
        `<svg style="${base}" viewBox="0 0 ${Math.max(1, el.w)} ${Math.max(1, el.h)}">` +
        `<line x1="0" y1="${el.h / 2}" x2="${el.w}" y2="${el.h / 2}" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" />${head}</svg>`
      );
    }
  }
}

/**
 * Standalone HTML document for a whole deck — one full-viewport `<section>`
 * per slide, each holding a 1280×720 stage scaled to fit. Same geometry the
 * editor renders, so the exported file matches what you authored, and it
 * paginates cleanly for print-to-PDF.
 */
export function deckToHtml(
  boardName: string,
  slides: Slide[],
  elementsBySlide: Map<string, SlideElement[]>,
): string {
  const sections = slides
    .map((s, i) => {
      const els = (elementsBySlide.get(s.id) ?? []).map(elementHtml).join('');
      const notes = s.notes
        ? `<aside class="notes"><strong>Notes:</strong> ${escText(s.notes)}</aside>`
        : '';
      return (
        `<section class="slide" data-index="${i}" style="background:${escAttr(s.background)};">` +
        `<div class="stage">${els}</div>${notes}</section>`
      );
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escText(boardName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #000; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
  .slide {
    width: 100vw; height: 100vh;
    display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden; page-break-after: always;
  }
  /* The stage is authored at a fixed size and scaled to the viewport, so the
     export is laid out exactly like the editor at any window size. */
  .stage {
    width: ${SLIDE_W}px; height: ${SLIDE_H}px; position: relative; flex: none;
    transform: scale(min(calc(100vw / ${SLIDE_W}), calc(100vh / ${SLIDE_H})));
  }
  .notes {
    position: absolute; bottom: 1rem; left: 1rem; right: 1rem; font-size: 0.85rem;
    color: rgba(255,255,255,0.5); background: rgba(0,0,0,0.4);
    padding: 0.5rem 0.75rem; border-radius: 4px;
  }
  @media print {
    body { background: #fff; }
    .notes { display: none; }
    .slide { width: 100%; height: 100vh; }
    @page { size: landscape; margin: 0; }
  }
</style>
</head>
<body>
${sections}
</body>
</html>`;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Word-wrap `text` to `maxWidth` using the canvas' current font. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const probe = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(probe).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = probe;
      }
    }
    out.push(line);
  }
  return out;
}

/** Render one slide at `scale`× logical resolution and return a PNG blob. */
export async function exportSlidePng(
  background: string,
  elements: SlideElement[],
  scale = 2,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SLIDE_W * scale;
  canvas.height = SLIDE_H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, SLIDE_W, SLIDE_H);

  // Preload every image first so drawing stays synchronous and in z order.
  const images = new Map<string, HTMLImageElement | null>();
  for (const el of elements) {
    if (el.kind === 'image' && el.src && !images.has(el.src)) {
      images.set(el.src, await loadImage(el.src));
    }
  }

  for (const el of elements) {
    ctx.save();
    if (el.rotation) {
      ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
      ctx.rotate(el.rotation);
      ctx.translate(-(el.x + el.w / 2), -(el.y + el.h / 2));
    }
    switch (el.kind) {
      case 'rect':
      case 'ellipse': {
        ctx.beginPath();
        if (el.kind === 'rect') ctx.roundRect(el.x, el.y, el.w, el.h, 6);
        else ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
        if (el.fill) {
          ctx.fillStyle = el.fill;
          ctx.fill();
        }
        ctx.lineWidth = el.strokeWidth ?? 2;
        ctx.strokeStyle = el.stroke ?? '#c9c7e8';
        ctx.stroke();
        break;
      }
      case 'line':
      case 'arrow': {
        const y = el.y + el.h / 2;
        ctx.lineWidth = el.strokeWidth ?? 3;
        ctx.strokeStyle = el.stroke ?? '#c9c7e8';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(el.x, y);
        ctx.lineTo(el.x + el.w, y);
        if (el.kind === 'arrow') {
          ctx.moveTo(el.x + el.w - 14, y - 7);
          ctx.lineTo(el.x + el.w, y);
          ctx.lineTo(el.x + el.w - 14, y + 7);
        }
        ctx.stroke();
        break;
      }
      case 'image': {
        const img = el.src ? images.get(el.src) : null;
        if (img) ctx.drawImage(img, el.x, el.y, el.w, el.h);
        break;
      }
      case 'text': {
        const size = el.fontSize ?? 32;
        const pad = 8;
        ctx.font = `${el.bold ? '700' : '400'} ${size}px Inter, sans-serif`;
        ctx.fillStyle = el.color ?? '#e0dff5';
        ctx.textBaseline = 'top';
        const align = el.align ?? 'left';
        ctx.textAlign = align;
        const tx = align === 'center' ? el.x + el.w / 2 : align === 'right' ? el.x + el.w - pad : el.x + pad;
        const lines = wrapText(ctx, el.text ?? '', el.w - pad * 2);
        lines.forEach((line, i) => {
          ctx.fillText(line, tx, el.y + pad + i * size * 1.25);
        });
        break;
      }
    }
    ctx.restore();
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png');
  });
}
