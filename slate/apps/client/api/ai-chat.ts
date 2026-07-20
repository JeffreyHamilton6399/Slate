/**
 * Vercel Serverless Function — AI Chat
 *
 * Lives in the Slate client's /api/ directory so Vercel detects it
 * when the project root is set to slate/apps/client.
 *
 * Uses z-ai-web-dev-sdk (server-side only).
 */

import ZAI from "z-ai-web-dev-sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (in case the Slate app is on a different domain)
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

    const zai = await ZAI.create();

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
