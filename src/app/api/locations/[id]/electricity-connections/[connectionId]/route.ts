import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { checkConnectionInput, cleanAliases } from "@/lib/electricity-connections";
import { connectionConflictMessages } from "@/lib/electricity-connections-server";

/**
 * PATCH /api/locations/[id]/electricity-connections/[connectionId]
 * Admin only. Edits identifiers/meter details, or deactivates (is_active:false).
 * A connection is never deleted — bills will refer to it — and the vendor cannot be changed.
 * Re-activating re-runs the clash check, since its number may have been taken in the meantime.
 */

const updateSchema = z.object({
  consumer_number: z.string().nullish(),
  bill_aliases: z.array(z.string()).optional(),
  meter_label: z.string().nullish(),
  onegrid_device_id: z.string().nullish(),
  sanctioned_kva: z.number().positive().nullish(),
  is_active: z.boolean().optional(),
});

const blank = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; connectionId: string }> }) {
  const { id: locationId, connectionId } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") return NextResponse.json({ error: "Only an admin can change electricity connections" }, { status: 403 });

  const parsed = updateSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  const patch = parsed.data;

  const { data: current } = await admin
    .from("location_electricity_connections")
    .select("*")
    .eq("id", connectionId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

  const next = {
    consumer_number: "consumer_number" in patch ? blank(patch.consumer_number) : current.consumer_number,
    bill_aliases: patch.bill_aliases ? cleanAliases(patch.bill_aliases) : (current.bill_aliases as string[]),
    meter_label: "meter_label" in patch ? blank(patch.meter_label) : current.meter_label,
    onegrid_device_id: "onegrid_device_id" in patch ? blank(patch.onegrid_device_id) : current.onegrid_device_id,
    sanctioned_kva: "sanctioned_kva" in patch ? (patch.sanctioned_kva ?? null) : (current.sanctioned_kva as number | null),
    is_active: patch.is_active ?? (current.is_active as boolean),
  };

  const check = checkConnectionInput({ consumer_number: next.consumer_number, bill_aliases: next.bill_aliases, sanctioned_kva: next.sanctioned_kva });
  if (check.errors.length) return NextResponse.json({ error: check.errors.join(" ") }, { status: 400 });

  // Only an active connection claims identifiers, so only then can it clash.
  if (next.is_active) {
    try {
      const clashes = await connectionConflictMessages(
        admin,
        { vendor_id: current.vendor_id as string, consumer_number: next.consumer_number, bill_aliases: next.bill_aliases },
        connectionId
      );
      if (clashes.length) return NextResponse.json({ error: clashes.join(" ") }, { status: 409 });
    } catch (err) {
      console.error("[electricity-connections] conflict check failed:", err instanceof Error ? err.message : "unknown error");
      return NextResponse.json({ error: "Could not check the identifiers" }, { status: 500 });
    }
  }

  const { data: updated, error } = await admin
    .from("location_electricity_connections")
    .update(next)
    .eq("id", connectionId)
    .select("*, vendor:procurement_vendors(id, name)")
    .single();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "Another connection already uses this consumer number for this vendor." }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (JSON.stringify(current[k]) !== JSON.stringify(next[k])) changes[k] = { old: current[k], new: next[k] };
  }
  await logAudit(admin, {
    entityType: "electricity_connection",
    entityId: connectionId,
    action: "is_active" in patch && patch.is_active === false ? "disable" : "update",
    performedBy: dbUser.id,
    changes,
  });

  return NextResponse.json({ data: updated, warnings: check.warnings });
}
