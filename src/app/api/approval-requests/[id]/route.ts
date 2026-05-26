import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createUnifiVoucher, getUnifiHotspotSsid } from "@/lib/unifi";

/**
 * PATCH /api/approval-requests/[id]
 *
 * Approve or reject an approval request. Admin only.
 *
 * Body: { action: "approve" } or { action: "reject", rejection_reason: "..." }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // Admins and managers can act on approval requests
  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admins and managers can approve or reject requests" }, { status: 403 });
  }

  const body = await request.json();
  const action = body.action; // "approve" or "reject"

  if (!["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "Invalid action. Use 'approve' or 'reject'." }, { status: 400 });
  }

  if (action === "reject" && !body.rejection_reason?.trim()) {
    return NextResponse.json({ error: "Rejection reason is required" }, { status: 400 });
  }

  // Fetch the approval request
  const admin = createAdminClient();
  const { data: approvalReq, error: fetchErr } = await admin
    .from("approval_requests")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !approvalReq) {
    return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
  }

  if (approvalReq.status !== "pending") {
    return NextResponse.json({
      error: `This request has already been ${approvalReq.status}`,
    }, { status: 400 });
  }

  const now = new Date().toISOString();
  const newStatus = action === "approve" ? "approved" : "rejected";

  // Update the approval request
  const { error: updateErr } = await admin
    .from("approval_requests")
    .update({
      status: newStatus,
      acted_by: dbUser.id,
      acted_at: now,
      rejection_reason: action === "reject" ? body.rejection_reason.trim() : null,
    })
    .eq("id", id);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Handle type-specific side effects

  // ── UniFi ad-hoc voucher ──────────────────────────────────────────────────
  let unifiIssuanceResult: { code: string; unifiId: string; ssid: string | null; durationMinutes: number; quota: number; locationName: string } | null = null;

  if (approvalReq.entity_type === "unifi_adhoc_voucher" && action === "approve") {
    const meta = approvalReq.metadata || {};
    try {
      const [voucherResult, ssid] = await Promise.all([
        createUnifiVoucher({
          durationMinutes: Number(meta.duration_minutes),
          note:            String(meta.note || `adhoc_${approvalReq.id}`),
          quota:           Number(meta.quota ?? 1),
        }),
        getUnifiHotspotSsid(),
      ]);
      const { id: unifiId, code } = voucherResult;

      // Persist code + SSID back onto the request for future reference
      await admin
        .from("approval_requests")
        .update({
          metadata: {
            ...meta,
            issued_code:       code,
            issued_voucher_id: unifiId,
            ssid:              ssid ?? null,
          },
        })
        .eq("id", id);

      logAudit(admin, {
        entityType: "location",
        entityId:   String(meta.location_id || approvalReq.entity_id),
        action:     "create",
        performedBy: dbUser.id,
        changes: {
          type:                { old: null, new: "unifi_adhoc_voucher_issued" },
          code:                { old: null, new: code },
          unifi_voucher_id:    { old: null, new: unifiId },
          ssid:                { old: null, new: ssid },
          approved_by:         { old: null, new: dbUser.full_name },
          approval_request_id: { old: null, new: id },
        },
      });

      unifiIssuanceResult = {
        code,
        unifiId,
        ssid,
        durationMinutes: Number(meta.duration_minutes),
        quota:           Number(meta.quota ?? 1),
        locationName:    String(meta.location_name ?? ""),
      };
    } catch (err) {
      console.error("[approval-requests] UniFi voucher issuance failed after approval:", err);
      await admin
        .from("approval_requests")
        .update({ metadata: { ...(approvalReq.metadata || {}), issuance_error: err instanceof Error ? err.message : String(err) } })
        .eq("id", id);
    }
  }

  if (approvalReq.entity_type === "contract") {
    const contractId = approvalReq.entity_id;

    if (action === "approve") {
      // Mark contract's escalation as approved
      await admin
        .from("contracts")
        .update({ escalation_approval_status: "approved" })
        .eq("id", contractId);

      // If it was a waiver approval, apply the waiver
      if (approvalReq.approval_type === "escalation_waiver") {
        const meta = approvalReq.metadata || {};
        // Fetch the contract and its parent to restore parent prices
        const { data: contract } = await admin
          .from("contracts")
          .select("*, parent:contracts!contracts_parent_contract_id_fkey(id, items, subtotal)")
          .eq("id", contractId)
          .single();

        if (contract?.parent) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parent = contract.parent as any;
          const parentItems = (Array.isArray(parent) ? parent[0]?.items : parent.items) || [];
          const parentSubtotal = Number(Array.isArray(parent) ? parent[0]?.subtotal : parent.subtotal) || 0;

          const taxPercentage = Number(contract.tax_percentage || 18);
          const discountPercentage = Number(contract.discount_percentage || 0);
          const discountAmount = Math.round(parentSubtotal * (discountPercentage / 100) * 100) / 100;
          const taxableAmount = parentSubtotal - discountAmount;
          const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
          const totalAmount = taxableAmount + taxAmount;

          await admin
            .from("contracts")
            .update({
              items: parentItems,
              subtotal: parentSubtotal,
              tax_amount: taxAmount,
              discount_amount: discountAmount,
              total_amount: totalAmount,
              escalation_waived: true,
              escalation_waiver_reason: meta.reason || approvalReq.reason,
              escalation_waived_by: approvalReq.requested_by,
            })
            .eq("id", contractId);
        }
      }

      // If it was a reduction approval, the reduced rate is already set on the draft
      // (it was applied optimistically when the draft was created). Nothing more to do.

    } else {
      // Rejected — revert the contract to default escalation
      await admin
        .from("contracts")
        .update({ escalation_approval_status: "rejected" })
        .eq("id", contractId);

      // For rejections, restore the default escalation rate on the contract
      if (approvalReq.approval_type === "escalation_reduction" || approvalReq.approval_type === "escalation_waiver") {
        const meta = approvalReq.metadata || {};
        const defaultPct = meta.parent_escalation_percentage ?? 10;

        // Fetch contract with parent items to recalculate
        const { data: contract } = await admin
          .from("contracts")
          .select("*, parent:contracts!contracts_parent_contract_id_fkey(id, items, subtotal)")
          .eq("id", contractId)
          .single();

        if (contract?.parent) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parent = contract.parent as any;
          type Item = { description: string; quantity: number; unit_price: number; total: number; unit?: string };
          const parentItems = ((Array.isArray(parent) ? parent[0]?.items : parent.items) || []) as Item[];
          const multiplier = 1 + defaultPct / 100;
          const roundToTen = (n: number) => Math.round(n / 10) * 10;

          const newItems: Item[] = parentItems.map((item) => {
            const newUnitPrice = roundToTen(item.unit_price * multiplier);
            const newTotal = newUnitPrice * item.quantity;
            return { ...item, unit_price: newUnitPrice, total: newTotal };
          });

          const newSubtotal = newItems.reduce((sum, i) => sum + i.total, 0);
          const taxPercentage = Number(contract.tax_percentage || 18);
          const discountPercentage = Number(contract.discount_percentage || 0);
          const discountAmount = Math.round(newSubtotal * (discountPercentage / 100) * 100) / 100;
          const taxableAmount = newSubtotal - discountAmount;
          const taxAmount = Math.round(taxableAmount * (taxPercentage / 100) * 100) / 100;
          const totalAmount = taxableAmount + taxAmount;

          await admin
            .from("contracts")
            .update({
              items: newItems,
              subtotal: newSubtotal,
              tax_amount: taxAmount,
              discount_amount: discountAmount,
              total_amount: totalAmount,
              escalation_percentage: defaultPct,
              escalation_waived: false,
              escalation_waiver_reason: null,
              escalation_waived_by: null,
            })
            .eq("id", contractId);
        }
      }
    }
  }

  // Audit
  logAudit(admin, {
    entityType: "approval_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "pending", new: newStatus },
      ...(action === "reject" ? { rejection_reason: { old: null, new: body.rejection_reason.trim() } } : {}),
    },
  });

  // Build response — include voucher details for UniFi ad-hoc so the UI can show the code
  const baseMessage = approvalReq.entity_type === "unifi_adhoc_voucher"
    ? action === "approve"
      ? unifiIssuanceResult
        ? "Voucher issued successfully."
        : "Approved, but voucher issuance encountered an error — check server logs."
      : "Request rejected."
    : action === "approve"
      ? "Approval granted — the negotiated rate is confirmed."
      : "Request rejected — escalation has been reverted to the default rate.";

  return NextResponse.json({
    success: true,
    status: newStatus,
    message: baseMessage,
    // Only present for unifi_adhoc_voucher approvals
    ...(unifiIssuanceResult ? { voucher: unifiIssuanceResult } : {}),
  });
}
