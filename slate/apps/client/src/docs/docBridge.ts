/**
 * Bridge between the AI assistant panel and the central DocEditor. The panel
 * doesn't hold the TipTap editor instance, so it dispatches a window event with
 * the new document HTML; DocEditor listens and applies it (which syncs through
 * Yjs like any edit). Mirrors the code editor's `slate:code-open-file` bridge.
 */

export const DOC_APPLY_EVENT = 'slate:doc-apply';

/** Formatting/insert commands fired by the dockable Doc Tools panel; DocEditor
 *  listens and runs the matching TipTap command on its editor instance. */
export const DOC_COMMAND_EVENT = 'slate:doc-command';

export function runDocCommand(command: string): void {
  window.dispatchEvent(new CustomEvent<{ command: string }>(DOC_COMMAND_EVENT, { detail: { command } }));
}

export interface DocApplyDetail {
  /** Full document HTML to replace the current content with. */
  html: string;
}

export function applyDocHtml(html: string): void {
  window.dispatchEvent(new CustomEvent<DocApplyDetail>(DOC_APPLY_EVENT, { detail: { html } }));
}

/**
 * Pull the document HTML out of an AI reply. The assistant is told to return
 * the whole updated document in a single fenced block tagged `doc`:
 *
 *     ```html doc
 *     <h1>Title</h1><p>…</p>
 *     ```
 *
 * Returns null when the reply has no such block (a plain chat answer).
 */
export function parseAiDocHtml(text: string): string | null {
  const m = /```(?:html)?\s+doc\b[^\n]*\n([\s\S]*?)```/i.exec(text);
  if (!m) return null;
  const html = (m[1] ?? '').trim();
  return html.length > 0 ? html : null;
}

/** Remove the ```html doc block from a reply, leaving the prose for the chat. */
export function stripDocBlock(text: string): string {
  return text.replace(/```(?:html)?\s+doc\b[^\n]*\n[\s\S]*?```/i, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Instructions appended to the AI system prompt in doc mode. */
export const DOC_AI_INSTRUCTIONS = `This is a rich-text DOCUMENT you can edit directly. When the user asks you to write, rewrite, or change the document, output the COMPLETE updated document as a single fenced block tagged "doc":

\`\`\`html doc
<h1>Heading</h1>
<p>Body text…</p>
\`\`\`

Rules:
- Output the ENTIRE document every time (it REPLACES the current content), never a fragment or "…unchanged".
- Use simple semantic HTML only: h1–h3, p, strong, em, u, s, code, pre, blockquote, ul/ol/li, hr, a, table/tr/td/th, img. No <html>/<head>/<body> wrappers, no <style>, no scripts.
- For plain questions that don't change the document, just answer normally without a doc block.`;
