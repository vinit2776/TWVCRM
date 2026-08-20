import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { ITEM_UNITS } from "@/lib/constants";

const createItemSchema = z.object({
  name: z.string().min(1, "Item name is required"),
  department: z.enum(["pantry", "maintenance", "administration", "asset"]),
  unit: z.enum(ITEM_UNITS),
  item_type: z.enum(["goods", "service"]).default("goods"),
  standard_price: z.number().min(0).optional(),
  gst_rate: z.number().min(0).max(28).default(0),
  description: z.string().optional(),
  // Catalog-level MOQ defaults — pre-fill new per-location rows / drive refill
  // when a location hasn't set its own. null = unset.
  default_reorder_level: z.number().min(0).nullable().optional(),
  default_max_level: z.number().min(0).nullable().optional(),
  is_active: z.boolean().optional(),
  is_suggested: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const department = searchParams.get("department");
  const search = searchParams.get("search");
  const itemType = searchParams.get("item_type");
  const includeInactive = searchParams.get("include_inactive") === "true";
  const suggestedOnly = searchParams.get("suggested") === "true";

  let query = supabase
    .from("procurement_items")
    .select("*, creator:users!procurement_items_created_by_fkey(id, full_name)", { count: "exact" })
    .order("department")
    .order("name");

  if (suggestedOnly) {
    // Return only pending catalog suggestions (is_suggested=true, is_active=false)
    query = query.eq("is_suggested", true).eq("is_active", false);
  } else if (!includeInactive) {
    // Normal catalog view: only active, non-suggested items
    query = query.eq("is_active", true).eq("is_suggested", false);
  }
  if (department === "reimbursement") {
    // Reimbursement isn't an item category — it's a billing treatment — so no
    // catalog item is ever tagged that way. Search across every real
    // department instead. AMC is excluded: those are annual service
    // contracts, not one-off purchasable goods.
    query = query.in("department", ["pantry", "maintenance", "administration", "asset"]);
  } else if (department) {
    query = query.eq("department", department);
  }
  if (itemType) query = query.eq("item_type", itemType);
  if (search?.trim()) query = query.ilike("name", `%${search.trim()}%`);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data, count });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const isPrivileged = ["admin", "manager", "office_admin"].includes(dbUser.role);

  const body = await request.json();
  const parsed = createItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Non-privileged users can only create catalog suggestions (is_active: false, is_suggested: true).
  // Privileged users can create active catalog items directly.
  if (!isPrivileged && parsed.data.is_suggested !== true) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Force suggestion mode for non-privileged users regardless of payload
  const isSuggestion = !isPrivileged || parsed.data.is_suggested === true;
  const insertIsActive = isSuggestion ? false : (parsed.data.is_active ?? true);
  const insertIsSuggested = isSuggestion;

  // ── Uniqueness check (case-insensitive, only for active catalog items) ─────
  // Skip name collision check for suggestions — they may have the same name;
  // admin will resolve duplicates during review.
  if (!isSuggestion) {
    const { data: existing } = await supabase
      .from("procurement_items")
      .select("id, name")
      .ilike("name", parsed.data.name.trim())
      .eq("is_active", true)
      .eq("is_suggested", false)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: `An item named "${existing.name}" already exists in the catalog. Item names must be unique.` },
        { status: 409 }
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { is_active: _ia, is_suggested: _is, ...coreData } = parsed.data;

  const { data: item, error } = await supabase
    .from("procurement_items")
    .insert({ ...coreData, is_active: insertIsActive, is_suggested: insertIsSuggested, created_by: dbUser.id })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "procurement_item",
    entityId: item.id,
    action: "create",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: item }, { status: 201 });
}
