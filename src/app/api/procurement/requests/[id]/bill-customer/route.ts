import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { computeGstAndRounding } from "@/lib/gst-math";
import { IMAGE_MIME_TYPES, PDF_MIME_TYPE } from "@/lib/uploads/normalize-upload-server";
import { z } from "zod";

const billCustomerSchema = z.object({
  items: z
    .array(
      z.object({
        description: z.string().min(1, "Description is required"),
        quantity: z.number().positive(),
        unit_price: z.number().min(0),
      })
    )
    .min(1, "At least one line item is required"),
  notes: z.string().optional(),
  // Customer-facing proof (receipts, vendor bills) already uploaded directly to
  // storage via /api/documents/upload-url — this route only persists the metadata.
  // Required, not optional: every reimbursement statement this route creates
  // must be able to show the customer what they're being charged for — the
  // GST invoice upload flow merges these into the invoice PDF automatically.
  supportingDocuments: z
    .array(
      z.object({
        filePath: z.string().min(1),
        fileName: z.string().min(1),
        mimeType: z.string().min(1),
      })
    )
    .min(1, "At least one supporting document (receipt or vendor bill) is required to bill a reimbursement to the customer.")
    .max(10),
});

/**
 * POST /api/procurement/requests/[id]/bill-customer
 *
 * Bills the customer for reimbursement work — manually marked-up, no formula.
 * Creates a billing_statements row (statement_type='reimbursement') backed by
 * real usage_charges rows (so GST/subtotal math in dispatchProforma /
 * dispatchGstDirect — which sums fixed_amount + a live usage_charges join —
 * comes out correct; it does NOT read line_items for the dollar totals, only
 * for PDF rendering, and falls back to the same usage_charges join when
 * line_items is empty). Available any time after MR approval, and can be
 * called multiple times against the same PR (e.g. an upfront advance now,
 * balance once the job is done) — each call creates its own statement.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only accounts, managers, or admins can bill a customer" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = billCustomerSchema.safeParse(body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const msg = Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ");
    return NextResponse.json({ error: msg || "Invalid request data" }, { status: 400 });
  }

  const { data: pr, error: prError } = await supabase
    .from("purchase_requests")
    .select("id, pr_number, department, approved_at, billable_contract_id")
    .eq("id", id)
    .single();
  if (prError || !pr) return NextResponse.json({ error: "Purchase request not found" }, { status: 404 });

  if (pr.department !== "reimbursement") {
    return NextResponse.json({ error: "Only reimbursement requests can be billed to a customer" }, { status: 422 });
  }
  if (!pr.approved_at) {
    return NextResponse.json({ error: "This request must be approved before billing the customer" }, { status: 422 });
  }
  if (!pr.billable_contract_id) {
    return NextResponse.json({ error: "This request has no billable contract linked" }, { status: 422 });
  }

  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id, lead_id, tax_percentage")
    .eq("id", pr.billable_contract_id)
    .single();
  if (contractError || !contract) {
    return NextResponse.json({ error: "Linked contract not found" }, { status: 404 });
  }

  const items = parsed.data.items.map((item) => ({
    ...item,
    total: Math.round(item.quantity * item.unit_price * 100) / 100,
  }));
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  if (subtotal <= 0) {
    return NextResponse.json({ error: "Total amount must be greater than zero" }, { status: 422 });
  }

  const supportingDocuments = parsed.data.supportingDocuments ?? [];
  for (const doc of supportingDocuments) {
    if (!IMAGE_MIME_TYPES.has(doc.mimeType) && doc.mimeType !== PDF_MIME_TYPE) {
      return NextResponse.json(
        { error: `Unsupported supporting document type: ${doc.mimeType}` },
        { status: 400 }
      );
    }
  }

  const taxPercentage = Number(contract.tax_percentage || 0);
  const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);

  const today = new Date().toISOString().slice(0, 10);

  const { data: statement, error: statementError } = await supabase
    .from("billing_statements")
    .insert({
      contract_id: contract.id,
      lead_id: contract.lead_id,
      period_start: today,
      period_end: today,
      fixed_amount: 0,
      usage_amount: subtotal,
      subtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      total_amount: totalAmount,
      status: "draft",
      statement_type: "reimbursement",
      source_pr_id: pr.id,
      notes: parsed.data.notes || `Reimbursement billing for ${pr.pr_number}`,
      created_by: dbUser.id,
    })
    .select("id, statement_number")
    .single();
  if (statementError || !statement) {
    return NextResponse.json({ error: statementError?.message || "Failed to create statement" }, { status: 500 });
  }

  const { error: chargesError } = await supabase.from("usage_charges").insert(
    items.map((item) => ({
      contract_id: contract.id,
      lead_id: contract.lead_id,
      description: item.description,
      quantity: item.quantity,
      billed_quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.total,
      charge_date: today,
      status: "billed",
      billing_statement_id: statement.id,
      notes: `Reimbursement — ${pr.pr_number}`,
      created_by: dbUser.id,
    }))
  );
  if (chargesError) {
    // Roll back the orphaned draft statement rather than leaving a ₹-amount statement with no charges.
    await supabase.from("billing_statements").delete().eq("id", statement.id);
    return NextResponse.json({ error: chargesError.message }, { status: 500 });
  }

  // Supporting documents are supplementary — a failure here must not roll back
  // an otherwise-valid statement/charges. Reported via supportingDocumentsError
  // so the dialog can warn the user without blocking the send.
  let supportingDocumentsError = false;
  if (supportingDocuments.length > 0) {
    const adminSupabase = await createAdminClient();
    const { error: docsError } = await adminSupabase.from("reimbursement_supporting_documents").insert(
      supportingDocuments.map((doc) => ({
        billing_statement_id: statement.id,
        file_path: doc.filePath,
        file_name: doc.fileName,
        file_mime_type: doc.mimeType,
        uploaded_by: dbUser.id,
      }))
    );
    if (docsError) {
      console.error("[bill-customer] Failed to persist supporting documents:", docsError.message);
      supportingDocumentsError = true;
    }
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: statement.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: { statement_type: "reimbursement", source_pr_id: pr.id, total_amount: totalAmount } } },
  });
  logAudit(supabase, {
    entityType: "purchase_request",
    entityId: pr.id,
    action: "update",
    performedBy: dbUser.id,
    changes: { billed_amount: { old: null, new: totalAmount }, statement_id: { old: null, new: statement.id } },
  });

  return NextResponse.json({
    data: {
      id: statement.id,
      statement_number: statement.statement_number,
      subtotal,
      total_amount: totalAmount,
      supportingDocumentsError,
    },
  }, { status: 201 });
}
