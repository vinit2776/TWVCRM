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

A note passes ONLY if a stranger on the accounts team, reading nothing else, could tell (a) the specific cause or trigger of this charge and (b) enough detail to pick the right ledger head without asking the creator a follow-up question. Merely naming the category of charge (which duplicates the accounting-head dropdown or the invoice title) is NOT enough — the note must add information beyond that category label.

Reject notes that are generic filler, a bare restatement of the accounting head/category, or a restatement of the amount, even if grammatically complete. Examples that must be rejected as too vague: "misc", "n/a", "asdf", "test", "extra charges", "additional charges", "other charges", "miscellaneous fee", "as discussed", "per agreement".

Examples that should pass: "Late checkout fee — customer used the meeting room 2 hrs past the booked slot on 12 Jan", "Recovering courier cost paid on customer's behalf for their signed agreement copy, ref DHL#4471", "Broken chair (asset #114) in Cabin 3, customer acknowledged in walkthrough on 5 Feb".

Respond with ONLY a JSON object, no other text: {"ok": boolean, "reason": string}
- "ok": true only if the note meets the bar above.
- "reason": if ok is false, a single short sentence (under 15 words) on what specific detail is missing. If ok is true, an empty string.`;

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
