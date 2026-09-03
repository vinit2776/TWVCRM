import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { HELP_CONTENT } from "@/lib/help-content";
import { filterSectionsForRole } from "@/lib/help/role-filter";
import { getTopMatches } from "@/lib/help/help-search";
import { buildHelpChatSystemPrompt } from "@/lib/help/help-chat-prompt";

// Overridable via env so the model can be bumped without a redeploy for this
// one call site — mirrors the pattern in src/lib/email-parser.ts and the
// other Anthropic call sites (validate-internal-note, suggest-description).
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MODEL = process.env.ANTHROPIC_HELP_CHAT_MODEL || DEFAULT_MODEL;

const REQUEST_TIMEOUT_MS = 10_000;
const DAILY_QUESTION_LIMIT = 40;
const MAX_MATCHED_SECTIONS = 4;

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(2000),
});

const requestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Ask something first")
    .max(500, "That's a bit long — try asking in fewer words"),
  // Prior turns of THIS conversation, alternating user/assistant, oldest
  // first — the widget is the only writer and is responsible for keeping
  // them alternating correctly. Capped short since this is a Q&A assistant,
  // not a long-running chat.
  history: z.array(chatMessageSchema).max(6).optional().default([]),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid request" },
      { status: 400 }
    );
  }
  const { question, history } = parsed.data;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The assistant isn't configured yet" }, { status: 503 });
  }

  // Rate limit — checked (and incremented) before the model call, so a
  // blocked request never costs a token. Slight overcounting past the cap
  // on repeated blocked attempts is fine; only the count matters, not
  // precision at the boundary.
  const today = new Date().toISOString().slice(0, 10);
  const { data: usageCount, error: usageError } = await supabase.rpc("increment_help_chat_usage", {
    p_user_id: dbUser.id,
    p_day: today,
  });
  if (usageError) {
    console.error("[help-chat] usage increment failed", usageError.message);
    return NextResponse.json({ error: "Couldn't reach the assistant right now" }, { status: 502 });
  }
  if ((usageCount ?? 0) > DAILY_QUESTION_LIMIT) {
    return NextResponse.json(
      {
        error: `You've hit today's question limit (${DAILY_QUESTION_LIMIT}). Try again tomorrow, or reach ${HELP_CONTENT.supportInfo.email}.`,
      },
      { status: 429 }
    );
  }

  // Content the model is given is built entirely from sections that already
  // survived role-filtering — a restricted section's how-to detail is never
  // in this context to leak, regardless of how the question is phrased.
  const visibleSections = filterSectionsForRole(HELP_CONTENT.sections, dbUser.role);
  const matches = getTopMatches(visibleSections, question, MAX_MATCHED_SECTIONS);

  const systemPrompt = buildHelpChatSystemPrompt({
    roleLabel: USER_ROLE_LABELS[dbUser.role] || "team member",
    matches,
    globalFaqs: HELP_CONTENT.globalFaqs,
    rolePermissions: HELP_CONTENT.rolePermissions,
    supportEmail: HELP_CONTENT.supportInfo.email,
    supportPhone: HELP_CONTENT.supportInfo.phone,
  });

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [...history, { role: "user", content: question }],
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
    );

    const answer = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (!answer) {
      return NextResponse.json({ error: "Couldn't get an answer just now" }, { status: 502 });
    }

    return NextResponse.json({
      answer,
      sources: matches.map((m) => ({ sectionId: m.section.id, title: m.section.title })),
    });
  } catch (err) {
    console.error("[help-chat]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't get an answer just now" }, { status: 502 });
  }
}
