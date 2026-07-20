/**
 * Pure-Yjs converters between the doc:text Y.XmlFragment and ProseMirror-
 * shaped JSON — the same encoding y-prosemirror uses, reimplemented WITHOUT
 * importing y-prosemirror/prosemirror-* so the save/export paths (which load
 * eagerly with the workspace) don't pull ProseMirror core into the main
 * bundle. The TipTap editor itself lives in the lazy doc-mode chunk.
 *
 * Encoding (mirrors y-prosemirror):
 *   - Y.XmlElement  → { type: nodeName, attrs?, content? }
 *   - Y.XmlText     → one JSON text node per delta run:
 *                     { type: 'text', text, marks?: [{ type, attrs? }] }
 *     where each delta attribute key is a mark name and its value the mark's
 *     attrs object.
 */

import * as Y from 'yjs';

export interface PmJsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PmJsonNode[];
}

interface TextDeltaRun {
  insert: string;
  attributes?: Record<string, Record<string, unknown>>;
}

/** Serialize the fragment to { type: 'doc', content: [...] } JSON. */
export function docTextToJson(fragment: Y.XmlFragment): PmJsonNode {
  return { type: 'doc', content: fragment.toArray().map(serializeNode).flat() };
}

function serializeNode(node: Y.XmlElement | Y.XmlText | Y.XmlHook): PmJsonNode[] {
  if (node instanceof Y.XmlText) {
    const runs = node.toDelta() as TextDeltaRun[];
    return runs
      .filter((r) => typeof r.insert === 'string' && r.insert.length > 0)
      .map((r) => {
        const out: PmJsonNode = { type: 'text', text: r.insert };
        if (r.attributes && Object.keys(r.attributes).length > 0) {
          out.marks = Object.entries(r.attributes).map(([type, attrs]) =>
            attrs && Object.keys(attrs).length > 0 ? { type, attrs } : { type },
          );
        }
        return out;
      });
  }
  if (node instanceof Y.XmlElement) {
    const out: PmJsonNode = { type: node.nodeName };
    const attrs = node.getAttributes() as Record<string, unknown>;
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
    const content = node.toArray().map(serializeNode).flat();
    if (content.length > 0) out.content = content;
    return [out];
  }
  return []; // Y.XmlHook — not produced by the editor
}

/** Replace the fragment's contents with the given JSON (inside one
 *  transaction). Accepts the output of docTextToJson / editor.getJSON(). */
export function jsonToDocText(fragment: Y.XmlFragment, json: unknown): void {
  const root = (json ?? {}) as PmJsonNode;
  const content = Array.isArray(root.content) ? root.content : [];
  const doc = fragment.doc;
  const apply = () => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    fragment.insert(0, buildChildren(content));
  };
  if (doc) doc.transact(apply);
  else apply();
}

/** Build Y children for a node's JSON content: consecutive text runs merge
 *  into one Y.XmlText (y-prosemirror's layout); elements recurse. */
function buildChildren(nodes: PmJsonNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i]!;
    if (n.type === 'text') {
      const text = new Y.XmlText();
      let at = 0;
      while (i < nodes.length && nodes[i]!.type === 'text') {
        const run = nodes[i]!;
        const t = typeof run.text === 'string' ? run.text : '';
        if (t.length > 0) {
          const attrs: Record<string, Record<string, unknown>> = {};
          for (const m of run.marks ?? []) attrs[m.type] = m.attrs ?? {};
          // ALWAYS pass attrs (even empty): Y.Text.insert without explicit
          // attributes inherits the preceding run's formatting, which would
          // bleed marks into unmarked text.
          text.insert(at, t, attrs);
          at += t.length;
        }
        i++;
      }
      if (at > 0) out.push(text);
      continue;
    }
    if (typeof n.type === 'string') {
      const el = new Y.XmlElement(n.type);
      for (const [k, v] of Object.entries(n.attrs ?? {})) {
        // Y.XmlElement.setAttribute is string-typed but stores any JSON value
        // (y-prosemirror relies on the same behaviour for node attrs).
        el.setAttribute(k, v as unknown as string);
      }
      if (Array.isArray(n.content) && n.content.length > 0) {
        el.insert(0, buildChildren(n.content));
      }
      out.push(el);
    }
    i++;
  }
  return out;
}
