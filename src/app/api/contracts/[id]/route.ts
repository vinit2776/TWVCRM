import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit, diffChanges } from "@/lib/audit";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateMonthlyStatements } from "@/lib/billing";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contracts")
    .select("*, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, pan_number, gst_number, street, city, state, zip_code, country, entity_type), proposal:proposals!contracts_proposal_id_fkey(proposal_number, title, location_id), location:locations!contracts_location_id_fkey(id, name, code, address, city, state), signed_document:documents!contracts_signed_document_id_fkey(id, title, file_name, file_path, mime_type, size_bytes, created_at)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

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

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  if (body.status) allowedFields.status = body.status;
  if (body.location_id !== undefined) allowedFields.location_id = body.location_id || null;
  if (body.notes !== undefined) allowedFields.notes = body.notes;
  if (body.termination_reason) allowedFields.termination_reason = body.termination_reason;
  if (body.next_billing_date) allowedFields.next_billing_date = body.next_billing_date;
  if (body.end_date) allowedFields.end_date = body.end_date;
  if (body.tenure_months) allowedFields.tenure_months = body.tenure_months;
  if (body.renewed_at) allowedFields.renewed_at = body.renewed_at;
  if (body.signed_document_id !== undefined) allowedFields.signed_document_id = body.signed_document_id;

  // Department ID — printer-side identifier mapped to this contract.
  // Empty string is normalised to NULL so unique-per-location stays clean.
  // Accepts both `department_id` (current) and the legacy `printer_department_id`
  // alias for backwards-compat with any older callers.
  const rawDept = body.department_id ?? body.printer_department_id;
  if (rawDept !== undefined) {
    const trimmed = (typeof rawDept === "string" ? rawDept.trim() : rawDept) || null;
    allowedFields.department_id = trimmed;
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data: oldContract } = await supabase.from("contracts").select("*").eq("id", id).single();
  if (!oldContract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // Department ID uniqueness check — global, not per location. The DB has a
  // partial unique index on department_id alone, so we'd get a 23505 anyway,
  // but a friendly pre-check returns a message naming the conflicting contract.
  if (allowedFields.department_id != null && allowedFields.department_id !== oldContract.department_id) {
    const { data: clash } = await supabase
      .from("contracts")
      .select("contract_number, location:locations!contracts_location_id_fkey(name)")
      .eq("department_id", allowedFields.department_id)
      .neq("id", id)
      .maybeSingle();
    if (clash) {
      const loc = (clash.location as { name?: string } | null)?.name;
      return NextResponse.json({
        error: `Department ID "${allowedFields.department_id}" is already used by ${clash.contract_number}${loc ? ` (${loc})` : ""}`,
      }, { status: 409 });
    }
  }
  // Handle special status transitions
  if (body.status && body.status !== oldContract.status) {
    const now = new Date().toISOString();
    if (body.status === "sent") {
      allowedFields.sent_at = body.sent_at || now;
    } else if (body.status === "viewed") {
      allowedFields.viewed_at = body.viewed_at || now;
    } else if (body.status === "accepted") {
      allowedFields.accepted_at = body.accepted_at || now;
    } else if (body.status === "rejected") {
      allowedFields.rejected_at = body.rejected_at || now;
    } else if (body.status === "active") {
      // Payment gate: check linked proposal payments (unless admin override)
      if (!body.payment_override_reason && oldContract.proposal_id) {
        const { data: proposal } = await supabase
          .from("proposals")
          .select("payment_status, deposit_payment_status")
          .eq("id", oldContract.proposal_id)
          .single();

        if (proposal) {
          const unpaid = proposal.payment_status !== "paid";
          const depositPending = proposal.deposit_payment_status === "pending";
          if (unpaid || depositPending) {
            const missing: string[] = [];
            if (unpaid) missing.push("proposal payment");
            if (depositPending) missing.push("security deposit");
            return NextResponse.json({
              error: `Cannot activate: ${missing.join(" and ")} not yet collected`,
            }, { status: 400 });
          }
        }
      }
      allowedFields.activated_at = now;
    } else if (body.status === "terminated") {
      if (!body.termination_reason && !allowedFields.termination_reason) {
        return NextResponse.json({ error: "Termination reason is required" }, { status: 400 });
      }
      allowedFields.terminated_at = now;
    } else if (body.status === "renewed") {
      allowedFields.renewed_at = now;
    }
  }

  const { data, error } = await supabase
    .from("contracts")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id && oldContract) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: diffChanges(oldContract as Record<string, unknown>, allowedFields),
    });
  }

  // Auto-advance lead status when contract becomes active
  if (body.status === "active" && oldContract.status !== "active") {
    await autoUpdateLeadStatus(supabase, oldContract.lead_id, "contract");

    // Generate the current month's billing statement immediately. The monthly
    // cron only runs on the 1st of each month — without this hook, contracts
    // activated mid-month would have no bill until the next cron firing.
    // Idempotent: skips if a statement for this month already exists.
    try {
      const admin = createAdminClient();
      await generateMonthlyStatements(admin, { contractId: id });
    } catch (err) {
      console.error("[contract-activate] auto-generate statement failed:", err);
      // Non-fatal: activation still succeeds. Operator can use the
      // "Generate Missing Bills" button in /billing to retry.
    }
  }

  // On termination: revoke active vouchers and notify IT
  if (body.status === "terminated" && oldContract.status !== "terminated") {
    (async () => {
      try {
        // Fetch active voucher issuances with voucher codes
        const { data: issuances } = await supabase
          .from("voucher_issuances")
          .select("id, voucher_id, seat_number, seat_occupant_email, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code)")
          .eq("contract_id", id)
          .eq("is_active", true);

        if (issuances && issuances.length > 0) {
          const revokeNow = new Date().toISOString();

          // Revoke all issuances
          const issuanceIds = issuances.map((i) => i.id);
          await supabase
            .from("voucher_issuances")
            .update({ is_active: false, revoked_at: revokeNow, revoke_reason: "Contract terminated" })
            .in("id", issuanceIds);

          // Revoke vouchers in repository
          const voucherIds = issuances.map((i) => i.voucher_id).filter(Boolean);
          if (voucherIds.length > 0) {
            await supabase
              .from("voucher_repository")
              .update({ status: "revoked" })
              .in("id", voucherIds);
          }

          // Email IT and Tech Support
          const voucherRows = issuances.map((i) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const v = i.voucher as any;
            return `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${i.seat_number}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-weight:bold;color:#e53e3e;">${v?.voucher_code || "—"}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${i.seat_occupant_email || "—"}</td>
            </tr>`;
          }).join("");

          const terminationReason = body.termination_reason || allowedFields.termination_reason || "Not specified";

          resend.emails.send({
            from: EMAIL_FROM,
            replyTo: EMAIL_REPLY_TO,
            to: ["it@theworkvilla.com", "techsupport@theworkvilla.com"],
            subject: `Voucher Revocation — ${oldContract.contract_number} Terminated`,
            html: `
              <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <div style="background:#dc2626;padding:20px 32px;">
                  <h1 style="color:white;margin:0;font-size:20px;">WiFi Voucher Revocation</h1>
                  <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px;">Action Required — Revoke in WiFi System</p>
                </div>
                <div style="padding:28px 32px;">
                  <p style="color:#333;font-size:14px;">Contract <strong>${oldContract.contract_number}</strong> has been terminated. Please revoke the following WiFi voucher codes immediately.</p>
                  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
                    <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;font-weight:600;">${oldContract.contract_number}</td></tr>
                    <tr><td style="padding:6px 0;color:#666;">Reason</td><td style="padding:6px 0;">${terminationReason}</td></tr>
                    <tr><td style="padding:6px 0;color:#666;">Terminated</td><td style="padding:6px 0;">${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td></tr>
                  </table>
                  <h3 style="color:#dc2626;font-size:14px;margin:20px 0 8px;">Vouchers to Revoke (${issuances.length})</h3>
                  <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <tr style="background:#fef2f2;">
                      <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Seat</th>
                      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Voucher Code</th>
                      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Occupant</th>
                    </tr>
                    ${voucherRows}
                  </table>
                  <p style="color:#991b1b;font-size:13px;margin-top:16px;font-weight:600;">Please revoke these codes in the WiFi management system at the earliest.</p>
                </div>
                <div style="background:#015E65;padding:12px 32px;text-align:center;">
                  <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
                </div>
              </div>
            `,
          }).catch((err) => console.error("[contract termination] Failed to send voucher revocation email:", err));
        }
      } catch (err) {
        console.error("[contract termination] Voucher revocation failed:", err);
      }
    })();
  }

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only allow deletion of draft contracts
  const { data: contract } = await supabase.from("contracts").select("*").eq("id", id).single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (contract.status !== "draft") {
    return NextResponse.json({ error: "Only draft contracts can be deleted" }, { status: 400 });
  }

  const { error } = await supabase.from("contracts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: contract, new: null } },
    });
  }

  return NextResponse.json({ message: "Contract deleted" });
}
