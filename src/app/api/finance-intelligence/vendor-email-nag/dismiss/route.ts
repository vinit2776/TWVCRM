import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { recordDismissal } from "@/lib/finance-intelligence";
import { z } from "zod";

const schema = z.object({ vendor_id: z.string().uuid() });

/**
 * POST /api/finance-intelligence/vendor-email-nag/dismiss
 *
 * Records a 'dismissed' event. The banner won't reappear for this
 * vendor + user combination until the snooze window expires.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  await recordDismissal(supabase, parsed.data.vendor_id, dbUser.id);
  return NextResponse.json({ ok: true });
}
