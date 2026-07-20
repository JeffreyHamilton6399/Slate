/**
 * AiChatPanel — AI assistant panel that reads the current editor context
 * and provides intelligent help. Available in all modes.
 *
 * - Doc mode: sends the document's Markdown content as context
 * - Code mode: sends all code files as context
 * - Other modes: general assistant (no editor context)
 *
 * The AI backend is a Next.js API route at /api/ai-chat that uses
 * z-ai-web-dev-sdk (server-side only per the LLM skill rules).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Bot, Send, Trash2, Loader2, Paperclip } from 'lucide-react';
import { useRoom } from '../sync/RoomContext';
import { useAppStore } from '../app/store';
import { listCodeFiles } from '../code/exportCode';
import { docFragmentToMarkdown } from '../docs/exportMarkdown';
import { cn } from '../utils/cn';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export function AiChatPanel() {
  const room = useRoom();
  const board = useAppStore((s) => s.currentBoard);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Gather editor context based on the current mode.
  // Guard against room.slate being undefined (can happen during room init
  // or if the panel renders before the RoomProvider is fully ready).
  const gatherContext = useCallback((): string => {
    if (!board || !includeContext || !room?.slate) return '';
    try {
      if (board.mode === 'doc') {
        const fragment = room.slate.docText?.();
        if (!fragment) return '';
        const md = docFragmentToMarkdown(fragment);
        if (md.trim().length === 0) return '';
        // Truncate to avoid exceeding token limits
        return md.slice(0, 8000);
      }
      if (board.mode === 'code') {
        const files = listCodeFiles(room.slate);
        if (files.length === 0) return '';
        const parts: string[] = [];
        for (const f of files) {
          const content = room.slate.codeText(f.id).toString();
          parts.push(`// === ${f.name} ===\n${content}`);
          if (parts.join('\n\n').length > 8000) break; // token limit
        }
        return parts.join('\n\n').slice(0, 8000);
      }
    } catch {
      // ignore — just send without context
    }
    return '';
  }, [board, room, includeContext]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setLoading(true);

    const userMsg: ChatMsg = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    try {
      const context = gatherContext();
      // The AI chat API route lives in the Next.js app. When the Slate SPA is
      // served from the same origin (e.g., via the /slate/ redirect on
      // localhost:3000 or Vercel), a relative fetch works. On standalone
      // deployments the route may not exist — show a clear error.
      let resp: Response;
      try {
        resp = await fetch('/api/ai-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
            context,
          }),
        });
      } catch (fetchErr) {
        throw new Error('Cannot reach the AI server. If you\'re running Slate standalone, the AI chat requires the Next.js backend.');
      }
      if (resp.status === 405 || resp.status === 404) {
        throw new Error('AI chat is not available on this deployment. The Next.js API route at /api/ai-chat was not found.');
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'Request failed');
        let errMsg = errText;
        try { const errJson = JSON.parse(errText); errMsg = errJson.error || errText; } catch { /* not JSON */ }
        throw new Error(errMsg || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (!data.reply) throw new Error('No reply from AI');
      const aiMsg: ChatMsg = { role: 'assistant', content: data.reply };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const errorMsg: ChatMsg = {
        role: 'assistant',
        content: `Sorry, I couldn't respond: ${(err as Error).message}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, gatherContext]);

  const clearChat = useCallback(() => {
    setMessages([]);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const modeLabel = board?.mode === 'doc' ? 'document' : board?.mode === 'code' ? 'code' : board?.mode === 'audio' ? 'audio project' : board?.mode === '3d' ? '3D scene' : 'canvas';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Bot size={13} className="text-accent" />
        <span className="text-[11px] font-medium text-text">AI Assistant</span>
        <div className="flex-1" />
        <button
          onClick={clearChat}
          className="flex h-5 w-5 items-center justify-center rounded text-text-mid hover:bg-bg-3 hover:text-danger"
          title="Clear chat"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-2">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Bot size={28} className="text-text-dim" />
            <p className="text-[11px] text-text-dim">
              Ask me anything about your {modeLabel}.
            </p>
            <p className="text-[10px] text-text-dim/70">
              {includeContext && (board?.mode === 'doc' || board?.mode === 'code')
                ? `I can see your ${modeLabel} content.`
                : 'General assistant mode.'}
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn(
              'mb-2 rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed',
              msg.role === 'user'
                ? 'bg-accent/15 text-text'
                : 'bg-bg-3 text-text-mid',
            )}
          >
            {msg.role === 'assistant' && (
              <div className="mb-0.5 flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-text-dim">
                <Bot size={9} /> AI
              </div>
            )}
            <p className="whitespace-pre-wrap break-words">{msg.content}</p>
          </div>
        ))}
        {loading && (
          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-bg-3 px-2.5 py-1.5 text-[11px] text-text-dim">
            <Loader2 size={12} className="animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      {/* Context toggle */}
      <div className="shrink-0 border-t border-border px-2 py-1">
        <button
          onClick={() => setIncludeContext((v) => !v)}
          className={cn(
            'flex items-center gap-1 rounded px-1 py-0.5 text-[9px] font-mono uppercase tracking-wider',
            includeContext ? 'text-accent' : 'text-text-dim',
          )}
          title={includeContext ? 'Sending editor context to AI' : 'No editor context'}
        >
          <Paperclip size={9} />
          {includeContext ? `Context: ${modeLabel}` : 'No context'}
        </button>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border p-1.5">
        <div className="flex items-end gap-1">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask AI…"
            rows={2}
            className="min-h-[36px] flex-1 resize-none rounded-sm border border-border bg-bg-3 px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
            disabled={loading}
          />
          <button
            onClick={() => void send()}
            disabled={!input.trim() || loading}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-accent text-white hover:bg-accent/80 disabled:opacity-30"
            title="Send (Enter)"
          >
            <Send size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
