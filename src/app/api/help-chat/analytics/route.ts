import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { HELP_CONTENT } from "@/lib/help-content";
import { summarizeHelpChatInteractions, type HelpChatInteractionRow } from "@/lib/help/help-chat-analytics";

const ALLOWED_DAYS = [7, 14, 30, 90];
const DEFAULT_DAYS = 30;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "You do not have permission to view this" }, { status: 403 });
  }

  const requestedDays = parseInt(request.nextUrl.searchParams.get("days") ?? "", 10);
  const days = ALLOWED_DAYS.includes(requestedDays) ? requestedDays : DEFAULT_DAYS;

  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: rows, error } = await supabase
    .from("help_chat_interactions")
    .select("user_id, role, page_path, had_match, section_ids, feedback, created_at")
    .gte("created_at", since.toISOString());

  if (error) {
    console.error("[help-chat/analytics]", error.message);
    return NextResponse.json({ error: "Couldn't load analytics" }, { status: 502 });
  }

  const summary = summarizeHelpChatInteractions(
    (rows ?? []) as HelpChatInteractionRow[],
    HELP_CONTENT.sections,
    { days }
  );

  return NextResponse.json({ days, ...summary });
}
