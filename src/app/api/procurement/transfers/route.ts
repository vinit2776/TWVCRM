import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createTransferSchema = z.object({
  from_location_id: z.string().uuid(),
  to_location_id: z.string().uuid(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        item_id: z.string().uuid().optional(),
        item_name: z.string().min(1),
        unit: z.string().min(1),
        quantity_sent: z.number().positive(),
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
  const locationId = searchParams.get("location_id");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  let query = supabase
    .from("stock_transfers")
    .select(
      `*, from_location:locations!stock_transfers_from_location_id_fkey(id, name, code), to_location:locations!stock_transfers_to_location_id_fkey(id, name, code), initiator:users!stock_transfers_initiated_by_fkey(id, full_name)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (locationId) {
    query = query.or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`);
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

  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
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
      notes: parsed.data.notes ?? null,
      initiated_by: dbUser.id,
      status: "draft",
    })
    .select("id, transfer_number")
    .single();

  if (transferError) return NextResponse.json({ error: transferError.message }, { status: 500 });

  // Insert transfer items
  const items = parsed.data.items.map((item) => ({
    transfer_id: transfer.id,
    item_id: item.item_id ?? null,
    item_name: item.item_name,
    unit: item.unit,
    quantity_sent: item.quantity_sent,
    quantity_received: 0,
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
