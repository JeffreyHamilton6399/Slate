/**
 * Diagram export — serialize the nodes + connectors to a standalone SVG (and
 * from there to a PNG). Labels are rendered as wrapped <text>/<tspan> (not the
 * on-screen foreignObject) so the markup rasterizes reliably through an <img>.
 * The export is framed to the content bounds, independent of the live viewport.
 */

import type { DiagramNode, DiagramEdge } from '@slate/sync-protocol';
import { edgePath, nodeCenter } from './model';

const PAD = 40;
const FONT = 14;
const CHAR_W = FONT * 0.58;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** Greedy word-wrap `text` to lines that fit `width` (board units). */
function wrap(text: string, width: number): string[] {
  const maxChars = Math.max(4, Math.floor((width - 16) / CHAR_W));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

function labelSvg(node: DiagramNode): string {
  if (!node.text) return '';
  const c = nodeCenter(node);
  const lines = wrap(node.text, node.w);
  const lineH = FONT * 1.25;
  const startY = c.y - ((lines.length - 1) * lineH) / 2;
  const tspans = lines
    .map((ln, i) => `<tspan x="${c.x.toFixed(1)}" y="${(startY + i * lineH).toFixed(1)}">${esc(ln)}</tspan>`)
    .join('');
  return `<text text-anchor="middle" dominant-baseline="central" font-family="Inter, sans-serif" font-size="${FONT}" fill="${esc(node.stroke)}">${tspans}</text>`;
}

function nodeSvg(n: DiagramNode): string {
  const { x, y, w, h, fill, stroke } = n;
  const s = 1.5;
  const attrs = `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${s}"`;
  let shape: string;
  if (n.shape === 'ellipse') {
    shape = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`;
  } else if (n.shape === 'diamond') {
    shape = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${attrs}/>`;
  } else if (n.shape === 'pill') {
    shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" ${attrs}/>`;
  } else if (n.shape === 'triangle') {
    shape = `<polygon points="${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}" ${attrs} stroke-linejoin="round"/>`;
  } else if (n.shape === 'parallelogram') {
    const off = Math.min(w * 0.25, h);
    shape = `<polygon points="${x + off},${y} ${x + w},${y} ${x + w - off},${y + h} ${x},${y + h}" ${attrs} stroke-linejoin="round"/>`;
  } else if (n.shape === 'hexagon') {
    const off = Math.min(w * 0.22, h / 2);
    shape = `<polygon points="${x + off},${y} ${x + w - off},${y} ${x + w},${y + h / 2} ${x + w - off},${y + h} ${x + off},${y + h} ${x},${y + h / 2}" ${attrs} stroke-linejoin="round"/>`;
  } else if (n.shape === 'cylinder') {
    const ry = Math.min(h * 0.16, 18);
    shape =
      `<path d="M${x},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + h - ry} V${y + ry} Z" ${attrs} stroke-linejoin="round"/>` +
      `<ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" ${attrs}/>`;
  } else if (n.shape === 'note') {
    const f = Math.min(16, w / 3, h / 3);
    shape =
      `<path d="M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + h} H${x} Z" ${attrs} stroke-linejoin="round"/>` +
      `<path d="M${x + w - f},${y} V${y + f} H${x + w} Z" fill="${esc(stroke)}" fill-opacity="0.25" stroke="${esc(stroke)}" stroke-width="${s}" stroke-linejoin="round"/>`;
  } else {
    shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ${attrs}/>`;
  }
  return shape + labelSvg(n);
}

function edgeSvg(edge: DiagramEdge, byId: Map<string, DiagramNode>): string {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';
  const { d, mid } = edgePath(a, b, edge.routing ?? 'straight');
  const dash = edge.dashed ? ' stroke-dasharray="7 5"' : '';
  const path = `<path d="${d}" fill="none" stroke="${esc(edge.stroke)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${dash} marker-end="url(#arrow)"/>`;
  if (!edge.label) return path;
  return (
    path +
    `<text x="${mid.x.toFixed(1)}" y="${(mid.y - 5).toFixed(1)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="${esc(edge.stroke)}">${esc(edge.label)}</text>`
  );
}

/** Build a standalone SVG string framed to the diagram's content bounds. */
export function diagramToSvg(nodes: DiagramNode[], edges: DiagramEdge[], paper: string): string {
  let minX = 0, minY = 0, maxX = 400, maxY = 300;
  if (nodes.length) {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
  }
  const x = minX - PAD;
  const y = minY - PAD;
  const w = maxX - minX + PAD * 2;
  const h = maxY - minY + PAD * 2;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const body = edges.map((e) => edgeSvg(e, byId)).join('') + nodes.map(nodeSvg).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}">` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs>` +
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${esc(paper)}"/>` +
    body +
    `</svg>`
  );
}

/** Rasterize an SVG string to a PNG blob at the given pixel scale. */
export function diagramSvgToPng(svg: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas not available'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not rasterize the diagram'));
    };
    img.src = url;
  });
}
