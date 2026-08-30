/**
 * AI chat route — server-side twin of the Vercel serverless function at
 * apps/client/api/ai-chat.ts (keep the two in sync).
 *
 * On Vercel the client hits its same-origin serverless function, but in local
 * dev (and on Render or any plain-Node deploy) the Vite proxy / same origin
 * sends /api/ai-chat here instead. Without this route those environments got a
 * bare 404 and the chat panel reported "AI is not available on this
 * deployment".
 *
 * Calls Z.AI's HTTP API directly (NOT z-ai-web-dev-sdk — the SDK ignores
 * config objects and requires a .z-ai-config file that won't exist here).
 * Driven entirely by env vars:
 *   ZAI_BASE_URL  (required) e.g. "https://api.z.ai/api/paas/v4"
 *   ZAI_API_KEY   (required)
 *   ZAI_TOKEN     (optional) JWT → X-Token (internal API only)
 *   ZAI_USER_ID / ZAI_CHAT_ID (optional) → X-User-Id / X-Chat-Id
 *   ZAI_MODEL     (optional; only sent when set)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from './config.js';

/** The client truncates editor context to 8000 chars before sending, so this
 *  ceiling only ever trips on a hand-crafted body. */
const MAX_CONTEXT_CHARS = 32_000;

const chatBody = z.object({
  messages: z
    .array(z.object({ role: z.string(), content: z.string() }))
    .min(1),
  context: z.string().max(MAX_CONTEXT_CHARS).optional(),
  instructions: z.string().max(MAX_CONTEXT_CHARS).optional(),
});

/**
 * Every call here spends the operator's Z.AI credits, and the route is
 * unauthenticated — the chat panel sends no identity token. The server-wide
 * limit of 200/min is sized for cheap JSON endpoints and would let a single
 * client run up a real bill, so this one gets its own much tighter budget.
 * Interactive chat rarely needs more than a handful of turns a minute.
 */
const aiChatRouteOptions = {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
};

export function registerAiChatRoutes(app: FastifyInstance): void {
  app.post('/api/ai-chat', aiChatRouteOptions, async (req, reply) => {
    const baseUrl = env.ZAI_BASE_URL?.replace(/\/+$/, '');
    const apiKey = env.ZAI_API_KEY;

    if (!baseUrl || !apiKey) {
      reply.code(503);
      return {
        error:
          'AI is not configured on this server. Set ZAI_BASE_URL and ZAI_API_KEY (and usually ZAI_TOKEN) in the server environment, then restart.',
      };
    }

    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      // Report what actually failed: with the size caps above, a rejected body
      // is as often an over-long context as a missing messages array.
      const issue = parsed.error.issues[0];
      return {
        error: issue
          ? `Invalid request: ${issue.path.join('.') || 'body'} — ${issue.message}`
          : 'Messages array is required',
      };
    }
    const { messages, context, instructions } = parsed.data;

    let systemContent = context
      ? `You are Slate AI, a helpful assistant integrated into the Slate collaborative editor. You help with writing, coding, brainstorming, and creative work. Here is the user's current document/code context:\n\n---\n${context}\n---\n\nUse this context to give relevant, specific answers. If the context is empty, just help generally.`
      : 'You are Slate AI, a helpful assistant integrated into the Slate collaborative editor. You help with writing, coding, brainstorming, and creative work. Be concise and helpful.';
    if (instructions?.trim()) {
      systemContent += `\n\n${instructions.trim()}`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Z-AI-From': 'Z',
    };
    if (env.ZAI_CHAT_ID) headers['X-Chat-Id'] = env.ZAI_CHAT_ID;
    if (env.ZAI_USER_ID) headers['X-User-Id'] = env.ZAI_USER_ID;
    if (env.ZAI_TOKEN) headers['X-Token'] = env.ZAI_TOKEN;

    const body: Record<string, unknown> = {
      messages: [{ role: 'system', content: systemContent }, ...messages],
      thinking: { type: 'disabled' },
    };
    if (env.ZAI_MODEL) body.model = env.ZAI_MODEL;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 58_000);
    try {
      let upstream: Response;
      try {
        upstream = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        reply.code(502);
        return { error: `AI provider error (${upstream.status}). ${detail.slice(0, 300)}`.trim() };
      }

      const data = (await upstream.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const replyText = data.choices?.[0]?.message?.content?.trim();
      if (!replyText) {
        reply.code(502);
        return { error: 'Empty response from AI' };
      }
      return { reply: replyText };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      reply.code(aborted ? 504 : 500);
      return {
        error: aborted
          ? 'AI request timed out.'
          : error instanceof Error
            ? error.message
            : 'Unknown error',
      };
    }
  });
}
