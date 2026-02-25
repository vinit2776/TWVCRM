import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS } from "@/lib/constants";

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

  const { data, error } = await supabase
    .from("purchase_requests")
    .select(
      `*, locations(id, name), requester:users!purchase_requests_requested_by_fkey(id, full_name, email), approver:users!purchase_requests_approved_by_fkey(id, full_name, email), purchase_request_items(*, procurement_items(id, name, department, unit))`
    )
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  // Non-manager/admin can only view their own PRs
  if (!["admin", "manager"].includes(dbUser.role) && data.requested_by !== dbUser.id) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  return NextResponse.json({ data });
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

  // Fetch the current PR
  const { data: pr, error: fetchError } = await supabase
    .from("purchase_requests")
    .select("*")
    .eq("id", id)
    .single();

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
      // Must be the requester
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
      // Requester or admin/manager can cancel
      if (pr.requested_by !== dbUser.id && !["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      updatePayload = { status: "cancelled" };
      break;
    }

    case "approve": {
      if (pr.status !== "submitted") {
        return NextResponse.json({ error: "Only submitted PRs can be approved" }, { status: 422 });
      }
      // Check approval tier
      const requiresAdmin = pr.total_estimated_amount > PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE;
      if (requiresAdmin && dbUser.role !== "admin") {
        return NextResponse.json({
          error: `PRs above ₹${PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE.toLocaleString()} require admin approval`,
        }, { status: 403 });
      }
      if (!["admin", "manager"].includes(dbUser.role)) {
        return NextResponse.json({ error: "Only managers and admins can approve PRs" }, { status: 403 });
      }
      updatePayload = {
        status: "approved",
        approved_by: dbUser.id,
        approved_at: new Date().toISOString(),
        rejection_reason: null,
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
  });

  return NextResponse.json({ data: updated });
}
