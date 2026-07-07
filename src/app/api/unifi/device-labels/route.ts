/**
 * /api/unifi/device-labels
 *
 * Lets ops staff attach a friendly label (and optionally a contract link) to
 * a UniFi client MAC address. Purely a CRM-side annotation — does not touch
 * UniFi itself. Read by anyone who can see the Devices tab; written only by
 * roles that manage contracts.
 *
 * GET    ?location_id=<id>            — list all labels for a location
 * POST   { location_id, mac, label, contract_id? }        — create/update (upsert by mac+location)
 * DELETE ?id=<label_id>                — remove a label
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const WRITE_ROLES = ["admin", "manager", "sales_rep"];

const upsertSchema = z.object({
  location_id: z.string().uuid(),
  mac: z.string().min(1),
  label: z.string().min(1).max(120),
  contract_id: z.string().uuid().nullish(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = request.nextUrl.searchParams.get("location_id");
  if (!locationId) {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("unifi_device_labels")
    .select("id, mac, label, contract_id, contracts(contract_number, title)")
    .eq("location_id", locationId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!WRITE_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const { location_id, mac, label, contract_id } = parsed.data;

  const { data, error } = await supabase
    .from("unifi_device_labels")
    .upsert(
      {
        location_id,
        mac,
        label,
        contract_id: contract_id ?? null,
        created_by: dbUser.id,
      },
      { onConflict: "location_id,mac" }
    )
    .select("id, mac, label, contract_id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "unifi_device_label",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { label: { old: null, new: label }, contract_id: { old: null, new: contract_id ?? null } },
  });

  return NextResponse.json({ data });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  if (!WRITE_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await supabase.from("unifi_device_labels").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "unifi_device_label",
    entityId: id,
    action: "delete",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ ok: true });
}
