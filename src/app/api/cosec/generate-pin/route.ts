import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { setUserPin } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { sendDoorPinEmail, doorPinEmailProblem, type DoorPinRecord } from "@/lib/door-pin-email";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const schema = z.object({
  access_user_id: z.string().uuid(),
});

/**
 * POST /api/cosec/generate-pin
 *
 * Generates a fresh 4-digit PIN for a provisioned cosec_access_users row,
 * pushes it to the device, stores it in access_pin, and emails it to the
 * user (not SMS: the only registered SMS template that carried a bare number is the
 * OTP one, which misled recipients — see src/lib/door-pin-email.ts). Intended as a card-fallback: user forgot card →
 * reception hits this → user can enter with PIN instead.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const admin = createAdminClient();

  const { data: accessUser, error: auErr } = await admin
    .from("cosec_access_users")
    .select("*, device:cosec_devices(device_ip, device_port, device_password)")
    .eq("id", parsed.data.access_user_id)
    .single();

  if (auErr || !accessUser) {
    return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
  }
  if (accessUser.enrollment_status === "pending") {
    return NextResponse.json({ error: "User is not yet provisioned on the device" }, { status: 422 });
  }
  if (accessUser.enrollment_status === "blocked" || accessUser.enrollment_status === "deleted") {
    return NextResponse.json({ error: "User is blocked — restore access first" }, { status: 422 });
  }

  // Generate a random 4-digit PIN (1000–9999, no leading zero)
  const pin = String(Math.floor(1000 + Math.random() * 9000));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dev = accessUser.device as any;
  const device = { ip: dev.device_ip, port: dev.device_port, password: dev.device_password };

  try {
    await setUserPin(device, accessUser.cosec_user_id, pin);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Device PIN update failed" },
      { status: 422 }
    );
  }

  // Persist the new PIN and record when it was issued.
  // pin_issued_at requires migration 00309 — attempt it and fall back gracefully.
  const now = new Date().toISOString();
  const { error: updateErr } = await admin
    .from("cosec_access_users")
    .update({ access_pin: pin, pin_issued_at: now, updated_at: now })
    .eq("id", parsed.data.access_user_id);

  if (updateErr) {
    // Column may not exist yet — retry without pin_issued_at
    await admin
      .from("cosec_access_users")
      .update({ access_pin: pin, updated_at: now })
      .eq("id", parsed.data.access_user_id);
  }

  // Resolve entity name + email for the PIN email
  const { name, email } = await resolveEntityContact(admin, accessUser.user_type, accessUser.entity_id);
  // Members are recorded against their contract so the People screen shows who issued it.
  let record: DoorPinRecord | undefined;
  if (accessUser.user_type === "member") {
    const [{ data: m }, { data: dbUser }] = await Promise.all([
      admin.from("contract_members").select("contract_id").eq("id", accessUser.entity_id).maybeSingle(),
      supabase.from("users").select("id").eq("auth_id", user.id).single(),
    ]);
    if (m?.contract_id) {
      record = { admin, contractId: m.contract_id, memberId: accessUser.entity_id, performedBy: dbUser?.id ?? null, validUntil: accessUser.valid_until ?? null };
    }
  }
  const emailed = await sendDoorPinEmail({ to: email, name, pin, purpose: "fallback", record });

  logAudit(admin, {
    entityType: accessUser.user_type,
    entityId: accessUser.entity_id,
    action: "update",
    performedBy: user.id,
    changes: { access_pin_generated: { old: null, new: "****" } },
  });

  // Never return the PIN value — staff only see the issued timestamp
  return NextResponse.json({
    ok: true,
    name,
    email_sent: emailed.sent,
    // Set when the PIN is live on the device but nobody was told it; says what to fix.
    email_problem: emailed.sent ? null : doorPinEmailProblem(emailed.reason, name),
    pin_issued_at: now,
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function resolveEntityContact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  userType: string,
  entityId: string
): Promise<{ name: string; email: string | null }> {
  try {
    if (userType === "employee") {
      const { data } = await admin
        .from("employees")
        .select("full_name, email")
        .eq("id", entityId)
        .single();
      return { name: data?.full_name ?? "Employee", email: data?.email ?? null };
    }

    if (userType === "member") {
      const { data } = await admin
        .from("contract_members")
        .select("name, email")
        .eq("id", entityId)
        .single();
      return { name: data?.name ?? "Member", email: data?.email ?? null };
    }

    if (userType === "contract") {
      const { data } = await admin
        .from("contracts")
        .select("lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email)")
        .eq("id", entityId)
        .single();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = data?.lead as any;
      const name = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "Client";
      return { name, email: lead?.email || null };
    }

    if (userType === "booking") {
      const { data } = await admin
        .from("bookings")
        .select("guest_name, guest_email, booker_email")
        .eq("id", entityId)
        .single();
      return {
        name: data?.guest_name ?? "Guest",
        email: data?.guest_email || data?.booker_email || null,
      };
    }
  } catch {
    // non-fatal — PIN is already pushed to device
  }

  return { name: "User", email: null };
}
