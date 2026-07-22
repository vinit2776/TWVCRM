import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { STOCK_DEPARTMENTS } from "@/lib/constants";
import { z } from "zod";

const CROSS_LOCATION_ROLES = ["admin", "manager", "office_admin"];
// Branch requester roles create requests scoped to their own assigned
// location(s), sourced only from the issuing-source location (locations.is_issuing_source).
const BRANCH_REQUESTER_ROLES = ["floor_manager", "fms"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createTransferSchema = z.object({
  from_location_id: z.string().uuid(),
  to_location_id: z.string().uuid(),
  origin: z.enum(["manual", "replenishment"]).optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        item_id: z.string().uuid().optional(),
        item_name: z.string().min(1),
        unit: z.string().min(1),
        quantity_requested: z.number().positive(),
        notes: z.string().optional(),
      })
    )
    .min(1, "At least one item is required"),
});

function generateTransferNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `TWV-TF-${yy}${mm}-${seq}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  // statuses: comma-separated list, for views that span multiple statuses at
  // once (e.g. the pipeline view — anything still in flight).
  const statuses = searchParams.get("statuses");
  const locationId = searchParams.get("location_id");
  // incoming_to: transfers heading TO this location that are still in the
  // pipeline (requested → approved → on the way) — i.e. "upcoming inwards".
  const incomingTo = searchParams.get("incoming_to");
  // location_ids: scope the list to transfers involving any of these locations
  // (from OR to) — used to show a user only their assigned locations' transfers.
  const locationIds = searchParams.get("location_ids");
  const search = searchParams.get("search")?.trim();
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  // Validate incoming_to is a UUID before passing to the DB
  if (incomingTo && !UUID_RE.test(incomingTo)) {
    return NextResponse.json({ error: "Invalid incoming_to parameter" }, { status: 400 });
  }

  // Scope check: non-HO roles may only query locations they're assigned to
  if (!CROSS_LOCATION_ROLES.includes(dbUser.role)) {
    const { data: assignedRows } = await supabase
      .from("user_locations")
      .select("location_id")
      .eq("user_id", dbUser.id);
    const assignedIds = new Set((assignedRows ?? []).map((r: { location_id: string }) => r.location_id));

    const idsToCheck = [
      ...(locationIds ? locationIds.split(",").map((s) => s.trim()).filter(Boolean) : []),
      ...(incomingTo ? [incomingTo] : []),
      ...(locationId ? [locationId] : []),
    ];

    if (idsToCheck.length > 0 && idsToCheck.some((id) => !assignedIds.has(id))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let query = supabase
    .from("stock_transfers")
    .select(
      `*, from_location:locations!stock_transfers_from_location_id_fkey(id, name, code), to_location:locations!stock_transfers_to_location_id_fkey(id, name, code), initiator:users!stock_transfers_initiated_by_fkey(id, full_name), stock_transfer_items(id, item_name, unit, quantity_requested, quantity_approved, quantity_sent, quantity_received)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (incomingTo) {
    query = query
      .eq("to_location_id", incomingTo)
      .in("status", ["pending_approval", "approved", "dispatched"]);
  } else if (statuses) {
    const statusList = statuses.split(",").map((s) => s.trim()).filter(Boolean);
    if (statusList.length > 0) query = query.in("status", statusList);
  } else if (status) {
    query = query.eq("status", status);
  }
  if (locationIds) {
    const ids = locationIds.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) {
      const orClause = ids
        .flatMap((id) => [`from_location_id.eq.${id}`, `to_location_id.eq.${id}`])
        .join(",");
      query = query.or(orClause);
    }
  } else if (locationId) {
    query = query.or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`);
  }
  if (search) {
    query = query.ilike("transfer_number", `%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const isCrossLocation = CROSS_LOCATION_ROLES.includes(dbUser.role);
  const isBranchRequester = BRANCH_REQUESTER_ROLES.includes(dbUser.role);
  if (!isCrossLocation && !isBranchRequester) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = createTransferSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  if (parsed.data.from_location_id === parsed.data.to_location_id) {
    return NextResponse.json({ error: "From and To locations must be different" }, { status: 422 });
  }

  // Branch requesters (floor_manager/fms) can only request TO their own
  // assigned location(s), and only FROM the designated issuing-source
  // location — they don't get a free choice of either.
  if (isBranchRequester) {
    const { data: issuingSource } = await supabase
      .from("locations")
      .select("id")
      .eq("is_issuing_source", true)
      .maybeSingle();

    if (!issuingSource || parsed.data.from_location_id !== issuingSource.id) {
      return NextResponse.json(
        { error: "Requests must be sourced from the designated issuing location" },
        { status: 422 }
      );
    }

    const { data: assignedRows } = await supabase
      .from("user_locations")
      .select("location_id")
      .eq("user_id", dbUser.id);
    const assignedIds = new Set((assignedRows ?? []).map((r: { location_id: string }) => r.location_id));

    if (assignedIds.size === 0) {
      return NextResponse.json(
        { error: "You're not assigned to a location. Contact an admin to request transfers." },
        { status: 403 }
      );
    }
    if (!assignedIds.has(parsed.data.to_location_id)) {
      return NextResponse.json(
        { error: "You can only request transfers to your own assigned location" },
        { status: 403 }
      );
    }
  }

  // Block non-stock items: services (AMC, rentals, pest control) and items from
  // non-stock departments (e.g. Administration) cannot be transferred.
  const transferItemIds = parsed.data.items.map((i) => i.item_id).filter(Boolean) as string[];
  if (transferItemIds.length > 0) {
    const { data: itemRows } = await supabase
      .from("procurement_items")
      .select("id, name, item_type, department")
      .in("id", transferItemIds);
    const blocked = (itemRows ?? []).find(
      (r) => r.item_type === "service" || !STOCK_DEPARTMENTS.includes(r.department)
    );
    if (blocked) {
      return NextResponse.json(
        { error: `"${blocked.name}" is not a transferable stock item (services and non-stock departments like Administration cannot be transferred).` },
        { status: 422 }
      );
    }
  }

  // Generate transfer number
  const { count: existingCount } = await supabase
    .from("stock_transfers")
    .select("*", { count: "exact", head: true });
  const transferNumber = generateTransferNumber(existingCount ?? 0);

  // Insert transfer header
  const { data: transfer, error: transferError } = await supabase
    .from("stock_transfers")
    .insert({
      transfer_number: transferNumber,
      from_location_id: parsed.data.from_location_id,
      to_location_id: parsed.data.to_location_id,
      origin: parsed.data.origin ?? "manual",
      notes: parsed.data.notes ?? null,
      initiated_by: dbUser.id,
      status: "draft",
    })
    .select("id, transfer_number")
    .single();

  if (transferError) return NextResponse.json({ error: transferError.message }, { status: 500 });

  // Insert transfer items. quantity_sent is a placeholder until dispatch
  // actually sets it (the issuer confirms the real amount sent then);
  // quantity_approved is null until the approve step sets it.
  const items = parsed.data.items.map((item) => ({
    transfer_id: transfer.id,
    item_id: item.item_id ?? null,
    item_name: item.item_name,
    unit: item.unit,
    quantity_requested: item.quantity_requested,
    quantity_approved: null,
    quantity_sent: 0,
    quantity_received: 0,
    notes: item.notes?.trim() || null,
  }));

  const { error: itemsError } = await supabase.from("stock_transfer_items").insert(items);
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "stock_transfer",
    entityId: transfer.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      transfer_number: { old: null, new: transfer.transfer_number },
      from_location_id: { old: null, new: parsed.data.from_location_id },
      to_location_id: { old: null, new: parsed.data.to_location_id },
      item_count: { old: null, new: parsed.data.items.length },
    },
  });

  return NextResponse.json({ data: { id: transfer.id, transfer_number: transfer.transfer_number } }, { status: 201 });
}
