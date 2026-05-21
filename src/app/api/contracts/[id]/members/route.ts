import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { provisionUser, memberCosecId, uuidToRefId, generatePin } from "@/lib/cosec";
import { z } from "zod";

const addSchema = z.object({
  name:  z.string().min(1).max(80),
  phone: z.string().min(10).max(20),
  email: z.string().email().optional().or(z.literal("")),
});

/** GET — list all active members for a contract with their COSEC status */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: members } = await admin
    .from("contract_members")
    .select("*")
    .eq("contract_id", id)
    .order("created_at");

  const { data: accessUsers } = await admin
    .from("cosec_access_users")
    .select("entity_id, device_id, enrollment_status, access_pin, nfc_card_number, provisioned_at, biometric_enrolled_at, card_enrolled_at, blocked_at, cosec_user_id, device:cosec_devices(label, location_id)")
    .eq("user_type", "member")
    .in("entity_id", (members ?? []).map(m => m.id));

  // Group access records by member id
  const accessByMember: Record<string, typeof accessUsers> = {};
  (accessUsers ?? []).forEach(au => {
    if (!accessByMember[au.entity_id]) accessByMember[au.entity_id] = [];
    accessByMember[au.entity_id]!.push(au);
  });

  const enriched = (members ?? []).map(m => ({
    ...m,
    access: accessByMember[m.id] ?? [],
  }));

  return NextResponse.json({ data: enriched });
}

/** POST — add a member, provision on all location devices, send enrollment SMS */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();

  // Load contract for seat-count guard and location + end_date
  const { data: contract } = await admin
    .from("contracts")
    .select("id, seats, location_id, end_date, status")
    .eq("id", contractId)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  // Seat count guard
  const { count } = await admin
    .from("contract_members")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", contractId)
    .eq("is_active", true);

  if ((count ?? 0) >= (contract.seats ?? 0)) {
    return NextResponse.json({ error: `All ${contract.seats} seats are already filled` }, { status: 409 });
  }

  // Create member
  const { data: member, error: memberErr } = await admin
    .from("contract_members")
    .insert({
      contract_id: contractId,
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email || null,
    })
    .select()
    .single();

  if (memberErr || !member) {
    return NextResponse.json({ error: memberErr?.message ?? "Failed to create member" }, { status: 500 });
  }

  // Provision on all COSEC devices at this location (fire-and-forget)
  if (contract.status === "active" && contract.location_id) {
    (async () => {
      try {
        const { data: devices } = await admin
          .from("cosec_devices")
          .select("id, device_ip, device_port, device_password")
          .eq("location_id", contract.location_id)
          .eq("is_enabled", true);

        if (!devices || devices.length === 0) return;

        const cosecUserId = memberCosecId(member.id);
        const cosecRefId  = uuidToRefId(member.id, 1, 49999);
        const pin         = generatePin();
        const validUntil  = contract.end_date ? new Date(contract.end_date) : undefined;
        const now         = new Date().toISOString();

        await Promise.allSettled(devices.map(async (dev) => {
          try {
            await provisionUser(
              { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
              {
                cosecUserId,
                cosecRefId,
                name: parsed.data.name.slice(0, 15),
                userActive: false,
                validUntil,
                pin,
                selfEnrollmentEnable: true,
              }
            );
            await admin.from("cosec_access_users").upsert({
              device_id:         dev.id,
              cosec_user_id:     cosecUserId,
              cosec_ref_id:      cosecRefId,
              user_type:         "member",
              entity_id:         member.id,
              enrollment_status: "provisioned",
              access_pin:        pin,
              valid_until:       contract.end_date ?? null,
              provisioned_at:    now,
              updated_at:        now,
            }, { onConflict: "device_id,cosec_user_id" });
          } catch (err) {
            console.error(`[members] provision failed on device ${dev.id}:`, err);
          }
        }));

        // Send enrollment PIN via WhatsApp + SMS
        const { dltSms } = await import("@/lib/whatsapp");
        dltSms.otp(parsed.data.phone, pin, member.id).catch(() => null);

      } catch (err) {
        console.error("[members] COSEC provision error:", err);
      }
    })();
  }

  return NextResponse.json({ data: member }, { status: 201 });
}

/** DELETE — deactivate member + block on all devices */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { member_id } = await request.json();
  if (!member_id) return NextResponse.json({ error: "member_id required" }, { status: 400 });

  const admin = createAdminClient();

  // Verify member belongs to this contract
  const { data: member } = await admin
    .from("contract_members")
    .select("id")
    .eq("id", member_id)
    .eq("contract_id", contractId)
    .single();
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Deactivate member
  await admin.from("contract_members").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", member_id);

  // Block on all devices (fire-and-forget)
  (async () => {
    try {
      const { setUserActive } = await import("@/lib/cosec");
      const { data: accessUsers } = await admin
        .from("cosec_access_users")
        .select("id, cosec_user_id, device:cosec_devices(device_ip, device_port, device_password)")
        .eq("entity_id", member_id)
        .eq("user_type", "member")
        .not("enrollment_status", "in", "(blocked,deleted)");

      const now = new Date().toISOString();
      await Promise.allSettled((accessUsers ?? []).map(async (au) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dev = au.device as any;
        if (!dev) return;
        try { await setUserActive({ ip: dev.device_ip, port: dev.device_port, password: dev.device_password }, au.cosec_user_id, false); } catch { /* non-fatal */ }
        await admin.from("cosec_access_users").update({ enrollment_status: "blocked", blocked_at: now, updated_at: now }).eq("id", au.id);
      }));
    } catch (err) {
      console.error("[members] block on remove failed:", err);
    }
  })();

  return NextResponse.json({ ok: true });
}
