import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { CHARGE_ALLOWED_ROLES } from "@/lib/constants";

// Advisory only — never blocks submission. Mirrors the model/env-var
// convention in src/app/api/usage-charges/suggest-description/route.ts.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MODEL = process.env.ANTHROPIC_CHARGE_DESCRIPTION_MODEL || DEFAULT_MODEL;

const REQUEST_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `You review short internal accounting notes written by coworking-space staff when creating an ad-hoc invoice or a security deposit request/collection. These notes are read only by the accounts team — never by the customer — and exist so accounts can book the money to the correct ledger head and understand why it exists.

Judge whether the note clearly explains WHY this charge/deposit exists and gives enough context to book it correctly (e.g. references the accounting head, the reason, or specific context — not just a restatement of the amount or a generic filler word like "misc", "n/a", "asdf", "test").

Respond with ONLY a JSON object, no other text: {"ok": boolean, "reason": string}
- "ok": true if the note gives real, specific context an accountant could act on.
- "reason": if ok is false, a single short sentence (under 15 words) on what's missing. If ok is true, an empty string.`;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to use this" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  const accountingHead = typeof body?.accounting_head === "string" ? body.accounting_head.trim() : "";
  const context = typeof body?.context === "string" ? body.context.trim() : "";

  if (!note) {
    return NextResponse.json({ error: "Nothing to check" }, { status: 400 });
  }
  if (note.length > 1000) {
    return NextResponse.json({ error: "Note is too long" }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Note checking isn't configured" }, { status: 503 });
  }

  const userMessage = [
    accountingHead ? `Accounting head: ${accountingHead}` : null,
    context ? `Context: ${context}` : null,
    `Note: ${note}`,
  ].filter(Boolean).join("\n");

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
    );

    const raw = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    const parsed = JSON.parse(raw) as { ok?: boolean; reason?: string };
    if (typeof parsed.ok !== "boolean") {
      return NextResponse.json({ error: "Couldn't check the note" }, { status: 502 });
    }

    return NextResponse.json({ ok: parsed.ok, reason: parsed.reason || "" });
  } catch (err) {
    console.error("[validate-internal-note]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't check the note" }, { status: 502 });
  }
}
