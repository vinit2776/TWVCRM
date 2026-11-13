import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";
import { sendDoorPinEmail, doorPinEmailProblem } from "@/lib/door-pin-email";

const schema = z.object({
  member_id: z.string().uuid(),
});

/**
 * POST /api/cosec/send-enrollment-pin
 * Resends the enrollment PIN for a contract member by email.
 * Reads the PIN from cosec_access_users (same PIN on all devices for this member).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();

  const [{ data: member }, { data: accessRows }] = await Promise.all([
    admin.from("contract_members").select("name, email, contract_id").eq("id", parsed.data.member_id).single(),
    admin.from("cosec_access_users")
      .select("access_pin, valid_until, device:cosec_devices(supports_biometric)")
      .eq("entity_id", parsed.data.member_id)
      .eq("user_type", "member")
      .not("access_pin", "is", null),
  ]);

  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (accessRows ?? []) as any[];
  if (rows.length === 0) return NextResponse.json({ error: "No enrollment PIN found — member may not be provisioned yet" }, { status: 404 });
  // Fingerprint readers: the PIN starts fingerprint set-up. Card-only readers: it is the
  // way in until the member's card is issued. Same PIN either way, different wording.
  const onBiometricReader = rows.some((r) => r.device?.supports_biometric !== false);
  const accessUser = rows[0];

  const pin = accessUser.access_pin;

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  const emailed = await sendDoorPinEmail({
    to: member.email, name: member.name, pin, purpose: onBiometricReader ? "enrollment" : "fallback",
    record: { admin, contractId: member.contract_id, memberId: parsed.data.member_id, performedBy: dbUser?.id ?? null, validUntil: accessUser.valid_until ?? null },
  });
  if (!emailed.sent) {
    return NextResponse.json({ error: doorPinEmailProblem(emailed.reason, member.name) }, { status: emailed.reason === "no_email" ? 422 : 502 });
  }

  return NextResponse.json({ ok: true, email: member.email });
}
