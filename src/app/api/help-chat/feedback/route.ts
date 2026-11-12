import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const requestSchema = z.object({
  interactionId: z.string().uuid(),
  feedback: z.enum(["helpful", "not_helpful"]),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // RLS scopes the update to rows owned by this user (see the 00549
  // migration's "own help_chat_interactions" policy) — a mismatched or
  // someone-else's interactionId simply matches zero rows rather than
  // erroring, so that's treated as a 404 rather than trusted as a 200.
  const { data, error } = await supabase
    .from("help_chat_interactions")
    .update({ feedback: parsed.data.feedback })
    .eq("id", parsed.data.interactionId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[help-chat/feedback]", error.message);
    return NextResponse.json({ error: "Couldn't save feedback" }, { status: 502 });
  }
  if (!data) {
    return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
