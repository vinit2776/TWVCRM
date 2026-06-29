import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { listAllUsersFromDevice } from "@/lib/cosec";

/**
 * GET /api/cosec/pin-audit
 *
 * Polls every COSEC device and returns all users that currently have an
 * active PIN set on the device, enriched with their CRM name and entity type.
 * Used to identify PINs that exist on the device but may have no CRM record
 * (legacy/orphaned) or are tied to expired entities.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: devices } = await admin
    .from("cosec_devices")
    .select("id, label, device_ip, device_port, device_password, location:locations(name)");

  if (!devices || devices.length === 0) {
    return NextResponse.json({ data: [] });
  }

  // Fetch all CRM enrollments so we can cross-reference by cosec_user_id
  const { data: crmRows } = await admin
    .from("cosec_access_users")
    .select("cosec_user_id, user_type, entity_id, enrollment_status, pin_issued_at")
    .neq("enrollment_status", "deleted");

  const crmMap = new Map((crmRows ?? []).map(r => [r.cosec_user_id, r]));

  // Collect entity IDs by type for name resolution
  const byType: Record<string, string[]> = { contract: [], member: [], employee: [], booking: [] };
  for (const r of crmRows ?? []) {
    if (r.user_type in byType) byType[r.user_type].push(r.entity_id);
  }

  const [contracts, employees, bookings, members] = await Promise.all([
    byType.contract.length
      ? admin.from("contracts")
          .select("id, contract_number, status, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)")
          .in("id", byType.contract)
      : { data: [] },
    byType.employee.length
      ? admin.from("employees").select("id, full_name").in("id", byType.employee)
      : { data: [] },
    byType.booking.length
      ? admin.from("bookings").select("id, booking_number, guest_name, status").in("id", byType.booking)
      : { data: [] },
    byType.member.length
      ? admin.from("contract_members")
          .select("id, name, contract:contracts(contract_number, status)")
          .in("id", byType.member)
      : { data: [] },
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entityMap = new Map<string, { name: string; ref: string; status?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (contracts.data ?? []).forEach((c: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = Array.isArray(c.lead) ? c.lead[0] : (c.lead as any);
    entityMap.set(c.id, {
      name: lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number,
      ref: c.contract_number,
      status: c.status,
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (employees.data ?? []).forEach((e: any) => entityMap.set(e.id, { name: e.full_name, ref: "Employee" }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bookings.data ?? []).forEach((b: any) => entityMap.set(b.id, { name: b.guest_name || `Booking #${b.booking_number}`, ref: `#${b.booking_number}`, status: b.status }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (members.data ?? []).forEach((m: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = Array.isArray(m.contract) ? m.contract[0] : (m.contract as any);
    entityMap.set(m.id, { name: m.name, ref: contract?.contract_number, status: contract?.status });
  });

  // Poll each device for users with PINs
  type PinAuditRow = {
    device_id: string;
    device_label: string;
    location_name: string;
    cosec_user_id: string;
    device_name: string;       // name stored on device
    is_active: boolean;
    crm_name: string | null;   // name from CRM entity
    crm_ref: string | null;
    crm_type: string | null;
    crm_status: string | null;
    enrollment_status: string | null;
    pin_issued_at: string | null;
    is_unlinked: boolean;      // true = no CRM record at all
  };

  const results: PinAuditRow[] = [];

  await Promise.allSettled(
    devices.map(async (device) => {
      try {
        const liveUsers = await listAllUsersFromDevice({
          ip: device.device_ip,
          port: device.device_port,
          password: device.device_password,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loc = Array.isArray(device.location) ? device.location[0] : (device.location as any);

        for (const lu of liveUsers) {
          if (!lu.hasPin) continue; // skip users with no PIN

          const crm = crmMap.get(lu.userId);
          const entity = crm ? entityMap.get(crm.entity_id) : null;

          results.push({
            device_id: device.id,
            device_label: device.label,
            location_name: loc?.name ?? "",
            cosec_user_id: lu.userId,
            device_name: lu.name,
            is_active: lu.isActive,
            crm_name: entity?.name ?? null,
            crm_ref: entity?.ref ?? null,
            crm_type: crm?.user_type ?? null,
            crm_status: entity?.status ?? null,
            enrollment_status: crm?.enrollment_status ?? null,
            pin_issued_at: crm?.pin_issued_at ?? null,
            is_unlinked: !crm,
          });
        }
      } catch {
        // device offline — skip
      }
    })
  );

  results.sort((a, b) => {
    if (a.is_unlinked !== b.is_unlinked) return a.is_unlinked ? 1 : -1;
    return a.device_label.localeCompare(b.device_label) || a.device_name.localeCompare(b.device_name);
  });

  return NextResponse.json({ data: results, total: results.length });
}
