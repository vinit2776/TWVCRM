import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { listAllUsersFromDevice } from "@/lib/cosec";

/**
 * GET /api/cosec/enrollments
 *
 * Returns all non-deleted cosec_access_users records across all devices,
 * enriched with entity name, device label, and a `is_legacy` flag.
 *
 * Legacy = enrollment still active (not blocked/deleted) but the underlying
 * contract/booking has expired or been terminated.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const today = new Date().toISOString();

  // ── 1. Fetch all active enrollments with device info ──────────────────────
  const { data: rows, error } = await admin
    .from("cosec_access_users")
    .select(`
      id, device_id, cosec_user_id, cosec_ref_id,
      user_type, entity_id, enrollment_status,
      access_pin, nfc_card_number, valid_until,
      provisioned_at, biometric_enrolled_at, card_enrolled_at, blocked_at,
      device:cosec_devices(id, label, device_category, location:locations(name))
    `)
    .neq("enrollment_status", "deleted")
    .order("provisioned_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const allRows = rows ?? [];

  // ── 2. Group entity IDs by type for batch fetching ────────────────────────
  const byType: Record<string, string[]> = {
    contract: [], employee: [], booking: [], member: [],
  };
  for (const r of allRows) {
    if (r.user_type in byType) byType[r.user_type].push(r.entity_id);
  }

  // ── 3. Batch fetch entity records ─────────────────────────────────────────
  const [contracts, employees, bookings, members] = await Promise.all([
    byType.contract.length
      ? admin.from("contracts")
          .select("id, contract_number, status, end_date, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)")
          .in("id", byType.contract)
      : { data: [] },
    byType.employee.length
      ? admin.from("employees").select("id, full_name").in("id", byType.employee)
      : { data: [] },
    byType.booking.length
      ? admin.from("bookings").select("id, booking_number, guest_name, end_time").in("id", byType.booking)
      : { data: [] },
    byType.member.length
      ? admin.from("contract_members")
          .select("id, name, contract_id, contract:contracts(id, contract_number, status, end_date)")
          .in("id", byType.member)
      : { data: [] },
  ]);

  // ── 4. Build lookup maps ──────────────────────────────────────────────────
  type EntityMeta = {
    name: string;
    contractId?: string;          // UUID — used for direct /contracts/:id links
    contractNumber?: string;
    contractStatus?: string;
    endDate?: string | null;      // ISO date string
    endTime?: string | null;      // ISO datetime string (bookings)
    isEmployee?: boolean;
  };

  const entityMap = new Map<string, EntityMeta>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (contracts.data ?? []).forEach((c: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = Array.isArray(c.lead) ? c.lead[0] : (c.lead as any);
    const name = lead?.company
      || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim()
      || c.contract_number;
    entityMap.set(c.id, {
      name,
      contractId: c.id,
      contractNumber: c.contract_number,
      contractStatus: c.status,
      endDate: c.end_date,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (employees.data ?? []).forEach((e: any) => {
    entityMap.set(e.id, { name: e.full_name, isEmployee: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bookings.data ?? []).forEach((b: any) => {
    entityMap.set(b.id, {
      name: b.guest_name || `Booking #${b.booking_number}`,
      contractNumber: b.booking_number,
      endTime: b.end_time,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (members.data ?? []).forEach((m: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = Array.isArray(m.contract) ? m.contract[0] : (m.contract as any);
    entityMap.set(m.id, {
      name: m.name,
      contractId: contract?.id,
      contractNumber: contract?.contract_number,
      contractStatus: contract?.status,
      endDate: contract?.end_date,
    });
  });

  // ── 5. Compute legacy flag and enrich each row ───────────────────────────
  const TERMINATED_STATUSES = new Set(["terminated", "cancelled", "expired"]);
  const ACTIVE_ENROLLMENT_STATUSES = new Set([
    "pending", "provisioned", "biometric_enrolled", "card_enrolled", "fully_enrolled",
  ]);

  const enriched = allRows.map(r => {
    const meta = entityMap.get(r.entity_id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const device = r.device as any;

    let isLegacy = false;
    let legacyReason = "";

    if (ACTIVE_ENROLLMENT_STATUSES.has(r.enrollment_status)) {
      if (r.user_type === "contract" || r.user_type === "member") {
        if (meta?.contractStatus && TERMINATED_STATUSES.has(meta.contractStatus)) {
          isLegacy = true;
          legacyReason = `Contract ${meta.contractStatus}`;
        } else if (meta?.endDate && meta.endDate < today.split("T")[0]) {
          isLegacy = true;
          legacyReason = `Contract ended ${meta.endDate}`;
        }
      } else if (r.user_type === "booking") {
        if (meta?.endTime && meta.endTime < today) {
          isLegacy = true;
          legacyReason = `Booking ended ${meta.endTime}`;
        }
      }
      // Employees are never auto-legacy (permanent staff)
    }

    return {
      id: r.id,
      device_id: r.device_id,
      device_label: device?.label ?? "Unknown",
      device_category: device?.device_category ?? "entry_point",
      location_name: device?.location?.name ?? "",
      cosec_user_id: r.cosec_user_id,
      cosec_ref_id: r.cosec_ref_id,
      user_type: r.user_type,
      entity_id: r.entity_id,
      entity_name: meta?.name ?? r.cosec_user_id,
      contract_id: meta?.contractId,
      contract_number: meta?.contractNumber,
      contract_status: meta?.contractStatus,
      end_date: meta?.endDate ?? meta?.endTime,
      enrollment_status: r.enrollment_status,
      access_pin: r.access_pin,
      nfc_card_number: r.nfc_card_number,
      valid_until: r.valid_until,
      provisioned_at: r.provisioned_at,
      biometric_enrolled_at: r.biometric_enrolled_at,
      card_enrolled_at: r.card_enrolled_at,
      blocked_at: r.blocked_at,
      is_legacy: isLegacy,
      legacy_reason: legacyReason,
    };
  });

  // Sort: legacy first, then blocked, then by provisioned date desc
  enriched.sort((a, b) => {
    if (a.is_legacy !== b.is_legacy) return a.is_legacy ? -1 : 1;
    const aBlocked = a.enrollment_status === "blocked" ? 1 : 0;
    const bBlocked = b.enrollment_status === "blocked" ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    return (b.provisioned_at ?? "").localeCompare(a.provisioned_at ?? "");
  });

  const legacyCount = enriched.filter(e => e.is_legacy).length;
  const byTypeCount: Record<string, number> = {};
  for (const e of enriched) {
    byTypeCount[e.user_type] = (byTypeCount[e.user_type] ?? 0) + 1;
  }

  // ── 6. Fetch live device users — find unlinked (enrolled on device but not in DB) ─
  type UnlinkedDeviceUser = {
    device_id: string;
    device_label: string;
    device_category: string;
    location_name: string;
    cosec_user_id: string;
    cosec_ref_id: number;
    name: string;
    is_active: boolean;
    finger_count: number;
    card_number: string | null;
  };

  const unlinked: UnlinkedDeviceUser[] = [];
  const knownCosecIds = new Set(allRows.map(r => r.cosec_user_id));

  const { data: devices } = await admin
    .from("cosec_devices")
    .select("id, label, device_ip, device_port, device_password, device_category, location:locations(name)");

  if (devices && devices.length > 0) {
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
            if (!knownCosecIds.has(lu.userId)) {
              unlinked.push({
                device_id: device.id,
                device_label: device.label,
                device_category: device.device_category ?? "entry_point",
                location_name: loc?.name ?? "",
                cosec_user_id: lu.userId,
                cosec_ref_id: lu.refUserId,
                name: lu.name,
                is_active: lu.isActive,
                finger_count: lu.fingerCount,
                card_number: lu.cardNumber || null,
              });
            }
          }
        } catch {
          // Device offline or unreachable — skip silently, don't fail the whole request
        }
      })
    );
  }

  // Sort unlinked by device label then name
  unlinked.sort((a, b) =>
    a.device_label.localeCompare(b.device_label) || a.name.localeCompare(b.name)
  );

  return NextResponse.json({
    data: enriched,
    unlinked,
    meta: {
      total: enriched.length,
      legacy: legacyCount,
      byType: byTypeCount,
      unlinked_count: unlinked.length,
    },
  });
}
