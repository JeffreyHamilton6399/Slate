/**
 * Vercel Serverless Function — AI Chat (Z.AI)
 *
 * Calls Z.AI's HTTP API directly instead of z-ai-web-dev-sdk. The SDK's
 * `ZAI.create()` takes NO arguments and ALWAYS reads a `.z-ai-config` file from
 * cwd / home / /etc — it ignores any config object passed to it. That file
 * doesn't exist on Vercel, so every request failed with "Configuration file not
 * found or invalid" no matter how the env vars were set. (This keeps getting
 * reverted to the SDK by regen tools — leave it as a direct fetch.)
 *
 * Reproduces the exact request the SDK makes, driven entirely by env vars:
 *   ZAI_BASE_URL  (required) e.g. "https://api.z.ai/api/paas/v4"
 *   ZAI_API_KEY   (required)
 *   ZAI_TOKEN     (optional) JWT → X-Token (internal API only)
 *   ZAI_USER_ID / ZAI_CHAT_ID (optional) → X-User-Id / X-Chat-Id
 *   ZAI_MODEL     (optional; only sent when set)
 *
 * Twin implementation for local dev / plain-Node deploys lives at
 * apps/server/src/aiChat.ts — keep the two in sync.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

// Long generations (a multi-file app) can exceed the default 10s.
export const maxDuration = 60;

interface ChatMessage {
  role: string;
  content: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed — use POST" });
    return;
  }

  const baseUrl = process.env.ZAI_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.ZAI_API_KEY;
  const token = process.env.ZAI_TOKEN;
  const userId = process.env.ZAI_USER_ID;
  const chatId = process.env.ZAI_CHAT_ID;
  const model = process.env.ZAI_MODEL;

  if (!baseUrl || !apiKey) {
    res.status(503).json({
      error:
        "AI is not configured. Set ZAI_BASE_URL and ZAI_API_KEY (and usually ZAI_TOKEN) in the Vercel project's Environment Variables, then redeploy.",
    });
    return;
  }

  try {
    const { messages, context, instructions } = (req.body ?? {}) as {
      messages?: ChatMessage[];
      context?: string;
      instructions?: string;
    };
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Messages array is required" });
      return;
    }

    let systemContent = context
      ? `You are Slate AI, a helpful assistant integrated into the Slate collaborative editor. You help with writing, coding, brainstorming, and creative work. Here is the user's current document/code context:\n\n---\n${context}\n---\n\nUse this context to give relevant, specific answers. If the context is empty, just help generally.`
      : "You are Slate AI, a helpful assistant integrated into the Slate collaborative editor. You help with writing, coding, brainstorming, and creative work. Be concise and helpful.";
    if (typeof instructions === "string" && instructions.trim()) {
      systemContent += `\n\n${instructions.trim()}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Z-AI-From": "Z",
    };
    if (chatId) headers["X-Chat-Id"] = chatId;
    if (userId) headers["X-User-Id"] = userId;
    if (token) headers["X-Token"] = token;

    const body: Record<string, unknown> = {
      messages: [{ role: "system", content: systemContent }, ...messages],
      thinking: { type: "disabled" },
    };
    if (model) body.model = model;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 58_000);
    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      res.status(502).json({ error: `AI provider error (${upstream.status}). ${detail.slice(0, 300)}`.trim() });
      return;
    }

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      res.status(502).json({ error: "Empty response from AI" });
      return;
    }

    res.status(200).json({ reply });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    res.status(aborted ? 504 : 500).json({
      error: aborted ? "AI request timed out." : error instanceof Error ? error.message : "Unknown error",
    });
  }
}
