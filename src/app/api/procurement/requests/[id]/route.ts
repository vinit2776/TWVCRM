import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS } from "@/lib/constants";
import { computeOrderedQtyMap } from "@/lib/procurement/pr-status";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";

const patchPrSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("approve"),
    notes: z.string().optional(),
  }),
  z.object({
    action: z.literal("reject"),
    rejection_reason: z.string().min(1, "Rejection reason is required"),
  }),
  z.object({
    action: z.literal("resubmit"),
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
        `*, locations(id, name), requester:users!purchase_requests_requested_by_fkey(id, full_name, email), approver:users!purchase_requests_approved_by_fkey(id, full_name, email), purchase_request_items(*, procurement_items(id, name, department, unit, description, gst_rate))`
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
      // If a monthly budget is set for this department and approver is a manager,
      // check whether this MR would push spend over the budget.
      // If so: only admin can approve.
      if (dbUser.role === "manager") {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

        const { data: budget } = await supabase
          .from("department_budgets")
          .select("monthly_budget, is_active")
          .eq("department", pr.department)
          .is("location_id", null)
          .maybeSingle();

        if (budget?.is_active && budget.monthly_budget) {
          const monthlyBudget = Number(budget.monthly_budget);

          const { data: existingMrs } = await supabase
            .from("purchase_requests")
            .select("total_estimated_amount")
            .eq("department", pr.department)
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
              monthly_budget: monthlyBudget,
              spent_so_far: spentSoFar,
              this_mr: Number(pr.total_estimated_amount ?? 0),
              over_by: overBy,
            }, { status: 403 });
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
      if (pr.requested_by !== dbUser.id) {
        return NextResponse.json({ error: "Only the requester can resubmit this PR" }, { status: 403 });
      }
      updatePayload = {
        status: "submitted",
        rejection_reason: null,
        approved_by: null,
        approved_at: null,
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

  await logAudit(supabase, {
    entityType: "purchase_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: diffChanges(pr as Record<string, unknown>, { ...pr, ...updatePayload } as Record<string, unknown>),
  });

  return NextResponse.json({ data: updated });
}
