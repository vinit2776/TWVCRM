import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { invoiceParty, type InvoiceCaseLike } from "@/lib/invoice-party";

const ALLOWED_ROLES = ["admin", "manager", "accounts", "sales_rep"];

const CASE_SELECT =
  "id, case_number, client_name, client_company_name, client_email, client_phone, " +
  "client_gst_number, aggregator_id, bill_to, " +
  "aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone, gst_number)";

/**
 * GET  /api/cases/[id]/adhoc-invoices — the case's ad-hoc invoices, and who a
 *      new one would bill.
 * POST /api/cases/[id]/adhoc-invoices — raise one.
 *
 * These are ordinary ad-hoc proforma invoices — the same table and the same
 * INV- series as the ones raised from a lead — just addressed to a case. The
 * buyer comes from the case's billing route rather than a lead: an aggregator
 * for a partner-billed case, the client for a direct one.
 *
 * The licence fee (vo_case) and the renewal (vo_renewal) have their own paths.
 * Duplicating either here would leave a customer with two payment links for
 * one debt.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  const { data: caseRaw } = await adminSupabase
    .from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  if (!caseRaw) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const { data: invoices, error: listError } = await adminSupabase
    .from("proforma_invoices")
    .select("id, invoice_number, title, status, subtotal, total_amount, created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });

  // Surface a failed read rather than rendering it as "no invoices" — an
  // empty list and a broken query look identical to the user otherwise, and
  // this one fails outright until migration 00532 is applied.
  if (listError) {
    console.error(`[adhoc-invoices] list failed for case ${caseId}: ${listError.message}`);
    return NextResponse.json(
      { error: `Could not load ad-hoc invoices: ${listError.message}` },
      { status: 500 },
    );
  }

  const party = invoiceParty({ case: caseRaw as unknown as InvoiceCaseLike });

  return NextResponse.json({
    data: {
      invoices: invoices ?? [],
      billsTo: party && !party.blocked
        ? { kind: party.source === "case-aggregator" ? "aggregator" : "client", name: party.name, gstin: party.gstin }
        : null,
      endClientName:
        (caseRaw as { client_company_name?: string; client_name?: string }).client_company_name ||
        (caseRaw as { client_name?: string }).client_name || null,
      blocked: party?.blocked ?? null,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    description?: string;
    amount?: number;
    notes?: string;
    bill_to_override?: "client" | null;
  };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to raise ad-hoc invoices" }, { status: 403 });
  }

  const description = (body.description ?? "").trim();
  const amount = Number(body.amount);
  if (!description) {
    return NextResponse.json({ error: "A description is required." }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Amount must be greater than zero." }, { status: 400 });
  }

  const adminSupabase = await createAdminClient();
  const { data: caseRaw } = await adminSupabase
    .from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  if (!caseRaw) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const billClientOverride = body.bill_to_override === "client";
  const party = invoiceParty({
    case: caseRaw as unknown as InvoiceCaseLike,
    billClientOverride,
  });

  if (!party || party.blocked) {
    return NextResponse.json(
      { error: party?.blocked ?? "Could not determine who to bill for this case." },
      { status: 400 },
    );
  }

  const subtotal = Math.round(amount * 100) / 100;
  const taxPercentage = 18;
  const taxAmount = Math.round(subtotal * taxPercentage) / 100;
  const total = subtotal + taxAmount;

  // The end client is named in the line item even when a partner is billed —
  // an aggregator holds many cases and a bare description is ambiguous on
  // their invoice.
  const lineDescription = party.onBehalfOf
    ? `${description} — ${party.onBehalfOf}`
    : description;

  const { data: invoice, error } = await adminSupabase
    .from("proforma_invoices")
    .insert({
      case_id: caseId,
      lead_id: null,
      title: description,
      status: "draft",
      primary_head: "other_income",
      items: [{ description: lineDescription, quantity: 1, rate: subtotal, amount: subtotal }],
      subtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      discount_percentage: 0,
      discount_amount: 0,
      total_amount: total,
      notes: body.notes?.trim() || null,
      created_by: dbUser.id,
    })
    .select("id, invoice_number")
    .single();

  if (error || !invoice) {
    console.error(`[adhoc-invoices] failed for case ${caseId}:`, error);
    return NextResponse.json({ error: error?.message ?? "Failed to create the invoice" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "invoice",
    entityId: invoice.id,
    action: "create",
    performedBy: dbUser.id,
    changes: {
      record: {
        old: null,
        new: {
          case_id: caseId,
          invoice_number: invoice.invoice_number,
          title: description,
          total_amount: total,
          billed_to: `${party.source}: ${party.name}`,
          bill_to_override: billClientOverride || null,
        },
      },
    },
  });

  return NextResponse.json({
    data: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      subtotal,
      total,
      buyerName: party.name,
      billTo: party.source === "case-aggregator" ? "aggregator" : "client",
    },
  }, { status: 201 });
}
