import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS } from "@/lib/constants";

const createPrItemSchema = z.object({
  item_id: z.string().uuid().optional().nullable(),
  item_name: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year", "nos", "can", "ton"]),
  estimated_price: z.number().min(0).optional().nullable(),
  notes: z.string().optional(),
});

const createPrSchema = z.object({
  department: z.enum(["pantry", "maintenance", "administration", "asset"]),
  location_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional(),
  items: z.array(createPrItemSchema).min(1, "At least one item is required"),
  submit: z.boolean().optional(), // If true, create in "submitted" state
});

function generatePrNumber(count: number): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  return `PR-${yy}${mm}-${seq}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const department = searchParams.get("department");
  const locationId = searchParams.get("location_id");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;

  let query = supabase
    .from("purchase_requests")
    .select(
      `*, locations(id, name), requester:users!purchase_requests_requested_by_fkey(id, full_name, email), approver:users!purchase_requests_approved_by_fkey(id, full_name, email)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // Only procurement roles can see all; others are blocked at the route level
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (status) query = query.eq("status", status);
  if (department) query = query.eq("department", department);
  if (locationId) query = query.eq("location_id", locationId);

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
  const parsed = createPrSchema.safeParse(body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const msg = Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ");
    return NextResponse.json({ error: msg || "Invalid request data" }, { status: 400 });
  }

  const { items, submit, ...prData } = parsed.data;

  // Compute total estimated
  const totalEstimated = items.reduce((sum, item) => {
    if (item.estimated_price && item.quantity) {
      return sum + item.quantity * item.estimated_price;
    }
    return sum;
  }, 0);

  // Generate PR number within a transaction-safe approach
  const { count: existingCount } = await supabase
    .from("purchase_requests")
    .select("*", { count: "exact", head: true });

  const prNumber = generatePrNumber(existingCount ?? 0);
  const status = submit ? "submitted" : "draft";

  const { data: pr, error: prError } = await supabase
    .from("purchase_requests")
    .insert({
      ...prData,
      pr_number: prNumber,
      status,
      requested_by: dbUser.id,
      total_estimated_amount: totalEstimated,
    })
    .select("id, pr_number")
    .single();

  if (prError) return NextResponse.json({ error: prError.message }, { status: 500 });

  // Insert line items
  const lineItems = items.map((item) => ({
    pr_id: pr.id,
    item_id: item.item_id || null,
    item_name: item.item_name,
    quantity: item.quantity,
    unit: item.unit,
    estimated_price: item.estimated_price || null,
    total_estimated: item.estimated_price ? item.quantity * item.estimated_price : null,
    notes: item.notes || null,
  }));

  const { error: itemsError } = await supabase.from("purchase_request_items").insert(lineItems);
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "purchase_request",
    entityId: pr.id,
    action: "create",
    performedBy: dbUser.id,
  });

  return NextResponse.json({ data: { id: pr.id, pr_number: pr.pr_number } }, { status: 201 });
}
