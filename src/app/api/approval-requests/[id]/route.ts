import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createUnifiVoucher, getUnifiHotspotSsid } from "@/lib/unifi";
import { issueAdhocRuijieVoucher, siteConfigFromLocation as ruijieSiteConfigFromLocation } from "@/lib/ruijie";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { createNotification } from "@/lib/in-app-notifications";

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

  // Reject if the request has passed its expiry (comp_request type)
  if (approvalReq.expires_at && new Date(approvalReq.expires_at) < new Date()) {
    // Mark it expired while we're here
    await admin.from("approval_requests").update({ status: "expired" }).eq("id", id);
    return NextResponse.json({ error: "This request has expired. The floor manager must re-submit." }, { status: 400 });
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

      if (meta.contract_id) {
        // Non-fatal: voucher issuance already succeeded above.
        admin.from("unifi_adhoc_voucher_links").insert({
          location_id:      String(meta.location_id || approvalReq.entity_id),
          unifi_voucher_id: unifiId,
          note:             String(meta.note || `adhoc_${approvalReq.id}`),
          contract_id:      String(meta.contract_id),
          issued_by:        dbUser.id,
        }).then(({ error }) => {
          if (error) console.error("[approval-requests] adhoc link insert failed:", error);
        });
      }

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

  // ── Ruijie ad-hoc voucher ─────────────────────────────────────────────────
  let ruijieIssuanceResult: { code: string; ruijieVoucherUuid: string; packageUsed: string; locationName: string } | null = null;

  if (approvalReq.entity_type === "ruijie_adhoc_voucher" && action === "approve") {
    const meta = approvalReq.metadata || {};
    try {
      const { data: location } = await admin
        .from("locations")
        .select("ruijie_group_id")
        .eq("id", String(meta.location_id || approvalReq.entity_id))
        .single();
      const siteConfig = location ? ruijieSiteConfigFromLocation(location) : null;

      if (!siteConfig) {
        throw new Error("Location has no ruijie_group_id configured.");
      }

      const comment = `adhoc_${String(meta.note || `adhoc_${approvalReq.id}`)}`.slice(0, 200);
      const issued = await issueAdhocRuijieVoucher(siteConfig, String(meta.package_name || ""), comment);

      if ("error" in issued) throw new Error(issued.error);

      // Persist code back onto the request for future reference
      await admin
        .from("approval_requests")
        .update({
          metadata: {
            ...meta,
            issued_code:          issued.result.code,
            issued_voucher_uuid:  issued.result.uuid,
          },
        })
        .eq("id", id);

      logAudit(admin, {
        entityType: "location",
        entityId:   String(meta.location_id || approvalReq.entity_id),
        action:     "create",
        performedBy: dbUser.id,
        changes: {
          type:                { old: null, new: "ruijie_adhoc_voucher_issued" },
          code:                { old: null, new: issued.result.code },
          ruijie_voucher_uuid: { old: null, new: issued.result.uuid },
          package_used:        { old: null, new: issued.packageUsed },
          approved_by:         { old: null, new: dbUser.full_name },
          approval_request_id: { old: null, new: id },
        },
      });

      ruijieIssuanceResult = {
        code: issued.result.code,
        ruijieVoucherUuid: issued.result.uuid,
        packageUsed: issued.packageUsed,
        locationName: String(meta.location_name ?? ""),
      };
    } catch (err) {
      console.error("[approval-requests] Ruijie voucher issuance failed after approval:", err);
      await admin
        .from("approval_requests")
        .update({ metadata: { ...(approvalReq.metadata || {}), issuance_error: err instanceof Error ? err.message : String(err) } })
        .eq("id", id);
    }
  }

  // ── Complimentary booking request ────────────────────────────────────────
  if (approvalReq.approval_type === "comp_request" && approvalReq.entity_type === "booking") {
    const bookingId = approvalReq.entity_id;
    const meta = (approvalReq.metadata || {}) as Record<string, unknown>;

    if (action === "approve") {
      // Zero out the booking totals and mark as waived
      await admin
        .from("bookings")
        .update({
          total_amount:          0,
          gst_amount:            0,
          total_amount_with_gst: 0,
          payment_status:        "waived",
          complimentary_reason:  String(meta.reason ?? approvalReq.reason ?? ""),
          complimentary_details: meta.details ? String(meta.details) : null,
        })
        .eq("id", bookingId);

      logAudit(admin, {
        entityType:  "booking",
        entityId:    bookingId,
        action:      "update",
        performedBy: dbUser.id,
        changes: {
          payment_status:        { old: "pending", new: "waived" },
          total_amount_with_gst: { old: meta.total_amount_with_gst, new: 0 },
          complimentary_reason:  { old: null, new: meta.reason ?? approvalReq.reason },
          approved_via:          { old: null, new: "comp_request_inbox" },
        },
      });
    }

    // Notify the requesting floor manager (in-app + email)
    const requesterRow = await admin
      .from("users")
      .select("id, full_name, email")
      .eq("id", approvalReq.requested_by)
      .single();
    const requester = requesterRow.data;

    if (requester) {
      const bookingRef = String(meta.booking_number ?? bookingId);
      const crmUrl = `/bookings/${bookingRef}`;

      // In-app notification
      await createNotification({
        userId:     requester.id,
        type:       "comp_request_resolved",
        title:      action === "approve"
          ? `Comp request approved — ${bookingRef}`
          : `Comp request rejected — ${bookingRef}`,
        body:       action === "approve"
          ? `Your complimentary request for ${bookingRef} was approved by ${dbUser.full_name}. The booking has been marked as complimentary.`
          : `Your complimentary request for ${bookingRef} was rejected by ${dbUser.full_name}${body.rejection_reason ? `: "${body.rejection_reason}"` : "."}`,
        url:        crmUrl,
        entityType: "booking",
        entityId:   bookingId,
      });

      // Email notification
      const approveHtml = `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;">
          <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:14px 18px;border-radius:4px;margin-bottom:16px;">
            <p style="margin:0;font-size:14px;font-weight:600;color:#15803d;">✅ Comp Request Approved</p>
          </div>
          <p style="font-size:14px;">Your complimentary booking request for <strong>${bookingRef}</strong> has been <strong>approved</strong> by ${dbUser.full_name}.</p>
          <p style="font-size:14px;">The booking total has been zeroed and marked as complimentary.</p>
          <p style="margin-top:20px;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL || "https://crm.theworkvilla.com"}${crmUrl}" style="padding:10px 20px;background:#015E65;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">View Booking →</a>
          </p>
        </div>`;

      const rejectHtml = `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;">
          <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:14px 18px;border-radius:4px;margin-bottom:16px;">
            <p style="margin:0;font-size:14px;font-weight:600;color:#991b1b;">❌ Comp Request Rejected</p>
          </div>
          <p style="font-size:14px;">Your complimentary booking request for <strong>${bookingRef}</strong> was <strong>rejected</strong> by ${dbUser.full_name}.</p>
          ${body.rejection_reason ? `<p style="font-size:14px;background:#f9fafb;padding:10px 14px;border-radius:4px;border:1px solid #e5e7eb;"><strong>Reason:</strong> ${body.rejection_reason}</p>` : ""}
          <p style="margin-top:20px;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL || "https://crm.theworkvilla.com"}${crmUrl}" style="padding:10px 20px;background:#015E65;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">View Booking →</a>
          </p>
        </div>`;

      if (requester.email) {
        resend.emails.send({
          from:    EMAIL_FROM,
          to:      requester.email,
          subject: action === "approve"
            ? `Comp Request Approved — ${bookingRef}`
            : `Comp Request Rejected — ${bookingRef}`,
          html:    action === "approve" ? approveHtml : rejectHtml,
        }).catch(err => console.error("[approval-requests] notify email failed:", err));
      }
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
          const roundToRupee = (n: number) => Math.round(n);

          const newItems: Item[] = parentItems.map((item) => {
            const newUnitPrice = roundToRupee(item.unit_price * multiplier);
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

  // Build response — include voucher details for UniFi/Ruijie ad-hoc so the UI can show the code
  const baseMessage =
    approvalReq.entity_type === "unifi_adhoc_voucher"
      ? action === "approve"
        ? unifiIssuanceResult
          ? "Voucher issued successfully."
          : "Approved, but voucher issuance encountered an error — check server logs."
        : "Request rejected."
      : approvalReq.entity_type === "ruijie_adhoc_voucher"
        ? action === "approve"
          ? ruijieIssuanceResult
            ? "Voucher issued successfully."
            : "Approved, but voucher issuance encountered an error — check server logs."
          : "Request rejected."
        : approvalReq.approval_type === "comp_request"
          ? action === "approve"
            ? "Complimentary approved — booking has been zeroed and marked as waived."
            : "Comp request rejected. The floor manager has been notified."
          : action === "approve"
            ? "Approval granted — the negotiated rate is confirmed."
            : "Request rejected — escalation has been reverted to the default rate.";

  return NextResponse.json({
    success: true,
    status: newStatus,
    message: baseMessage,
    // Only present for unifi_adhoc_voucher / ruijie_adhoc_voucher approvals
    ...(unifiIssuanceResult ? { voucher: unifiIssuanceResult } : {}),
    ...(ruijieIssuanceResult ? { ruijie_voucher: ruijieIssuanceResult } : {}),
  });
}
