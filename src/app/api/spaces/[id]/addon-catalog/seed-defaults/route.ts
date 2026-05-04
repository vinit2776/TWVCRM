import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/spaces/[id]/addon-catalog/seed-defaults
 *
 * Copies every active "template" row (addon_catalog where space_id IS NULL)
 * into a new set of rows scoped to this space. Idempotent — items already
 * present (matched by `name` case-insensitive) are skipped so calling twice
 * doesn't create duplicates.
 *
 * Used by the Charges tab on the space detail page when admin clicks the
 * "Use defaults" empty-state button. Saves them re-typing the 11 standard
 * items (Tea, Coffee, Print, Locker, etc.) for every new space.
 *
 * Admin / Manager only.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: spaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  // Confirm the space exists
  const { data: space } = await supabase
    .from("spaces").select("id, name").eq("id", spaceId).single();
  if (!space) return NextResponse.json({ error: "Space not found" }, { status: 404 });

  // Pull templates + existing space rows in parallel
  const [tplRes, existingRes] = await Promise.all([
    supabase.from("addon_catalog")
      .select("addon_type, name, description, unit_price, unit_label, gst_rate, sort_order")
      .is("space_id", null)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabase.from("addon_catalog")
      .select("name")
      .eq("space_id", spaceId),
  ]);

  if (tplRes.error)      return NextResponse.json({ error: tplRes.error.message },      { status: 500 });
  if (existingRes.error) return NextResponse.json({ error: existingRes.error.message }, { status: 500 });

  const existingNames = new Set(
    (existingRes.data ?? []).map((r: { name: string }) => r.name.toLowerCase())
  );

  // Skip templates whose name already exists on this space (case-insensitive)
  type Tpl = {
    addon_type: string; name: string; description: string | null;
    unit_price: number; unit_label: string | null; gst_rate: number; sort_order: number;
  };
  const toInsert = (tplRes.data ?? [] as Tpl[])
    .filter((t: Tpl) => !existingNames.has(t.name.toLowerCase()))
    .map((t: Tpl) => ({
      space_id: spaceId,
      addon_type: t.addon_type,
      name: t.name,
      description: t.description,
      unit_price: t.unit_price,
      unit_label: t.unit_label,
      gst_rate: t.gst_rate,
      sort_order: t.sort_order,
      is_active: true,
      created_by: dbUser.id,
    }));

  if (toInsert.length === 0) {
    return NextResponse.json({ added: 0, skipped: existingNames.size, message: "Already seeded" });
  }

  const { data: inserted, error } = await supabase
    .from("addon_catalog")
    .insert(toInsert)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // One audit row covering the bulk seed
  logAudit(supabase, {
    entityType: "addon_catalog",
    entityId: spaceId,                   // associate with the space, not any single row
    action: "create",
    performedBy: dbUser.id,
    changes: {
      seeded_for_space: { old: null, new: { count: inserted?.length ?? 0, source: "templates" } },
    },
  });

  return NextResponse.json({
    added: inserted?.length ?? 0,
    skipped: existingNames.size,
  });
}
