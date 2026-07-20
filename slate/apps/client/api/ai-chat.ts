/**
 * Vercel Serverless Function — AI Chat (Z.AI)
 *
 * Calls Z.AI's HTTP API directly instead of going through z-ai-web-dev-sdk.
 * The SDK's `ZAI.create()` takes NO arguments and ALWAYS reads a `.z-ai-config`
 * file from cwd / home / /etc — it ignores any config object passed to it. That
 * file doesn't exist on Vercel, so every request failed with "Configuration
 * file not found or invalid", no matter how the env vars were set.
 *
 * This handler reproduces the exact request the SDK makes (same URL, headers,
 * and body — see z-ai-web-dev-sdk/dist/index.js `createChatCompletion`), driven
 * entirely by env vars, so there is no config file to find.
 *
 * Vercel Environment Variables (Project Settings → Environment Variables):
 *   ZAI_BASE_URL  (required) e.g. "https://internal-api.z.ai/v1"
 *   ZAI_API_KEY   (required) bearer value from your .z-ai-config (e.g. "Z.ai")
 *   ZAI_TOKEN     (usually required) JWT from .z-ai-config — sent as X-Token
 *   ZAI_USER_ID   (optional) sent as X-User-Id
 *   ZAI_CHAT_ID   (optional) sent as X-Chat-Id
 *   ZAI_MODEL     (optional) only sent when set (the SDK omits model by default)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

// Allow the function to run up to 60s — building a multi-file app can take the
// model a while, and the default (10s) was cutting long generations off with a
// timeout. (Vercel caps this at the plan's max; 60s is the Hobby ceiling.)
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
    // Mode-specific instructions from the client (e.g. the code editor's
    // file-writing protocol) are appended verbatim to the system message.
    if (typeof instructions === "string" && instructions.trim()) {
      systemContent += `\n\n${instructions.trim()}`;
    }

    // Exact header set z-ai-web-dev-sdk sends (Authorization is the apiKey; the
    // JWT rides in X-Token; chat/user ids are optional routing headers).
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
    const timer = setTimeout(() => controller.abort(), 60_000);
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
      res
        .status(502)
        .json({ error: `AI provider error (${upstream.status}). ${detail.slice(0, 300)}`.trim() });
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
    const message = aborted
      ? "AI request timed out."
      : error instanceof Error
        ? error.message
        : "Unknown error";
    res.status(aborted ? 504 : 500).json({ error: message });
  }
}
