import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges, logView } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS, PROCUREMENT_DEPARTMENTS } from "@/lib/constants";
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
        `*, locations(id, name), requester:users!purchase_requests_requested_by_fkey(id, full_name, email), approver:users!purchase_requests_approved_by_fkey(id, full_name, email), purchase_request_items(*, procurement_items(id, name, department, unit, description, gst_rate)), material_request_quotations(id, vendor_name, amount, file_name, file_mime_type, notes, created_at, uploaded_by), linked_asset:facility_assets!linked_asset_id(id, name, asset_code), billable_contract:contracts!billable_contract_id(id, contract_number, tax_percentage, billing_mode, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)), reimbursement_statements:billing_statements!source_pr_id(id, statement_number, status, total_amount, voided_at, created_at)`
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

  // Only admins may bypass the vendor-quotation gate
  if ("quotation_override_reason" in parsed.data && parsed.data.quotation_override_reason && dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can override the vendor quotation requirement" },
      { status: 403 }
    );
  }

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
      // Quotation gate: at least one vendor quotation must be attached before approval,
      // unless an admin has supplied an override reason (repeat / pre-approved orders).
      const { count: quotationCount } = await supabase
        .from("material_request_quotations")
        .select("*", { count: "exact", head: true })
        .eq("pr_id", id);
      if ((!quotationCount || quotationCount < 1) && !parsed.data.quotation_override_reason) {
        return NextResponse.json(
          {
            error:
              "At least one vendor quotation / estimate must be attached before this MR can be approved. Ask the requester to upload supporting documents, or have an admin approve with an override reason.",
            quotations_required: true,
          },
          { status: 422 }
        );
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

            const { data: committedMrs } = await supabase
              .from("purchase_requests")
              .select("total_estimated_amount")
              .eq("expenditure_type", "amc")
              .gte("created_at", fyStart)
              .lte("created_at", fyEnd)
              .in("status", ["approved", "partially_ordered", "po_created", "fully_ordered", "closed"])
              .neq("id", id);

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

            const { data: existingMrs } = await supabase
              .from("purchase_requests")
              .select("total_estimated_amount")
              .eq("department", pr.department)
              .eq("expenditure_type", "operational")
              .gte("created_at", monthStart)
              .lte("created_at", monthEnd)
              .not("status", "in", '("cancelled","rejected")')
              .neq("id", id);

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
