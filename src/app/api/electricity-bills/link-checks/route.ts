import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { addDays } from "@/lib/energy-baseline";
import { continuityVerdict, fitVerdict, kwhBetween } from "@/lib/electricity-link";
import { loadMidnightReadings } from "@/lib/energy-midnights-server";

// Read-only. For billed dates and units, what OneGrid recorded at each tracked location of the
// bill's company over the same dates, and whether the opening reading follows on from the
// previous bill on the chosen connection. Advice only: nothing here is stored or applied, and
// the location is still the person's choice.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();

  const q = request.nextUrl.searchParams;
  const vendorBillId = q.get("vendor_bill_id");
  const start = q.get("period_start") ?? "";
  const end = q.get("period_end") ?? "";
  const billed = Number(q.get("billed_kwh"));
  const connectionId = q.get("connection_id");
  const locationId = q.get("location_id");
  const opening = q.get("opening_reading") != null && q.get("opening_reading") !== "" ? Number(q.get("opening_reading")) : null;
  if (!vendorBillId || !DATE_RE.test(start) || !DATE_RE.test(end) || end < start) {
    return NextResponse.json({ error: "vendor_bill_id and a valid period are required" }, { status: 400 });
  }

  const { data: vb } = await admin.from("vendor_bills").select("id, company_id").eq("id", vendorBillId).maybeSingle();
  if (!vb) return NextResponse.json({ error: "Vendor bill not found" }, { status: 404 });

  const { data: locs, error: lErr } = await admin
    .from("locations")
    .select("id, name, location_electricity_config(onegrid_default_device_id)")
    .eq("company_id", vb.company_id)
    .eq("is_active", true);
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

  const { data: conns } = await admin
    .from("location_electricity_connections")
    .select("id, location_id, onegrid_device_id")
    .eq("is_active", true)
    .in("location_id", (locs ?? []).map((l) => l.id as string));

  // Per location: the meter(s) that location's connections point at, else the location's default meter.
  const results: Array<{ location_id: string; location_name: string; observed_kwh: number | null; pct: number | null; status: string }> = [];
  for (const loc of locs ?? []) {
    const cfg = (loc as unknown as { location_electricity_config: { onegrid_default_device_id: string | null } | { onegrid_default_device_id: string | null }[] | null }).location_electricity_config;
    const cfgRow = Array.isArray(cfg) ? cfg[0] : cfg;
    const devices = new Set<string>();
    for (const c of conns ?? []) if (c.location_id === loc.id && c.onegrid_device_id) devices.add(c.onegrid_device_id as string);
    if (devices.size === 0 && cfgRow?.onegrid_default_device_id) devices.add(cfgRow.onegrid_default_device_id);
    if (devices.size === 0) continue;

    // Several meters at one site would double count if added, so the best-fitting one is reported.
    let best: { kwh: number | null; pct: number | null; status: string } = { kwh: null, pct: null, status: "unknown" };
    for (const deviceId of devices) {
      const readings = await loadMidnightReadings(admin, { locationId: loc.id as string, deviceId, from: start, to: addDays(end, 1) });
      const kwh = kwhBetween(readings, start, end);
      const v = fitVerdict(billed, kwh);
      if (kwh != null && (best.kwh == null || (v.pct != null && best.pct != null && Math.abs(v.pct) < Math.abs(best.pct)))) best = { kwh, pct: v.pct, status: v.status };
    }
    results.push({ location_id: loc.id as string, location_name: loc.name as string, observed_kwh: best.kwh, pct: best.pct, status: best.status });
  }

  // Continuity: previous linked bill on the same connection (or, with none, the same location).
  let continuity: { previous_closing: number | null; previous_period_end: string | null; diff: number | null; status: string } | null = null;
  if (opening != null && (connectionId || locationId)) {
    let prev = admin
      .from("electricity_bills")
      .select("closing_reading, period_end")
      .not("closing_reading", "is", null)
      .lt("period_end", start)
      .neq("status", "revised")
      .order("period_end", { ascending: false })
      .limit(1);
    prev = connectionId ? prev.eq("connection_id", connectionId) : prev.eq("location_id", locationId as string).is("connection_id", null);
    const { data: p } = await prev.maybeSingle();
    const closing = p?.closing_reading != null ? Number(p.closing_reading) : null;
    const v = continuityVerdict(opening, closing);
    continuity = { previous_closing: closing, previous_period_end: (p?.period_end as string | null) ?? null, diff: v.diff, status: v.status };
  }

  return NextResponse.json({ data: { locations: results, continuity } });
}
