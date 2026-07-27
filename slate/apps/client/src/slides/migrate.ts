/**
 * One-way migration: legacy HTML decks → the structured element model.
 *
 * Decks authored before the editor swap stored each slide as a single HTML
 * blob written by a contenteditable (`legacySlides()`, a Y.Array of
 * { id, content, background, textColor, notes, … }). The current editor stores
 * positioned elements instead, so without this pass every one of those decks
 * would open completely blank.
 *
 * The conversion walks the HTML's block-level children and lays them out down
 * the slide: headings and paragraphs become text boxes sized from their tag,
 * list items become one text box each with a bullet, and <img> becomes an
 * image element. Inline styling beyond bold/alignment is dropped — the goal is
 * "your content is here and editable", not a pixel-perfect re-render of
 * arbitrary HTML.
 *
 * Runs once per board: it no-ops when the element model already has slides, so
 * concurrent peers and repeat opens converge on a single conversion.
 */

import * as Y from 'yjs';
import { SLIDE_W, SLIDE_H } from '@slate/sync-protocol';
import { makeId } from '../utils/id';
import { toYMap } from './model';
import { defaultTextColor } from './background';

/** Page margin used when laying converted content down the slide. */
const M = 80;
/** Font size per block tag, in logical slide units. */
const FONT_FOR_TAG: Record<string, number> = {
  h1: 64,
  h2: 48,
  h3: 36,
  h4: 30,
  li: 28,
  p: 30,
  div: 30,
  blockquote: 30,
};

interface Converted {
  kind: 'text' | 'image';
  text?: string;
  src?: string;
  fontSize: number;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  /** Natural height estimate in slide units, used to stack blocks. */
  height: number;
}

/** Nearest ancestor text-align, walking up to the slide root. */
function inheritedAlign(el: Element): 'left' | 'center' | 'right' {
  let cur: Element | null = el;
  while (cur) {
    const raw = (cur as HTMLElement).style?.textAlign;
    if (raw === 'center' || raw === 'right' || raw === 'left') return raw;
    cur = cur.parentElement;
  }
  return 'left';
}

/** Flatten one slide's HTML into an ordered list of convertible blocks. */
function readBlocks(html: string): Converted[] {
  const out: Converted[] = [];
  if (!html.trim()) return out;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

  const visit = (node: Element): void => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') {
      const src = node.getAttribute('src');
      if (src) out.push({ kind: 'image', src, fontSize: 0, bold: false, align: 'left', height: 320 });
      return;
    }
    // A wrapper with only element children contributes nothing itself — walk in.
    const hasOwnText = Array.from(node.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
    const isBlock = tag in FONT_FOR_TAG || tag === 'ul' || tag === 'ol';
    if (!hasOwnText && (tag === 'div' || tag === 'ul' || tag === 'ol' || tag === 'body' || !isBlock)) {
      for (const child of Array.from(node.children)) visit(child);
      return;
    }
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) {
      for (const child of Array.from(node.children)) visit(child);
      return;
    }
    const fontSize = FONT_FOR_TAG[tag] ?? 30;
    const bold = tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4'
      || (node as HTMLElement).style?.fontWeight === '700'
      || (node as HTMLElement).style?.fontWeight === 'bold';
    // Rough wrap estimate: ~0.55em average glyph width across the text column.
    const perLine = Math.max(1, Math.floor((SLIDE_W - M * 2) / (fontSize * 0.55)));
    const lines = Math.max(1, Math.ceil(text.length / perLine));
    out.push({
      kind: 'text',
      text: tag === 'li' ? `• ${text}` : text,
      fontSize,
      bold,
      align: inheritedAlign(node),
      height: lines * fontSize * 1.25 + 16,
    });
  };

  for (const child of Array.from(doc.body.children)) visit(child);
  return out;
}

/** True when this board still needs converting. */
export function needsMigration(
  legacy: Y.Array<Y.Map<unknown>>,
  slides: Y.Map<Y.Map<unknown>>,
): boolean {
  return legacy.length > 0 && slides.size === 0;
}

/**
 * Convert a legacy deck into slides + elements. No-op unless the legacy array
 * has content and the element model is still empty. The legacy array is left
 * untouched, so a bad conversion is always recoverable.
 */
export function migrateLegacyDeck(
  doc: Y.Doc,
  legacy: Y.Array<Y.Map<unknown>>,
  slides: Y.Map<Y.Map<unknown>>,
  elements: Y.Map<Y.Map<unknown>>,
  authorId: string,
): number {
  if (!needsMigration(legacy, slides)) return 0;
  const now = Date.now();
  let converted = 0;

  doc.transact(() => {
    // Re-check inside the transaction: a peer may have migrated already.
    if (slides.size > 0) return;
    legacy.forEach((m, index) => {
      const background = (m.get('background') as string | undefined) || '#14141b';
      const textColorRaw = (m.get('textColor') as string | undefined) || '';
      const color = textColorRaw || defaultTextColor(background);
      const slideId = (m.get('id') as string | undefined) || makeId('slide');
      slides.set(
        slideId,
        toYMap({
          order: index + 1,
          background,
          // Speaker notes survive the conversion.
          notes: (m.get('notes') as string | undefined) || '',
          createdAt: now,
          authorId,
        }),
      );
      converted++;

      const blocks = readBlocks((m.get('content') as string | undefined) ?? '');
      // Stack blocks down the page; if they overflow, compress the gap rather
      // than run off the slide.
      const total = blocks.reduce((sum, b) => sum + b.height, 0);
      const gap = total > SLIDE_H - M * 2 ? 8 : 20;
      let y = M;
      let z = 0;
      for (const b of blocks) {
        const h = Math.min(b.height, SLIDE_H - M - y);
        if (h <= 0) break; // ran out of page
        elements.set(
          makeId('sel'),
          toYMap({
            slideId,
            kind: b.kind,
            x: M,
            y,
            w: SLIDE_W - M * 2,
            h,
            rotation: 0,
            z: ++z,
            ...(b.kind === 'text'
              ? { text: b.text, fontSize: b.fontSize, color, align: b.align, bold: b.bold }
              : { src: b.src }),
            createdAt: now,
            authorId,
          }),
        );
        y += h + gap;
      }
    });
  });

  return converted;
}
