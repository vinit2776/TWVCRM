import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";

const schema = z.object({
  member_id: z.string().uuid(),
});

/**
 * POST /api/cosec/send-enrollment-pin
 * Resends the enrollment PIN for a contract member via SMS + WhatsApp.
 * Reads the PIN from cosec_access_users (same PIN on all devices for this member).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();

  const [{ data: member }, { data: accessUser }] = await Promise.all([
    admin.from("contract_members").select("name, phone").eq("id", parsed.data.member_id).single(),
    admin.from("cosec_access_users")
      .select("access_pin")
      .eq("entity_id", parsed.data.member_id)
      .eq("user_type", "member")
      .not("access_pin", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);

  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (!accessUser?.access_pin) return NextResponse.json({ error: "No enrollment PIN found — member may not be provisioned yet" }, { status: 404 });

  const pin = accessUser.access_pin;

  // Send PIN via SMS (fire-and-forget)
  const { dltSms } = await import("@/lib/whatsapp");
  dltSms.otp(member.phone, pin, parsed.data.member_id).catch(() => null);

  return NextResponse.json({ ok: true, pin });
}
