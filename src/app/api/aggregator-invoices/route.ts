import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { generateConsolidatedInvoice } from "@/lib/aggregator-invoicing";
import { z } from "zod";

const generateInvoiceSchema = z.object({
  aggregator_id: z.string().uuid("Invalid aggregator ID"),
  period_month: z.number().int().min(1).max(12),
  period_year: z.number().int().min(2020).max(2100),
  tax_percentage: z.number().min(0).max(100).default(18),
  notes: z.string().optional(),
});

/**
 * GET: List aggregator invoices (paginated, filterable)
 * POST: Generate a consolidated monthly invoice for an aggregator
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const aggregator_id = searchParams.get("aggregator_id");
  const status = searchParams.get("status");
  const sort_by = searchParams.get("sort_by") || "created_at";
  const sort_order = searchParams.get("sort_order") || "desc";

  const offset = (page - 1) * limit;

  let query = supabase
    .from("aggregator_invoices")
    .select(
      "*, aggregator:aggregators!aggregator_invoices_aggregator_id_fkey(id, name, code)",
      { count: "exact" }
    );

  if (aggregator_id) query = query.eq("aggregator_id", aggregator_id);
  if (status) query = query.eq("status", status);

  const ascending = sort_order === "asc";
  query = query
    .order(sort_by, { ascending })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = generateInvoiceSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { aggregator_id, period_month, period_year, tax_percentage, notes } =
    result.data;

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const { invoice, error, status } = await generateConsolidatedInvoice({
    supabase,
    aggregatorId: aggregator_id,
    periodMonth: period_month,
    periodYear: period_year,
    taxPercentage: tax_percentage,
    notes,
    createdBy: dbUser?.id,
  });

  if (error) {
    return NextResponse.json({ error }, { status });
  }

  // Audit
  if (dbUser?.id && invoice) {
    logAudit(supabase, {
      entityType: "aggregator_invoice",
      entityId: invoice.id as string,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: invoice } },
    });
  }

  return NextResponse.json({ data: invoice }, { status });
}
