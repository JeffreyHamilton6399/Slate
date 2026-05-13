/**
 * ChatPanel — append-only Y.Array of chat messages.
 *
 * Renders messages as text nodes (no innerHTML); auto-scrolls to bottom on
 * new messages unless the user has scrolled up. Each message is validated
 * with zod before being appended to defend against malformed inputs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Send } from 'lucide-react';
import {
  chatMessageSchema,
  colorForPeerId,
  sanitizeChatText,
  type ChatMessage,
} from '@slate/sync-protocol';
import { useRoom } from '../sync/RoomContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { makeId } from '../utils/id';

export function ChatPanel() {
  const room = useRoom();
  const chat = useMemo(() => room.slate.chat(), [room]);
  const [messages, setMessages] = useState<ChatMessage[]>(() => readMessages(chat));
  const [draft, setDraft] = useState('');
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const update = () => setMessages(readMessages(chat));
    chat.observe(update);
    return () => chat.unobserve(update);
  }, [chat]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const send = () => {
    const text = sanitizeChatText(draft);
    if (!text) return;
    const msg: ChatMessage = {
      id: makeId('chat'),
      authorId: room.identity.peerId,
      authorName: room.identity.name,
      text,
      createdAt: Date.now(),
    };
    const parsed = chatMessageSchema.safeParse(msg);
    if (!parsed.success) return;
    room.slate.doc.transact(() => {
      const item = new Y.Map<unknown>();
      Object.entries(parsed.data).forEach(([k, v]) => item.set(k, v));
      chat.push([item]);
    });
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto pr-1 space-y-2"
      >
        {messages.length === 0 ? (
          <p className="text-xs text-text-dim text-center pt-4">
            No messages yet. Say hi.
          </p>
        ) : (
          messages.map((m) => <ChatBubble key={m.id} m={m} self={m.authorId === room.identity.peerId} />)
        )}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message"
          maxLength={2000}
        />
        <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>
          <Send size={14} />
        </Button>
      </form>
    </div>
  );
}

function ChatBubble({ m, self }: { m: ChatMessage; self: boolean }) {
  const color = colorForPeerId(m.authorId);
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded-sm bg-bg-3 p-2 text-sm">
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-wider">
        <span style={{ color }}>{self ? 'You' : m.authorName}</span>
        <span className="text-text-dim">{time}</span>
      </div>
      <p className="mt-1 break-words whitespace-pre-wrap text-text">{m.text}</p>
    </div>
  );
}

function readMessages(chat: Y.Array<Y.Map<unknown>>): ChatMessage[] {
  const out: ChatMessage[] = [];
  chat.forEach((item) => {
    const candidate = {
      id: item.get('id'),
      authorId: item.get('authorId'),
      authorName: item.get('authorName'),
      text: item.get('text'),
      createdAt: item.get('createdAt'),
    };
    const parsed = chatMessageSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  });
  return out;
}
