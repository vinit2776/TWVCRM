import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { setUserPin } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { dltSms } from "@/lib/whatsapp";
import { z } from "zod";

const schema = z.object({
  access_user_id: z.string().uuid(),
});

/**
 * POST /api/cosec/generate-pin
 *
 * Generates a fresh 4-digit PIN for a provisioned cosec_access_users row,
 * pushes it to the device, stores it in access_pin, and SMSs it to the
 * user's phone number. Intended as a card-fallback: user forgot card →
 * reception hits this → user can enter with PIN instead.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

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
  if (accessUser.enrollment_status === "blocked") {
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

  // Persist the new PIN
  await admin
    .from("cosec_access_users")
    .update({ access_pin: pin, updated_at: new Date().toISOString() })
    .eq("id", parsed.data.access_user_id);

  // Resolve entity name + phone for SMS
  const { name, phone } = await resolveEntityContact(admin, accessUser.user_type, accessUser.entity_id);

  // SMS the PIN (fire-and-forget)
  if (phone) {
    dltSms.otp(phone, pin, parsed.data.access_user_id).catch(() => null);
  }

  logAudit(admin, {
    entityType: accessUser.user_type,
    entityId: accessUser.entity_id,
    action: "update",
    performedBy: user.id,
    changes: { access_pin_generated: { old: null, new: "****" } },
  });

  return NextResponse.json({ ok: true, pin, name, sms_sent: !!phone });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function resolveEntityContact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  userType: string,
  entityId: string
): Promise<{ name: string; phone: string | null }> {
  try {
    if (userType === "employee") {
      const { data } = await admin
        .from("employees")
        .select("full_name, phone")
        .eq("id", entityId)
        .single();
      return { name: data?.full_name ?? "Employee", phone: data?.phone ?? null };
    }

    if (userType === "member") {
      const { data } = await admin
        .from("contract_members")
        .select("name, phone")
        .eq("id", entityId)
        .single();
      return { name: data?.name ?? "Member", phone: data?.phone ?? null };
    }

    if (userType === "contract") {
      const { data } = await admin
        .from("contracts")
        .select("lead:leads!contracts_lead_id_fkey(first_name, last_name, company, phone, mobile)")
        .eq("id", entityId)
        .single();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = data?.lead as any;
      const name = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "Client";
      const phone = lead?.mobile || lead?.phone || null;
      return { name, phone };
    }

    if (userType === "booking") {
      const { data } = await admin
        .from("bookings")
        .select("guest_name, guest_phone, booker_phone")
        .eq("id", entityId)
        .single();
      return {
        name: data?.guest_name ?? "Guest",
        phone: data?.guest_phone || data?.booker_phone || null,
      };
    }
  } catch {
    // non-fatal — PIN is already pushed to device
  }

  return { name: "User", phone: null };
}
