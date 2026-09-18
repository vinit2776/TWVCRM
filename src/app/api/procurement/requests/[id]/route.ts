import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges, logView } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS, PROCUREMENT_DEPARTMENTS, MR_EDITABLE_STATUSES, ITEM_UNITS, CENTER_SCOPED_DEPARTMENTS } from "@/lib/constants";
import { computeOrderedQtyMap } from "@/lib/procurement/pr-status";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";

const patchPrSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("approve"),
    notes: z.string().optional(),
    // Admin-only escape hatch for repeat / pre-approved orders where a fresh
    // vendor quotation adds no value. Mirrors payment_override_reason on contracts.
    quotation_override_reason: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("reject"),
    rejection_reason: z.string().min(1, "Rejection reason is required"),
  }),
  z.object({
    action: z.literal("resubmit"),
    /**
     * Optional price-only edits applied before resubmitting. Item identity (item_id,
     * quantity, unit, notes) is locked — only `estimated_price` can change. Used to
     * correct GST-inclusive prices that triggered the rejection in the first place.
     */
    line_items: z
      .array(
        z.object({
          id: z.string().uuid(),
          estimated_price: z.number().min(0, "Price cannot be negative"),
        })
      )
      .optional(),
  }),
  z.object({
    action: z.literal("correct_department"),
    department: z.enum(PROCUREMENT_DEPARTMENTS),
    billable_contract_id: z.string().uuid().optional().nullable(),
    reason: z.string().min(1, "Reason is required"),
  }),
]);

/**
 * Full pre-approval edit payload. Mirrors createPrSchema on POST /requests so the
 * same form can create and edit, minus `submit` (PUT never changes status).
 */
const editPrItemSchema = z.object({
  item_id: z.string().uuid().optional().nullable(),
  item_name: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.enum(ITEM_UNITS),
  estimated_price: z.number().min(0).optional().nullable(),
  notes: z.string().optional(),
});

const editPrSchema = z.object({
  department: z.enum(PROCUREMENT_DEPARTMENTS),
  location_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional(),
  expenditure_type: z.enum(["operational", "amc"]).default("operational"),
  items: z.array(editPrItemSchema).min(1, "At least one item is required"),

  billable_contract_id: z.string().uuid().optional().nullable(),

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
}).refine(
  (data) => !(CENTER_SCOPED_DEPARTMENTS as readonly string[]).includes(data.department) || !!data.location_id,
  {
    message: "Select which center this request is for",
    path: ["location_id"],
  }
);

/** AMC-only columns — always rewritten on edit so switching away from AMC clears them. */
const AMC_FIELDS = [
  "service_item_name", "linked_asset_id", "amc_coverage_type", "amc_start_date",
  "amc_end_date", "amc_visits_covered", "amc_contact_name", "amc_helpline_number",
  "amc_contact_email", "amc_escalation_name", "amc_escalation_phone",
  "amc_escalation2_name", "amc_escalation2_phone", "advance_amount",
  "advance_payment_mode", "advance_notes",
] as const;

