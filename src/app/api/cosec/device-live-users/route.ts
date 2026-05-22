import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { listAllUsersFromDevice } from "@/lib/cosec";

/**
 * GET /api/cosec/device-live-users?device_id=<uuid>
 *
 * Queries the COSEC device directly for ALL enrolled users, then cross-references
 * with our cosec_access_users table to flag which ones are linked vs unrecognised.
 *
 * Returns each live user with:
 *   - is_linked: true if we have a cosec_access_user record matching cosec_user_id
 *   - entity_name / entity_type: populated when linked
 *   - finger_count, card_number, is_active: live data from device
 */
export async function GET(req: NextRequest) {
  const deviceId = req.nextUrl.searchParams.get("device_id");
  if (!deviceId) return NextResponse.json({ error: "device_id required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Fetch device credentials
  const { data: device, error: devErr } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password, label")
    .eq("id", deviceId)
    .single();

  if (devErr || !device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  // Query device directly
  let liveUsers;
  try {
    liveUsers = await listAllUsersFromDevice({
      ip: device.device_ip,
      port: device.device_port,
      password: device.device_password,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Device unreachable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  if (liveUsers.length === 0) {
    return NextResponse.json({ data: [], total: 0 });
  }

  // Fetch all our DB records for this device
  const { data: dbUsers } = await admin
    .from("cosec_access_users")
    .select("id, cosec_user_id, user_type, entity_id, enrollment_status")
    .eq("device_id", deviceId)
    .not("enrollment_status", "in", "(deleted)");

  // Build lookup by cosec_user_id
  const dbMap = new Map((dbUsers ?? []).map((u) => [u.cosec_user_id, u]));

  // Collect entity IDs by type for name enrichment
  const byType: Record<string, string[]> = { contract: [], member: [], employee: [], booking: [] };
  for (const u of dbUsers ?? []) {
    if (u.user_type in byType) byType[u.user_type].push(u.entity_id);
  }

  const [contracts, members, employees, bookings] = await Promise.all([
    byType.contract.length
      ? admin.from("contracts").select("id, contract_number, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)").in("id", byType.contract)
      : { data: [] },
    byType.member.length
      ? admin.from("contract_members").select("id, name").in("id", byType.member)
      : { data: [] },
    byType.employee.length
      ? admin.from("employees").select("id, full_name").in("id", byType.employee)
      : { data: [] },
    byType.booking.length
      ? admin.from("bookings").select("id, booking_number, guest_name").in("id", byType.booking)
      : { data: [] },
  ]);

  const nameMap: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (contracts.data ?? []).forEach((c: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = Array.isArray(c.lead) ? c.lead[0] : (c.lead as any);
    nameMap[c.id] = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (members.data ?? []).forEach((m: any) => { nameMap[m.id] = m.name; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (employees.data ?? []).forEach((e: any) => { nameMap[e.id] = e.full_name; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bookings.data ?? []).forEach((b: any) => { nameMap[b.id] = b.guest_name || `Booking #${b.booking_number}`; });

  const enriched = liveUsers.map((lu) => {
    const db = dbMap.get(lu.userId);
    return {
      user_id: lu.userId,
      ref_user_id: lu.refUserId,
      name: lu.name,
      is_active: lu.isActive,
      finger_count: lu.fingerCount,
      card_number: lu.cardNumber || null,
      is_linked: !!db,
      entity_name: db ? (nameMap[db.entity_id] ?? null) : null,
      entity_type: db?.user_type ?? null,
      enrollment_status: db?.enrollment_status ?? null,
      db_id: db?.id ?? null,
    };
  });

  return NextResponse.json({ data: enriched, total: enriched.length });
}
