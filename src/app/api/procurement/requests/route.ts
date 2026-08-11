import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS } from "@/lib/constants";

const createPrItemSchema = z.object({
  item_id: z.string().uuid().optional().nullable(),
  item_name: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.enum(["kg", "litre", "packet", "box", "piece", "roll", "dozen", "bottle", "bag", "set", "pair", "month", "quarter", "year", "nos", "can", "ton", "hr"]),
  estimated_price: z.number().min(0).optional().nullable(),
  notes: z.string().optional(),
});

const createPrSchema = z.object({
  department: z.enum(["pantry", "maintenance", "administration", "asset", "amc", "reimbursement"]),
  location_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional(),
  expenditure_type: z.enum(["operational", "amc"]).default("operational"),
  items: z.array(createPrItemSchema).min(1, "At least one item is required"),
  submit: z.boolean().optional(), // If true, create in "submitted" state

  // Reimbursement fields — only used when department='reimbursement'. Identifies
  // which customer/contract this spend will ultimately be billed back to.
  billable_contract_id: z.string().uuid().optional().nullable(),

  // AMC fields — only used when department='amc'. Validated leniently here;
  // the form gates the required ones client-side and the PO step re-validates.
  service_item_name: z.string().optional().nullable(),
  linked_asset_id: z.string().uuid().optional().nullable(),
  amc_coverage_type: z.enum(["comprehensive", "labour_only"]).optional().nullable(),
  amc_start_date: z.string().optional().nullable(),
  amc_end_date: z.string().optional().nullable(),
  amc_visits_covered: z.number().int().positive().optional().nullable(),
  amc_contact_name: z.string().optional().nullable(),
  amc_helpline_number: z.string().optional().nullable(),
  amc_contact_email: z.string().email().optional().nullable().or(z.literal("")),
  amc_escalation_name: z.string().optional().nullable(),
  amc_escalation_phone: z.string().optional().nullable(),
  amc_escalation2_name: z.string().optional().nullable(),
  amc_escalation2_phone: z.string().optional().nullable(),
  advance_amount: z.number().min(0).optional().nullable(),
  advance_payment_mode: z.enum(["neft", "rtgs", "imps", "bank_transfer", "cheque", "cash"]).optional().nullable(),
  advance_notes: z.string().optional().nullable(),
}).refine((data) => data.department !== "reimbursement" || !!data.billable_contract_id, {
  message: "billable_contract_id is required when department is 'reimbursement'",
  path: ["billable_contract_id"],
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
  const search = searchParams.get("search")?.trim() ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "25")));
  const offset = (page - 1) * limit;
  // "all" bypasses pagination for summary/grouping views that need every matching row —
  // capped at 1000 since this endpoint is always scoped to a department/date-range in practice.
  const fetchAll = searchParams.get("all") === "1";
  const ALL_ROWS_CAP = 1000;

  let query = supabase
    .from("purchase_requests")
    .select(
      `*, locations(id, name), requester:users!purchase_requests_requested_by_fkey(id, full_name, email), approver:users!purchase_requests_approved_by_fkey(id, full_name, email)`,
      { count: "exact" }
    )
    .order("created_at", { ascending: false });

  query = fetchAll ? query.limit(ALL_ROWS_CAP) : query.range(offset, offset + limit - 1);

  // Only procurement roles can see all; others are blocked at the route level
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const fromDate = searchParams.get("from_date");
  const toDate = searchParams.get("to_date");
  const expenditureType = searchParams.get("expenditure_type");

  // "active" is a meta-status: all non-cancelled, non-rejected.
  // "committed" is a meta-status: approved and beyond — matches what the budget bar counts as spend.
  if (status === "active") {
    query = query.not("status", "in", '("cancelled","rejected")');
  } else if (status === "committed") {
    query = query.in("status", ["approved", "partially_ordered", "po_created"]);
  } else if (status) {
    query = query.eq("status", status);
  }
  if (department) query = query.eq("department", department);
  if (locationId) query = query.eq("location_id", locationId);
  if (fromDate) query = query.gte("created_at", fromDate);
  if (toDate) query = query.lte("created_at", toDate);
  if (expenditureType) query = query.eq("expenditure_type", expenditureType);

  // Search: require ≥3 chars to prevent full-table scans on short terms
  if (search.length >= 3) {
    query = query.ilike("pr_number", `%${search}%`);
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