/** Read approval threshold from app_settings, fall back to constant. */
async function getApprovalThreshold(supabase: Awaited<ReturnType<typeof createClient>>): Promise<number> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "procurement_approval_threshold")
    .maybeSingle();
  if (data?.value) {
    const parsed = parseInt(data.value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE;
}

/** Generate next signed approval code for PRs */
async function generateApprovalCode(supabase: Awaited<ReturnType<typeof createClient>>, entityId: string): Promise<string> {
  const { count } = await supabase
    .from("purchase_requests")
    .select("*", { count: "exact", head: true })
    .not("approval_code", "is", null);
  return generateSignedApprovalCode("pr", (count ?? 0) + 1, entityId);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const [{ data, error }, approvalThreshold] = await Promise.all([
    supabase
      .from("purchase_requests")
      .select(
        `*, locations(id, name), companies(id, name, brand_name), requester:users!purchase_requests_requested_by_fkey(id, full_name, email), approver:users!purchase_requests_approved_by_fkey(id, full_name, email), purchase_request_items(*, procurement_items(id, name, department, unit, description, gst_rate, standard_price)), material_request_quotations(id, vendor_name, amount, file_name, file_mime_type, notes, created_at, uploaded_by), linked_asset:facility_assets!linked_asset_id(id, name, asset_code), billable_contract:contracts!billable_contract_id(id, contract_number, tax_percentage, billing_mode, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)), reimbursement_statements:billing_statements!source_pr_id(id, statement_number, status, total_amount, voided_at, created_at, gst_invoice_number, supporting_documents:reimbursement_supporting_documents(id))`
      )
      .eq("id", id)
      .single(),
    getApprovalThreshold(supabase),
  ]);

  if (error || !data) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  // Only procurement roles can access
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Compute already_ordered_qty and remaining_qty per PR item
  // Uses computeOrderedQtyMap so that cancelled POs contribute 0 qty
  const prItemIds = (data.purchase_request_items ?? []).map((i: { id: string }) => i.id);
  if (prItemIds.length > 0) {
    const orderedMap = await computeOrderedQtyMap(supabase, prItemIds);

    data.purchase_request_items = data.purchase_request_items!.map(
      (item: { id: string; quantity: number; [key: string]: unknown }) => ({
        ...item,
        already_ordered_qty: orderedMap[item.id] ?? 0,
        remaining_qty: Number(item.quantity) - (orderedMap[item.id] ?? 0),
      })
    );
  }

  await logView(supabase, { entityType: "purchase_request", entityId: id, performedBy: dbUser.id });

  return NextResponse.json({ data, approval_threshold: approvalThreshold });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Fetch the current PR + threshold in parallel
  const [{ data: pr, error: fetchError }, approvalThreshold] = await Promise.all([
    supabase.from("purchase_requests").select("*").eq("id", id).single(),
    getApprovalThreshold(supabase),
  ]);

  if (fetchError || !pr) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  const body = await request.json();
  const parsed = patchPrSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { action } = parsed.data;
  let updatePayload: Record<string, unknown> = {};

  switch (action) {
    case "submit": {
      if (pr.status !== "draft") {
        return NextResponse.json({ error: "Only draft PRs can be submitted" }, { status: 422 });
      }
      if (pr.requested_by !== dbUser.id) {
        return NextResponse.json({ error: "Only the requester can submit this PR" }, { status: 403 });
      }
      updatePayload = { status: "submitted" };
      break;
    }

    case "cancel": {
      if (!["draft", "submitted"].includes(pr.status)) {
        return NextResponse.json({ error: "Only draft or submitted PRs can be cancelled" }, { status: 422 });
      }
      if (pr.requested_by !== dbUser.id && !["admin", "manager", "office_admin"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      updatePayload = { status: "cancelled" };
      break;
    }

    case "approve": {
      if (pr.status !== "submitted") {
        return NextResponse.json({ error: "Only submitted PRs can be approved" }, { status: 422 });
      }
      const requiresAdmin = pr.total_estimated_amount > approvalThreshold;
      if (requiresAdmin && dbUser.role !== "admin") {
        return NextResponse.json({
          error: `PRs above ₹${approvalThreshold.toLocaleString()} require admin approval`,
        }, { status: 403 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only managers and admins can approve PRs" }, { status: 403 });
      }
      // ── Budget enforcement ───────────────────────────────────────────
      // For managers: block approval if spend would exceed the budget.
      // AMC MRs check against the annual FY AMC budget.
      // Operational MRs check against the department's monthly budget.
      // Admins can always approve regardless of budget.
      // Reimbursement spend is recovered from the customer, not drawn from any
      // department's allocated budget — it never has a department_budgets row
      // and is exempt from this gate entirely, for managers and admins alike.
      if (dbUser.role === "manager" && pr.department !== "reimbursement") {
        if (pr.expenditure_type === "amc") {
          // AMC: check annual FY budget (committed spend only — approved and beyond)
          const now = new Date();
          const currentFY = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
          const fyStart = new Date(currentFY, 3, 1).toISOString();
          const fyEnd = new Date(currentFY + 1, 2, 31, 23, 59, 59).toISOString();

          const { data: amcBudget } = await supabase
            .from("department_budgets")
            .select("monthly_budget, is_active")
            .eq("department", "amc")
            .eq("budget_period", "annual")
            .eq("financial_year", currentFY)
            .is("location_id", null)
            .maybeSingle();

          if (amcBudget?.is_active && amcBudget.monthly_budget) {
            const annualBudget = Number(amcBudget.monthly_budget);

            const { data: committedMrs, error: committedMrsError } = await supabase
              .from("purchase_requests")
              .select("total_estimated_amount")
              .eq("expenditure_type", "amc")
              .gte("created_at", fyStart)
              .lte("created_at", fyEnd)
              .in("status", ["approved", "partially_ordered", "po_created"])
              .neq("id", id);
            if (committedMrsError) console.error("[procurement approve] AMC committed spend query failed:", committedMrsError.message);

            const committedSoFar = (committedMrs ?? []).reduce(
              (sum, mr) => sum + Number(mr.total_estimated_amount ?? 0), 0
            );
            const projectedTotal = committedSoFar + Number(pr.total_estimated_amount ?? 0);

            if (projectedTotal > annualBudget) {
              const overBy = projectedTotal - annualBudget;
              const fyLabel = `FY ${currentFY}-${String(currentFY + 1).slice(-2)}`;
              return NextResponse.json({
                error: `AMC annual budget exceeded — manager approval not permitted. ` +
                  `${fyLabel} AMC budget: ₹${annualBudget.toLocaleString("en-IN")}. ` +
                  `Already committed: ₹${committedSoFar.toLocaleString("en-IN")}. ` +
                  `This MR: ₹${Number(pr.total_estimated_amount).toLocaleString("en-IN")}. ` +
                  `Would exceed budget by ₹${overBy.toLocaleString("en-IN")}. ` +
                  `Only admin can approve over-budget AMC requests.`,
                budget_exceeded: true,
                budget_type: "annual",
                annual_budget: annualBudget,
                committed_so_far: committedSoFar,
                this_mr: Number(pr.total_estimated_amount ?? 0),
                over_by: overBy,
              }, { status: 403 });
            }
          }
        } else {
          // Operational: check monthly department budget
          const now = new Date();
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
          const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

          const { data: budget } = await supabase
            .from("department_budgets")
            .select("monthly_budget, is_active")
            .eq("department", pr.department)
            .eq("budget_period", "monthly")
            .is("location_id", null)
            .maybeSingle();

          if (budget?.is_active && budget.monthly_budget) {
            const monthlyBudget = Number(budget.monthly_budget);

            const { data: existingMrs, error: existingMrsError } = await supabase
              .from("purchase_requests")
              .select("total_estimated_amount")
              .eq("department", pr.department)
              .eq("expenditure_type", "operational")
              .gte("created_at", monthStart)
              .lte("created_at", monthEnd)
              .in("status", ["approved", "partially_ordered", "po_created"])
              .neq("id", id);
            if (existingMrsError) console.error("[procurement approve] operational committed spend query failed:", existingMrsError.message);

            const spentSoFar = (existingMrs ?? []).reduce(
              (sum, mr) => sum + Number(mr.total_estimated_amount ?? 0), 0
            );
            const projectedTotal = spentSoFar + Number(pr.total_estimated_amount ?? 0);

            if (projectedTotal > monthlyBudget) {
              const overBy = projectedTotal - monthlyBudget;
              return NextResponse.json({
                error: `Department budget exceeded — manager approval not permitted. ` +
                  `Monthly budget for ${pr.department}: ₹${monthlyBudget.toLocaleString("en-IN")}. ` +
                  `Already spent: ₹${spentSoFar.toLocaleString("en-IN")}. ` +
                  `This MR: ₹${Number(pr.total_estimated_amount).toLocaleString("en-IN")}. ` +
                  `Would exceed budget by ₹${overBy.toLocaleString("en-IN")}. ` +
                  `Only admin can approve over-budget requests.`,
                budget_exceeded: true,
                budget_type: "monthly",
                monthly_budget: monthlyBudget,
                spent_so_far: spentSoFar,
                this_mr: Number(pr.total_estimated_amount ?? 0),
                over_by: overBy,
              }, { status: 403 });
            }
          }

          // Center budget — additional cap on top of the company-wide one
          // above, for departments purchased centrally and distributed to
          // individual centers. Only applies when the MR carries a center.
          if (pr.location_id && (CENTER_SCOPED_DEPARTMENTS as readonly string[]).includes(pr.department)) {
            const { data: centerBudget } = await supabase
              .from("department_budgets")
              .select("monthly_budget, is_active")
              .eq("department", pr.department)
              .eq("budget_period", "monthly")
              .eq("location_id", pr.location_id)
              .maybeSingle();

            if (centerBudget?.is_active && centerBudget.monthly_budget) {
              const centerMonthlyBudget = Number(centerBudget.monthly_budget);

              const { data: centerMrs, error: centerMrsError } = await supabase
                .from("purchase_requests")
                .select("total_estimated_amount")
                .eq("department", pr.department)
                .eq("location_id", pr.location_id)
                .eq("expenditure_type", "operational")
                .gte("created_at", monthStart)
                .lte("created_at", monthEnd)
                .in("status", ["approved", "partially_ordered", "po_created"])
                .neq("id", id);
              if (centerMrsError) console.error("[procurement approve] center committed spend query failed:", centerMrsError.message);

              const centerSpentSoFar = (centerMrs ?? []).reduce(
                (sum, mr) => sum + Number(mr.total_estimated_amount ?? 0), 0
              );
              const centerProjectedTotal = centerSpentSoFar + Number(pr.total_estimated_amount ?? 0);

              if (centerProjectedTotal > centerMonthlyBudget) {
                const overBy = centerProjectedTotal - centerMonthlyBudget;
                const { data: location } = await supabase.from("locations").select("name").eq("id", pr.location_id).maybeSingle();
                return NextResponse.json({
                  error: `Center budget exceeded — manager approval not permitted. ` +
                    `Monthly budget for ${pr.department} at ${location?.name ?? "this center"}: ₹${centerMonthlyBudget.toLocaleString("en-IN")}. ` +
                    `Already spent: ₹${centerSpentSoFar.toLocaleString("en-IN")}. ` +
                    `This MR: ₹${Number(pr.total_estimated_amount).toLocaleString("en-IN")}. ` +
                    `Would exceed budget by ₹${overBy.toLocaleString("en-IN")}. ` +
                    `Only admin can approve over-budget requests.`,
                  budget_exceeded: true,
                  budget_type: "monthly_center",
                  monthly_budget: centerMonthlyBudget,
                  spent_so_far: centerSpentSoFar,
                  this_mr: Number(pr.total_estimated_amount ?? 0),
                  over_by: overBy,
                }, { status: 403 });
              }
            }
          }
        }
      }
      // ── End budget enforcement ────────────────────────────────────────
      const approvalCode = await generateApprovalCode(supabase, id);
      updatePayload = {
        status: "approved",
        approved_by: dbUser.id,
        approved_at: new Date().toISOString(),
        rejection_reason: null,
        approval_code: approvalCode,
      };
      break;
    }

    case "reject": {
      if (pr.status !== "submitted") {
        return NextResponse.json({ error: "Only submitted PRs can be rejected" }, { status: 422 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only managers and admins can reject PRs" }, { status: 403 });
      }
      updatePayload = {
        status: "rejected",
        approved_by: dbUser.id,
        approved_at: new Date().toISOString(),
        rejection_reason: parsed.data.rejection_reason,
      };
      break;
    }

    case "resubmit": {
      if (pr.status !== "rejected") {
        return NextResponse.json({ error: "Only rejected PRs can be resubmitted" }, { status: 422 });
      }
      // Any procurement role can edit + resubmit a rejected MR (no requester-only gate).
      // Apply price-only edits to line items if provided.
      const priceEdits = parsed.data.line_items ?? [];
      if (priceEdits.length > 0) {
        // Validate edits target items actually belonging to this PR.
        const { data: existingItems } = await supabase
          .from("purchase_request_items")
          .select("id, quantity")
          .eq("pr_id", id);
        const itemsById = new Map((existingItems ?? []).map((it) => [it.id as string, it]));
        for (const edit of priceEdits) {
          if (!itemsById.has(edit.id)) {
            return NextResponse.json(
              { error: `Line item ${edit.id} does not belong to this MR` },
              { status: 422 }
            );
          }
        }
        // Apply: update each row's estimated_price + recompute its total_estimated.
        for (const edit of priceEdits) {
          const qty = Number(itemsById.get(edit.id)!.quantity ?? 0);
          const price = Math.round(edit.estimated_price * 100) / 100;
          await supabase
            .from("purchase_request_items")
            .update({
              estimated_price: price,
              total_estimated: Math.round(price * qty * 100) / 100,
            })
            .eq("id", edit.id);
        }
        // Re-derive the parent's total_estimated_amount from the freshly-saved item rows.
        const { data: refreshedItems } = await supabase
          .from("purchase_request_items")
          .select("total_estimated")
          .eq("pr_id", id);
        const newTotal = (refreshedItems ?? []).reduce(
          (sum, row) => sum + Number(row.total_estimated ?? 0),
          0
        );
        updatePayload = {
          status: "submitted",
          rejection_reason: null,
          approved_by: null,
          approved_at: null,
          total_estimated_amount: Math.round(newTotal * 100) / 100,
        };
      } else {
        updatePayload = {
          status: "submitted",
          rejection_reason: null,
          approved_by: null,
          approved_at: null,
        };
      }
      break;
    }

    case "correct_department": {
      // Admin-only escape hatch for MRs filed under the wrong department (a real
      // recurring mistake around the reimbursement flow — see PR-2607-146/147).
      // Never editable by requesters/managers since it can redirect spend into or
      // out of a customer-billed bucket. Status is otherwise untouched: no
      // re-approval, no PO/bill impact.
      if (dbUser.role !== "admin") {
        return NextResponse.json({ error: "Only admins can correct an MR's department" }, { status: 403 });
      }
      if (["cancelled", "rejected"].includes(pr.status)) {
        return NextResponse.json({ error: "Cannot correct department on a cancelled or rejected MR" }, { status: 422 });
      }
      const newDepartment = parsed.data.department;
      if (newDepartment === pr.department) {
        return NextResponse.json({ error: "MR is already in that department" }, { status: 422 });
      }
      if (newDepartment === "reimbursement") {
        if (!parsed.data.billable_contract_id) {
          return NextResponse.json(
            { error: "Select which customer's contract this will be billed to" },
            { status: 422 }
          );
        }
        const { data: contract } = await supabase
          .from("contracts")
          .select("id")
          .eq("id", parsed.data.billable_contract_id)
          .maybeSingle();
        if (!contract) {
          return NextResponse.json({ error: "Linked contract not found" }, { status: 404 });
        }
      }
      // Moving away from reimbursement must not orphan invoices already issued to the customer.
      if (pr.department === "reimbursement" && newDepartment !== "reimbursement") {
        const { count: activeStatements } = await supabase
          .from("billing_statements")
          .select("*", { count: "exact", head: true })
          .eq("source_pr_id", id)
          .is("voided_at", null);
        if (activeStatements && activeStatements > 0) {
          return NextResponse.json({
            error: "This MR already has reimbursement invoice(s) issued to the customer. Void them first before changing the department.",
          }, { status: 422 });
        }
      }
      updatePayload = {
        department: newDepartment,
        billable_contract_id: newDepartment === "reimbursement" ? parsed.data.billable_contract_id : null,
      };
      break;
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_requests")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  const auditChanges = diffChanges(pr as Record<string, unknown>, { ...pr, ...updatePayload } as Record<string, unknown>);
  if (action === "approve" && parsed.data.quotation_override_reason) {
    auditChanges["quotation_override_reason"] = { old: null, new: parsed.data.quotation_override_reason };
  }
  if (action === "correct_department") {
    auditChanges["correction_reason"] = { old: null, new: parsed.data.reason };
  }
  await logAudit(supabase, {
    entityType: "purchase_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: auditChanges,
  });

  return NextResponse.json({ data: updated });
}

/**
 * Full edit of a not-yet-approved MR — every field the create form captures.
 *
 * Mistakes at filing time (wrong department, wrong quantity, wrong item) used to be
 * uncorrectable: only an admin could fix the department, and only prices could be
 * touched, on rejected MRs alone. This lets whoever raised it fix it in place.
 *
 * Deliberate boundaries:
 *  - Only `draft` / `submitted` / `rejected` MRs. Once approved, budgets and POs are
 *    derived from the MR and editing it would silently change committed spend.
 *  - Status is never changed here. A submitted MR stays in the approval queue with
 *    the corrected values; the requester doesn't have to re-submit.
 *  - Moving into or out of `reimbursement` stays admin-only, same as the
 *    `correct_department` action — it redirects spend into or out of a
 *    customer-billed bucket.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: pr, error: fetchError } = await supabase
    .from("purchase_requests")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchError || !pr) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  if (!MR_EDITABLE_STATUSES.includes(pr.status)) {
    return NextResponse.json(
      {
        error:
          "Only material requests that haven't been approved yet can be edited. " +
          "An admin can still correct the department on an approved MR.",
      },
      { status: 422 }
    );
  }

  const body = await request.json();
  const parsed = editPrSchema.safeParse(body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const msg = Object.entries(flat.fieldErrors)
      .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
      .join("; ");
    return NextResponse.json({ error: msg || "Invalid request data" }, { status: 400 });
  }

  const { items, ...prData } = parsed.data;
  const newDepartment = prData.department;
  const crossesReimbursement =
    newDepartment !== pr.department &&
    (newDepartment === "reimbursement" || pr.department === "reimbursement");

  if (crossesReimbursement && dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can move a material request into or out of Reimbursement" },
      { status: 403 }
    );
  }

  if (newDepartment === "reimbursement") {
    const { data: contract } = await supabase
      .from("contracts")
      .select("id")
      .eq("id", prData.billable_contract_id!)
      .maybeSingle();
    if (!contract) {
      return NextResponse.json({ error: "Linked contract not found" }, { status: 404 });
    }
  }

  // Moving away from reimbursement must not orphan invoices already issued to the customer.
  if (pr.department === "reimbursement" && newDepartment !== "reimbursement") {
    const { count: activeStatements } = await supabase
      .from("billing_statements")
      .select("*", { count: "exact", head: true })
      .eq("source_pr_id", id)
      .is("voided_at", null);
    if (activeStatements && activeStatements > 0) {
      return NextResponse.json({
        error:
          "This MR already has reimbursement invoice(s) issued to the customer. Void them first before changing the department.",
      }, { status: 422 });
    }
  }

  // Line items are replaced wholesale, so make sure none of them are already
  // referenced by a PO. Pre-approval MRs can't have POs, but the FK would fail
  // with an opaque database error rather than something the user can act on.
  const { data: existingItems } = await supabase
    .from("purchase_request_items")
    .select("id")
    .eq("pr_id", id);
  const existingItemIds = (existingItems ?? []).map((it) => it.id as string);
  if (existingItemIds.length > 0) {
    const { count: linkedPoItems } = await supabase
      .from("purchase_order_items")
      .select("*", { count: "exact", head: true })
      .in("pr_item_id", existingItemIds);
    if (linkedPoItems && linkedPoItems > 0) {
      return NextResponse.json(
        { error: "This MR's items are already on a purchase order and can no longer be edited" },
        { status: 422 }
      );
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const totalEstimated = round2(
    items.reduce((sum, item) => sum + (item.estimated_price ? item.quantity * item.estimated_price : 0), 0)
  );

  // Insert the replacement rows before deleting the old ones — a failed insert
  // then leaves the MR untouched rather than itemless.
  const { data: insertedItems, error: insertError } = await supabase
    .from("purchase_request_items")
    .insert(
      items.map((item) => ({
        pr_id: id,
        item_id: item.item_id || null,
        item_name: item.item_name,
        quantity: item.quantity,
        unit: item.unit,
        estimated_price: item.estimated_price ?? null,
        total_estimated: item.estimated_price ? round2(item.quantity * item.estimated_price) : null,
        notes: item.notes || null,
      }))
    )
    .select("id");
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  if (existingItemIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("purchase_request_items")
      .delete()
      .in("id", existingItemIds);
    if (deleteError) {
      // Roll back the rows we just added so the MR isn't left with both sets.
      await supabase
        .from("purchase_request_items")
        .delete()
        .in("id", (insertedItems ?? []).map((it) => it.id as string));
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
  }

  const isAmc = newDepartment === "amc";
  const updatePayload: Record<string, unknown> = {
    department: newDepartment,
    location_id: prData.location_id || null,
    notes: prData.notes || null,
    // Derived server-side rather than trusted from the client — the two must never drift.
    expenditure_type: isAmc ? "amc" : "operational",
    billable_contract_id: newDepartment === "reimbursement" ? prData.billable_contract_id : null,
    total_estimated_amount: totalEstimated,
  };
  // Rewrite every AMC column each time so switching away from AMC clears stale values.
  for (const field of AMC_FIELDS) {
    const value = prData[field];
    updatePayload[field] = isAmc && value !== undefined && value !== "" ? value : null;
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_requests")
    .update(updatePayload)
    .eq("id", id)
    .select("*")
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  const auditChanges = diffChanges(
    pr as Record<string, unknown>,
    { ...pr, ...updatePayload } as Record<string, unknown>
  );
  auditChanges["line_items"] = { old: `${existingItemIds.length} item(s)`, new: `${items.length} item(s)` };
  await logAudit(supabase, {
    entityType: "purchase_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: auditChanges,
  });

  return NextResponse.json({ data: updated });
}
