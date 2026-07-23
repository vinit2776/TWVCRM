import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { CHARGE_ALLOWED_ROLES } from "@/lib/constants";

// Overridable via env so the model can be bumped without a redeploy for this
// one call site — mirrors the pattern in src/lib/email-parser.ts.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MODEL = process.env.ANTHROPIC_CHARGE_DESCRIPTION_MODEL || DEFAULT_MODEL;

const REQUEST_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `You rewrite rough, informal notes from coworking-space floor managers into a single clear, professional line-item description suitable for appearing directly on a customer's invoice.

Rules:
- Output ONLY the rewritten description — no quotes, no preamble, no explanation.
- Keep it factual and specific to what was written. Never invent details (amounts, dates, item counts) that weren't in the input.
- Maximum 12 words.
- Neutral, professional tone — no blame, no apology, no exclamation marks.
- If the input is already clear and professional, you may return it unchanged.`;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to use this" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const raw = typeof body?.raw === "string" ? body.raw.trim() : "";
  if (!raw) {
    return NextResponse.json({ error: "Nothing to improve" }, { status: 400 });
  }
  if (raw.length > 500) {
    return NextResponse.json({ error: "Description is too long" }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Wording suggestions aren't configured" }, { status: 503 });
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: raw }],
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
    );

    const suggestion = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (!suggestion) {
      return NextResponse.json({ error: "Couldn't generate a suggestion" }, { status: 502 });
    }

    return NextResponse.json({ suggestion });
  } catch (err) {
    console.error("[suggest-description]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't generate a suggestion" }, { status: 502 });
  }
}
