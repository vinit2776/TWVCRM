import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
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

  // Check for duplicate invoice
  const { data: existing } = await supabase
    .from("aggregator_invoices")
    .select("id, invoice_number")
    .eq("aggregator_id", aggregator_id)
    .eq("period_month", period_month)
    .eq("period_year", period_year)
    .single();

  if (existing) {
    return NextResponse.json(
      {
        error: `Invoice already exists for this period: ${existing.invoice_number}`,
      },
      { status: 409 }
    );
  }

  // Get the aggregator for interstate check
  const { data: aggregator } = await supabase
    .from("aggregators")
    .select("id, name, same_state_as_twv")
    .eq("id", aggregator_id)
    .single();

  if (!aggregator) {
    return NextResponse.json(
      { error: "Aggregator not found" },
      { status: 404 }
    );
  }

  // Get all active cases for this aggregator in the given period
  const { data: cases } = await supabase
    .from("cases")
    .select("id, case_number, client_name, purpose, rate, tenure_months, start_date, activated_at, status")
    .eq("aggregator_id", aggregator_id)
    .in("status", [
      "active",
      "renewal_due",
      "invoiced",
      "executed",
    ]);

  if (!cases || cases.length === 0) {
    return NextResponse.json(
      { error: "No active cases found for this aggregator in the period" },
      { status: 400 }
    );
  }

  // Calculate line items with pro-rating
  const periodStart = new Date(period_year, period_month - 1, 1);
  const periodEnd = new Date(period_year, period_month, 0); // Last day of month
  const totalDaysInMonth = periodEnd.getDate();

  const lineItems = cases
    .filter((c) => c.rate && c.rate > 0)
    .map((c) => {
      let activeDays = totalDaysInMonth;
      let proRatedDays: number | undefined;

      // Pro-rate if activated mid-month
      if (c.activated_at) {
        const activatedDate = new Date(c.activated_at);
        if (
          activatedDate.getMonth() === period_month - 1 &&
          activatedDate.getFullYear() === period_year
        ) {
          activeDays = totalDaysInMonth - activatedDate.getDate() + 1;
          proRatedDays = activeDays;
        }
      }

      const monthlyRate = c.rate || 0;
      const amount =
        proRatedDays !== undefined
          ? Math.round(
              (monthlyRate / totalDaysInMonth) * activeDays * 100
            ) / 100
          : monthlyRate;

      return {
        case_id: c.id,
        case_number: c.case_number,
        client_name: c.client_name,
        purpose: c.purpose,
        rate: monthlyRate,
        pro_rated_days: proRatedDays,
        total_days: totalDaysInMonth,
        amount,
      };
    });

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const isInterstate = !aggregator.same_state_as_twv;
  const taxAmount = Math.round(subtotal * (tax_percentage / 100) * 100) / 100;

  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;

  if (isInterstate) {
    igstAmount = taxAmount;
  } else {
    cgstAmount = Math.round((taxAmount / 2) * 100) / 100;
    sgstAmount = Math.round((taxAmount / 2) * 100) / 100;
  }

  const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  // Create the invoice
  const { data: invoice, error: invoiceError } = await supabase
    .from("aggregator_invoices")
    .insert({
      aggregator_id,
      period_month,
      period_year,
      status: "draft",
      items: lineItems,
      subtotal,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      igst_amount: igstAmount,
      total_amount: totalAmount,
      is_interstate: isInterstate,
      tax_percentage,
      notes,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (invoiceError) {
    return NextResponse.json(
      { error: invoiceError.message },
      { status: 500 }
    );
  }

  // Audit
  if (dbUser?.id && invoice) {
    logAudit(supabase, {
      entityType: "aggregator_invoice",
      entityId: invoice.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: invoice } },
    });
  }

  return NextResponse.json({ data: invoice }, { status: 201 });
}
