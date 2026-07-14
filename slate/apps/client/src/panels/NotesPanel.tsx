/**
 * NotesPanel — collaborative sections with title, body, and checklist items.
 *
 * Each section is a Y.Map<unknown> with `items: Y.Array<Y.Map>`. Text edits
 * use Y.Text for character-level merge so concurrent typists don't clobber
 * each other.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Plus, Trash2, GripVertical, CheckSquare, Square } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { Button } from '../ui/Button';
import { makeId } from '../utils/id';

interface SectionView {
  id: string;
  title: string;
  body: string;
  items: { id: string; text: string; checked: boolean }[];
}

export function NotesPanel() {
  const room = useRoom();
  const notes = useMemo(() => room.slate.notes(), [room]);
  const [sections, setSections] = useState<SectionView[]>(() => readSections(notes));

  useEffect(() => {
    const update = () => setSections(readSections(notes));
    notes.observeDeep(update);
    return () => notes.unobserveDeep(update);
  }, [notes]);

  const addSection = () => {
    room.slate.doc.transact(() => {
      const s = new Y.Map<unknown>();
      s.set('id', makeId('note'));
      s.set('title', 'Untitled');
      s.set('body', new Y.Text(''));
      s.set('items', new Y.Array<Y.Map<unknown>>());
      s.set('createdAt', Date.now());
      s.set('updatedAt', Date.now());
      notes.push([s]);
    });
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="panel-title">Sections</h4>
        <Button variant="ghost" size="sm" onClick={addSection}>
          <Plus size={12} />
          <span className="ml-1">New</span>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
        {sections.length === 0 && (
          <p className="text-xs text-text-dim text-center pt-4">
            No notes yet. Add one above.
          </p>
        )}
        {sections.map((s, i) => (
          <SectionCard key={s.id} section={s} index={i} />
        ))}
      </div>
    </div>
  );
}

function SectionCard({ section, index }: { section: SectionView; index: number }) {
  const room = useRoom();
  const yMap = useMemo(() => room.slate.notes().get(index), [room, index]);

  if (!yMap) return null;

  const yBody = yMap.get('body') as Y.Text | undefined;
  const yItems = yMap.get('items') as Y.Array<Y.Map<unknown>> | undefined;

  const removeSection = () => {
    room.slate.doc.transact(() => {
      room.slate.notes().delete(index, 1);
    });
  };

  const updateTitle = (v: string) => {
    yMap.set('title', v.slice(0, 200));
    yMap.set('updatedAt', Date.now());
  };

  const addItem = () => {
    if (!yItems) return;
    const it = new Y.Map<unknown>();
    it.set('id', makeId('todo'));
    it.set('text', '');
    it.set('checked', false);
    yItems.push([it]);
  };

  return (
    <div className="rounded-sm bg-bg-3 p-2.5 border border-border">
      <div className="flex items-start gap-1.5">
        <GripVertical size={12} className="mt-1.5 text-text-dim cursor-grab" />
        <input
          value={section.title}
          onChange={(e) => updateTitle(e.target.value)}
          maxLength={200}
          placeholder="Untitled"
          className="flex-1 bg-transparent border-0 p-1 text-sm font-semibold outline-none focus:bg-bg-4 rounded-sm"
        />
        <button
          type="button"
          aria-label="Delete section"
          onClick={removeSection}
          className="p-1 text-text-dim hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {yBody && <CollaborativeText yText={yBody} placeholder="Notes…" />}
      <div className="mt-1.5 flex flex-col gap-0.5">
        {section.items.map((it, j) => (
          <TodoRow key={it.id} item={it} ySection={yMap} index={j} />
        ))}
        <button
          type="button"
          onClick={addItem}
          className="mt-0.5 text-left text-xs text-text-dim hover:text-text px-2 py-1 rounded-sm"
        >
          + add item
        </button>
      </div>
    </div>
  );
}

function TodoRow({
  item,
  ySection,
  index,
}: {
  item: { id: string; text: string; checked: boolean };
  ySection: Y.Map<unknown>;
  index: number;
}) {
  const yItems = ySection.get('items') as Y.Array<Y.Map<unknown>> | undefined;
  const yItem = yItems?.get(index);
  if (!yItem) return null;
  const toggle = () => yItem.set('checked', !item.checked);
  const setText = (v: string) => yItem.set('text', v.slice(0, 2000));
  const remove = () => yItems?.delete(index, 1);
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={item.checked ? 'Uncheck' : 'Check'}
        className="text-text-mid hover:text-accent"
      >
        {item.checked ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>
      <input
        value={item.text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Item"
        maxLength={2000}
        className={
          'flex-1 bg-transparent border-0 p-1 text-sm outline-none focus:bg-bg-4 rounded-sm ' +
          (item.checked ? 'line-through text-text-dim' : 'text-text')
        }
      />
      <button
        type="button"
        onClick={remove}
        aria-label="Remove item"
        className="text-text-dim hover:text-danger opacity-0 group-hover:opacity-100"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

/** Textarea bound to a Y.Text with character-level merge. */
function CollaborativeText({
  yText,
  placeholder,
}: {
  yText: Y.Text;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(() => yText.toString());

  useEffect(() => {
    const update = () => {
      const next = yText.toString();
      // Avoid clobbering during local typing — only set if different.
      if (ref.current && ref.current.value !== next) setValue(next);
    };
    yText.observe(update);
    return () => yText.unobserve(update);
  }, [yText]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    yText.doc?.transact(() => {
      yText.delete(0, yText.length);
      yText.insert(0, next);
    });
  };

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={2}
      className="mt-1 w-full resize-y rounded-sm bg-bg-3 border-0 p-1 text-sm text-text outline-none focus:bg-bg-4 placeholder:text-text-dim"
    />
  );
}

function readSections(notes: Y.Array<Y.Map<unknown>>): SectionView[] {
  const out: SectionView[] = [];
  notes.forEach((s) => {
    const id = String(s.get('id') ?? '');
    if (!id) return;
    const title = String(s.get('title') ?? '');
    const body = s.get('body');
    const bodyStr = body instanceof Y.Text ? body.toString() : String(body ?? '');
    const items: SectionView['items'] = [];
    const yItems = s.get('items') as Y.Array<Y.Map<unknown>> | undefined;
    yItems?.forEach((it) => {
      const iid = String(it.get('id') ?? '');
      if (!iid) return;
      items.push({
        id: iid,
        text: String(it.get('text') ?? ''),
        checked: Boolean(it.get('checked')),
      });
    });
    out.push({ id, title, body: bodyStr, items });
  });
  return out;
}
