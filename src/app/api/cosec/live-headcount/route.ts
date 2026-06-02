import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/cosec/live-headcount
 *
 * Returns all entities currently inside (cosec_presence.is_inside = true),
 * enriched with phone numbers and grouped by location.
 *
 * Query params:
 *   location_id = uuid   (optional — filter to one location)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = request.nextUrl.searchParams.get("location_id");

  const admin = createAdminClient();

  // Fetch everyone currently inside, with device + location info
  let query = admin
    .from("cosec_presence")
    .select("entity_id, entity_name, user_type, last_entry_at, device:cosec_devices(id, label, location_id, location:locations(id, name))")
    .eq("is_inside", true)
    .order("last_entry_at", { ascending: false });

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let presence = (rows ?? []) as any[];

  // Filter by location if requested
  if (locationId) {
    presence = presence.filter(r => r.device?.location_id === locationId);
  }

  if (presence.length === 0) {
    return NextResponse.json({ data: [], total: 0 });
  }

  // Group by user_type for batch phone lookups
  const byType = new Map<string, string[]>();
  for (const r of presence) {
    if (!r.entity_id || !r.user_type) continue;
    if (!byType.has(r.user_type)) byType.set(r.user_type, []);
    byType.get(r.user_type)!.push(r.entity_id);
  }

  const phones = new Map<string, string>();
  const tasks: Promise<void>[] = [];

  if (byType.has("contract")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("contracts")
        .select("id, lead:leads!contracts_lead_id_fkey(phone)")
        .in("id", byType.get("contract")!);
      for (const c of data ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const phone = (Array.isArray(c.lead) ? c.lead[0] : c.lead as any)?.phone;
        if (phone) phones.set(c.id, phone);
      }
    })());
  }

  if (byType.has("employee")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("employees")
        .select("id, phone, department, designation")
        .in("id", byType.get("employee")!);
      for (const e of data ?? []) {
        if (e.phone) phones.set(e.id, e.phone);
        // Stash extra fields for enrichment below
        if (!phones.has(`meta_${e.id}`)) {
          phones.set(`dept_${e.id}`, e.department ?? "");
          phones.set(`desig_${e.id}`, e.designation ?? "");
        }
      }
    })());
  }

  if (byType.has("booking")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("bookings")
        .select("id, guest_phone, booking_number")
        .in("id", byType.get("booking")!);
      for (const b of data ?? []) {
        if (b.guest_phone) phones.set(b.id, b.guest_phone);
      }
    })());
  }

  if (byType.has("member")) {
    tasks.push((async () => {
      const { data } = await admin
        .from("contract_members")
        .select("id, phone")
        .in("id", byType.get("member")!);
      for (const m of data ?? []) {
        if (m.phone) phones.set(m.id, m.phone);
      }
    })());
  }

  await Promise.all(tasks);

  const enriched = presence.map(r => ({
    entity_id:    r.entity_id,
    entity_name:  r.entity_name,
    user_type:    r.user_type,
    phone:        r.entity_id ? (phones.get(r.entity_id) ?? null) : null,
    department:   r.user_type === "employee" ? (phones.get(`dept_${r.entity_id}`) || null) : null,
    designation:  r.user_type === "employee" ? (phones.get(`desig_${r.entity_id}`) || null) : null,
    last_entry_at: r.last_entry_at,
    location_id:  r.device?.location_id ?? null,
    location_name: r.device?.location?.name ?? null,
    device_label: r.device?.label ?? null,
  }));

  return NextResponse.json({ data: enriched, total: enriched.length });
}
