/**
 * DocImage — the base TipTap image extension plus `width`, `align`, and
 * `rotation` attributes so the toolbar can resize, align, and rotate a selected
 * image. Each attribute renders an inline style; TipTap's `mergeAttributes`
 * concatenates the `style` strings, so width + rotation coexist on one <img>.
 *
 * Values are stored on the node (and therefore in Yjs), so size/rotation sync
 * to every peer and survive reload/export like any other doc content.
 */

import Image from '@tiptap/extension-image';

export const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).style.width || el.getAttribute('width') || null,
        renderHTML: (attrs) => (attrs.width ? { style: `width: ${attrs.width}` } : {}),
      },
      // Block alignment is applied via auto margins on the (block) image.
      align: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-align'),
        renderHTML: (attrs) => {
          if (!attrs.align || attrs.align === 'left') return {};
          const margin = attrs.align === 'center' ? '0 auto' : '0 0 0 auto';
          return { 'data-align': attrs.align, style: `margin: ${margin}` };
        },
      },
      rotation: {
        default: 0,
        parseHTML: (el) => {
          const m = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec((el as HTMLElement).style.transform || '');
          return m ? Number(m[1]) : 0;
        },
        renderHTML: (attrs) =>
          attrs.rotation ? { style: `transform: rotate(${attrs.rotation}deg)` } : {},
      },
    };
  },
});

export default DocImage;
