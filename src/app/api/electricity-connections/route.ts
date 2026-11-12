import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/electricity-connections?vendor_id=<uuid>
 * A vendor's active connections at every location, with the location's name. The bill form uses it
 * to recognise a consumer number or printed name as belonging to a particular connection — including
 * one at a different location from the one being chosen. Read-only; any signed-in user.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const vendorId = z.string().uuid().safeParse(request.nextUrl.searchParams.get("vendor_id"));
  if (!vendorId.success) return NextResponse.json({ error: "vendor_id is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("location_electricity_connections")
    .select("id, location_id, vendor_id, consumer_number, bill_aliases, meter_label, is_active, location:locations(id, name)")
    .eq("vendor_id", vendorId.data)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []).map((c) => ({
    id: c.id,
    location_id: c.location_id,
    vendor_id: c.vendor_id,
    consumer_number: c.consumer_number,
    bill_aliases: c.bill_aliases ?? [],
    meter_label: c.meter_label,
    is_active: c.is_active,
    location_name: (c.location as unknown as { name?: string } | null)?.name ?? "another location",
  }));
  return NextResponse.json({ data: rows });
}
