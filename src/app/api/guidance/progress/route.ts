import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isGuidanceKey } from "@/lib/vo-renewal-learning";

/**
 * The signed-in person's progress through the in-app renewal guidance.
 *
 * GET  — every row of their own (RLS lets them read nothing else).
 * POST — count a completion or note a blocked attempt on one step. Written
 *        through record_guidance_event(), which only the service role can call,
 *        so a person can only ever move their own counters.
 *
 * Holds no customer data and never changes what a step does.
 */

async function currentUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: null };
  const { data } = await supabase.from("users").select("id").eq("auth_id", user.id).maybeSingle();
  return { supabase, userId: (data?.id as string | undefined) ?? null };
}

export async function GET() {
  const { supabase, userId } = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_guidance_progress")
    .select("step_key, times_completed, last_completed_at, last_blocked_at")
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const progress: Record<string, { times_completed: number; last_completed_at: string | null; last_blocked_at: string | null }> = {};
  for (const r of data ?? []) {
    progress[r.step_key as string] = {
      times_completed: r.times_completed as number,
      last_completed_at: (r.last_completed_at as string | null) ?? null,
      last_blocked_at: (r.last_blocked_at as string | null) ?? null,
    };
  }
  return NextResponse.json({ data: progress });
}

const bodySchema = z.object({
  step_key: z.string().refine(isGuidanceKey, "Unknown guidance step"),
  event: z.enum(["completed", "blocked"]),
});

export async function POST(request: NextRequest) {
  const { userId } = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const admin = await createAdminClient();
  const { error } = await admin.rpc("record_guidance_event", {
    p_user_id: userId,
    p_step_key: parsed.data.step_key,
    p_event: parsed.data.event,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
