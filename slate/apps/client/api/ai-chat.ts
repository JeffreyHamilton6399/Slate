/**
 * Vercel Serverless Function — AI Chat
 *
 * Uses z-ai-web-dev-sdk. The SDK normally reads /etc/.z-ai-config or
 * ~/.z-ai-config, but on Vercel those don't exist. We pass the config
 * explicitly via ZAI.create({ baseUrl, apiKey, token }) using env vars
 * set in the Vercel project settings.
 *
 * Required Vercel env vars:
 *   ZAI_BASE_URL  — e.g. "https://internal-api.z.ai/v1"
 *   ZAI_API_KEY   — e.g. "Z.ai"
 *   ZAI_TOKEN     — the JWT token from .z-ai-config
 *   ZAI_USER_ID   — user id from .z-ai-config
 *   ZAI_CHAT_ID   — chat id from .z-ai-config
 */

import ZAI from "z-ai-web-dev-sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

let cachedZai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getZai() {
  if (cachedZai) return cachedZai;

  // On Vercel, read config from env vars (set in Project Settings → Environment Variables)
  const baseUrl = process.env.ZAI_BASE_URL;
  const apiKey = process.env.ZAI_API_KEY;
  const token = process.env.ZAI_TOKEN;
  const userId = process.env.ZAI_USER_ID;
  const chatId = process.env.ZAI_CHAT_ID;

  if (baseUrl && apiKey && token) {
    // Pass config explicitly — bypasses the file lookup
    cachedZai = await ZAI.create({
      baseUrl,
      apiKey,
      token,
      userId: userId || undefined,
      chatId: chatId || undefined,
    });
  } else {
    // Fallback: let the SDK find /etc/.z-ai-config (works locally, not on Vercel)
    cachedZai = await ZAI.create();
  }
  return cachedZai;
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

  try {
    const { messages, context } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Messages array is required" });
      return;
    }

    const zai = await getZai();

    const systemContent = context
      ? `You are Slate AI, a helpful assistant integrated into the Slate collaborative editor. You help with writing, coding, brainstorming, and creative work. Here is the user's current document/code context:\n\n---\n${context}\n---\n\nUse this context to give relevant, specific answers. If the context is empty, just help generally.`
      : "You are Slate AI, a helpful assistant integrated into the Slate collaborative editor. You help with writing, coding, brainstorming, and creative work. Be concise and helpful.";

    const allMessages = [
      { role: "assistant", content: systemContent },
      ...messages,
    ];

    const completion = await zai.chat.completions.create({
      messages: allMessages,
      thinking: { type: "disabled" },
    });

    const reply = completion.choices?.[0]?.message?.content;

    if (!reply || reply.trim().length === 0) {
      res.status(500).json({ error: "Empty response from AI" });
      return;
    }

    res.status(200).json({ reply });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}
