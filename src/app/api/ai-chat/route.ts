import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

// CORS headers — allows the Slate SPA (deployed on a different domain) to
// call this API route. In production, set VITE_AI_CHAT_URL in the Slate
// project's Vercel env vars to point here.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const { messages, context } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages array is required" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const zai = await ZAI.create();

    // Build the system prompt with editor context if provided
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
      return NextResponse.json(
        { error: "Empty response from AI" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { reply },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
