import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  computeAdhocCharge,
  createAdhocCharge,
  AdhocChargeError,
  type AdhocChargeCase,
} from "@/lib/case-adhoc-charge";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";

const ALLOWED_ROLES = ["admin", "manager", "accounts", "sales_rep"];

const CASE_SELECT =
  "id, case_number, case_source, bill_to, client_name, client_company_name, " +
  "client_gst_number, aggregator_id, billing_mode, " +
  "aggregator:aggregators!cases_aggregator_id_fkey(name, gst_number, same_state_as_twv, billing_method, billing_mode)";

/**
 * GET  /api/cases/[id]/adhoc-charges — list them, plus who a new one would bill.
 * POST /api/cases/[id]/adhoc-charges — raise one.
 *
 * Ad-hoc is any additional billing on the case, as required. The licence fee
 * (vo_case) and the renewal (vo_renewal) have their own paths and must not be
 * duplicated here — a charge existing twice with two payment links is how a
 * customer ends up paying the same thing twice.
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

  const { data: caseRow } = await adminSupabase
    .from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const { data: charges } = await adminSupabase
    .from("billing_statements")
    .select("id, statement_number, total_amount, subtotal, payment_status, status, handoff_state, line_items, created_at, voided_at, buyer_gstin")
    .eq("case_id", caseId)
    .eq("statement_type", "vo_adhoc")
    .order("created_at", { ascending: false });

  // A nominal amount just to resolve the buyer for the form — the real amount
  // comes from the operator.
  let routing = null;
  try {
    routing = computeAdhocCharge(caseRow as unknown as AdhocChargeCase, {
      description: "preview",
      amount: 1,
    });
  } catch {
    routing = null; // blocked (e.g. prepaid with no bill_to) — reported on POST
  }

  return NextResponse.json({
    data: {
      charges: charges ?? [],
      billsTo: routing
        ? { kind: routing.billTo, name: routing.buyerName, gstin: routing.buyerGstin }
        : null,
      endClientName: routing?.endClientName ?? null,
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
    return NextResponse.json({ error: "Not authorized to raise ad-hoc charges" }, { status: 403 });
  }

  const adminSupabase = await createAdminClient();
  const { data: caseRaw } = await adminSupabase
    .from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  if (!caseRaw) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  // Supabase infers row types from a literal select; CASE_SELECT is composed,
  // so the row comes back untyped.
  const caseRow = caseRaw as unknown as AdhocChargeCase & {
    billing_mode?: string | null;
    aggregator: (AdhocChargeCase["aggregator"] & { billing_mode?: string | null }) | null;
  };

  try {
    const { statementId, preview } = await createAdhocCharge(
      adminSupabase,
      caseRow,
      {
        description: body.description ?? "",
        amount: Number(body.amount),
        notes: body.notes ?? null,
        billToOverride: body.bill_to_override ?? null,
      },
    );

    // Route it into the Tally handoff exactly as the case invoice does, so it
    // reaches accounts through the pipeline they already work from.
    const billingMode: "proforma_first" | "gst_direct" =
      caseRow.case_source === "aggregator"
        ? (caseRow.aggregator?.billing_mode === "proforma_first" ? "proforma_first" : "gst_direct")
        : (caseRow.billing_mode === "gst_direct" ? "gst_direct" : "proforma_first");

    await handleStatementFinalized(adminSupabase, statementId, billingMode, "vo_adhoc_charge");

    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: statementId,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        record: {
          old: null,
          new: {
            case_id: caseId,
            statement_type: "vo_adhoc",
            description: body.description,
            total_amount: preview.total,
            billed_to: `${preview.billTo}: ${preview.buyerName}`,
            bill_to_override: body.bill_to_override ?? null,
          },
        },
      },
    });

    return NextResponse.json({ data: { statementId, ...preview } }, { status: 201 });
  } catch (err) {
    if (err instanceof AdhocChargeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[adhoc-charges] failed for case ${caseId}:`, err);
    return NextResponse.json({ error: "Failed to raise the charge" }, { status: 500 });
  }
}
