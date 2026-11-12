import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { checkConnectionInput, cleanAliases } from "@/lib/electricity-connections";
import { connectionConflictMessages } from "@/lib/electricity-connections-server";

/**
 * GET  /api/locations/[id]/electricity-connections[?include_inactive=true]
 *   Any signed-in user can read how a location's connections are identified.
 * POST /api/locations/[id]/electricity-connections
 *   Admin only. Creates a connection after checking the vendor and that no other
 *   active connection of that vendor already uses the same consumer number or name.
 */

const createSchema = z.object({
  vendor_id: z.string().uuid(),
  consumer_number: z.string().nullish(),
  bill_aliases: z.array(z.string()).default([]),
  meter_label: z.string().nullish(),
  onegrid_device_id: z.string().nullish(),
  sanctioned_kva: z.number().positive().nullish(),
});

const blank = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let q = supabase
    .from("location_electricity_connections")
    .select("*, vendor:procurement_vendors(id, name)")
    .eq("location_id", id)
    .order("created_at", { ascending: true });
  if (request.nextUrl.searchParams.get("include_inactive") !== "true") q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: locationId } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") return NextResponse.json({ error: "Only an admin can change electricity connections" }, { status: 403 });

  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  const input = parsed.data;

  const { data: location } = await admin.from("locations").select("id").eq("id", locationId).maybeSingle();
  if (!location) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  const { data: vendor } = await admin
    .from("procurement_vendors")
    .select("id, is_electricity_provider, is_active")
    .eq("id", input.vendor_id)
    .maybeSingle();
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
  if (!vendor.is_electricity_provider) {
    return NextResponse.json({ error: "This vendor is not marked as an electricity provider. Switch that on under Procurement → Vendors first." }, { status: 422 });
  }
  if (!vendor.is_active) return NextResponse.json({ error: "This vendor is inactive." }, { status: 422 });

  const consumer_number = blank(input.consumer_number);
  const bill_aliases = cleanAliases(input.bill_aliases);
  const sanctioned_kva = input.sanctioned_kva ?? null;

  const check = checkConnectionInput({ consumer_number, bill_aliases, sanctioned_kva });
  if (check.errors.length) return NextResponse.json({ error: check.errors.join(" ") }, { status: 400 });

  try {
    const clashes = await connectionConflictMessages(admin, { vendor_id: input.vendor_id, consumer_number, bill_aliases });
    if (clashes.length) return NextResponse.json({ error: clashes.join(" ") }, { status: 409 });
  } catch (err) {
    console.error("[electricity-connections] conflict check failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Could not check the identifiers" }, { status: 500 });
  }

  const { data: created, error } = await admin
    .from("location_electricity_connections")
    .insert({
      location_id: locationId,
      vendor_id: input.vendor_id,
      consumer_number,
      bill_aliases,
      meter_label: blank(input.meter_label),
      onegrid_device_id: blank(input.onegrid_device_id),
      sanctioned_kva,
      created_by: dbUser.id,
    })
    .select("*, vendor:procurement_vendors(id, name)")
    .single();

  if (error) {
    // Two admins saving the same number at once: the unique index is the backstop for the check above.
    if (error.code === "23505") return NextResponse.json({ error: "Another connection already uses this consumer number for this vendor." }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit(admin, {
    entityType: "electricity_connection",
    entityId: created.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      consumer_number: { old: null, new: consumer_number },
      bill_aliases: { old: null, new: bill_aliases },
      onegrid_device_id: { old: null, new: created.onegrid_device_id },
    },
  });

  return NextResponse.json({ data: created, warnings: check.warnings }, { status: 201 });
}
