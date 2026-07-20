import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { docTextToJson, jsonToDocText, type PmJsonNode } from './docTextJson';
import { pmJsonToMarkdown } from './exportMarkdown';

/** A doc exercising every node/mark the editor produces. */
const SAMPLE: PmJsonNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'plain ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] },
      ],
    },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const x = 1;' }] },
    { type: 'horizontalRule' },
    { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'data:image/webp;base64,AAAA', alt: 'pic' } }] },
  ],
};

describe('docTextJson', () => {
  it('round-trips PM JSON through a Y.XmlFragment losslessly', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc:text');
    jsonToDocText(frag, SAMPLE);
    expect(docTextToJson(frag)).toEqual(SAMPLE);
  });

  it('replaces existing content on restore (no duplication)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc:text');
    jsonToDocText(frag, SAMPLE);
    jsonToDocText(frag, SAMPLE);
    expect((docTextToJson(frag).content ?? []).length).toBe(SAMPLE.content!.length);
  });

  it('serializes to sensible markdown', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('doc:text');
    jsonToDocText(frag, SAMPLE);
    const md = pmJsonToMarkdown(docTextToJson(frag));
    expect(md).toContain('# Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('[a link](https://example.com)');
    expect(md).toContain('- one');
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] todo');
    expect(md).toContain('```js\nconst x = 1;\n```');
    expect(md).toContain('---');
    expect(md).toContain('![pic](embedded-image)');
  });
});
