/**
 * Markdown serialization for 'doc' boards.
 *
 * Works directly on the Y.XmlFragment (via the dependency-free converter in
 * docTextJson.ts), so the ExportDialog can produce a .md without a live
 * TipTap editor instance — and without pulling ProseMirror into the eager
 * bundle. Covers every node/mark the DocEditor can produce: headings,
 * paragraphs, bullet/ordered/task lists (nested), blockquotes, code blocks,
 * horizontal rules, images, hard breaks; bold/italic/strike/code/link marks.
 */

import type * as Y from 'yjs';
import { docTextToJson, type PmJsonNode as PmNode } from './docTextJson';

export function docFragmentToMarkdown(fragment: Y.XmlFragment): string {
  return pmJsonToMarkdown(docTextToJson(fragment));
}

/** Plain-text export: one line per textual block, all formatting stripped. */
export function docFragmentToText(fragment: Y.XmlFragment): string {
  const lines: string[] = [];
  const flatText = (nodes: PmNode[]): string =>
    nodes
      .map((n) =>
        typeof n.text === 'string' ? n.text : n.type === 'hardBreak' ? '\n' : n.content ? flatText(n.content) : '',
      )
      .join('');
  const visit = (n: PmNode): void => {
    switch (n.type) {
      case 'paragraph':
      case 'heading':
      case 'codeBlock':
        lines.push(flatText(n.content ?? []));
        break;
      default:
        // Containers (lists, list items, blockquotes, …) recurse; leaves
        // without textual content (hr, images) become nothing.
        for (const c of n.content ?? []) visit(c);
    }
  };
  for (const b of docTextToJson(fragment).content ?? []) visit(b);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function pmJsonToMarkdown(doc: PmNode): string {
  return blocks(doc.content ?? [], '').join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Serialize a run of block nodes; `indent` prefixes continuation lines
 *  (list nesting). Returns one string per block. */
function blocks(nodes: PmNode[], indent: string): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const b = block(n, indent);
    if (b !== null) out.push(b);
  }
  return out;
}

function block(n: PmNode, indent: string): string | null {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content ?? []);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      return `${'#'.repeat(level)} ${inline(n.content ?? [])}`;
    }
    case 'bulletList':
      return list(n.content ?? [], indent, () => '- ');
    case 'orderedList': {
      let i = Number(n.attrs?.start ?? 1);
      return list(n.content ?? [], indent, () => `${i++}. `);
    }
    case 'taskList':
      return list(n.content ?? [], indent, (item) => (item.attrs?.checked ? '- [x] ' : '- [ ] '));
    case 'blockquote':
      return blocks(n.content ?? [], indent)
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'codeBlock': {
      const lang = typeof n.attrs?.language === 'string' ? n.attrs.language : '';
      const text = (n.content ?? []).map((c) => c.text ?? '').join('');
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'image': {
      const src = typeof n.attrs?.src === 'string' ? n.attrs.src : '';
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : 'image';
      // Data-URL images would make the .md unreadable — reference them by name.
      return src.startsWith('data:') ? `![${alt}](embedded-image)` : `![${alt}](${src})`;
    }
    default:
      // Unknown block: flatten to its inline text so nothing is lost silently.
      return n.content ? inline(n.content) : null;
  }
}

/** One list: each item's first block goes after the marker; subsequent
 *  blocks (nested lists, extra paragraphs) are indented to align. */
function list(items: PmNode[], indent: string, marker: (item: PmNode) => string): string {
  const lines: string[] = [];
  for (const item of items) {
    const m = marker(item);
    const cont = indent + ' '.repeat(m.length);
    const bs = blocks(item.content ?? [], cont);
    const first = bs.shift() ?? '';
    lines.push(indent + m + first.split('\n').join(`\n${cont}`));
    for (const b of bs) lines.push(b.split('\n').map((l) => (l ? cont + l : l)).join('\n'));
  }
  return lines.join('\n');
}

function inline(nodes: PmNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out += '  \n';
      continue;
    }
    if (n.type === 'image') {
      const src = typeof n.attrs?.src === 'string' ? n.attrs.src : '';
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt : 'image';
      out += src.startsWith('data:') ? `![${alt}](embedded-image)` : `![${alt}](${src})`;
      continue;
    }
    if (typeof n.text !== 'string') continue;
    let t = n.text;
    const marks = n.marks ?? [];
    const has = (type: string) => marks.some((m) => m.type === type);
    // Order matters: code is exclusive (no nested emphasis inside backticks).
    if (has('code')) {
      out += `\`${t}\``;
      continue;
    }
    if (has('bold')) t = `**${t}**`;
    if (has('italic')) t = `*${t}*`;
    if (has('strike')) t = `~~${t}~~`;
    const link = marks.find((m) => m.type === 'link');
    if (link && typeof link.attrs?.href === 'string') t = `[${t}](${link.attrs.href})`;
    out += t;
  }
  return out;
}
