import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit, diffChanges, logView } from "@/lib/audit";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { CONTRACT_STATUS_TRANSITIONS } from "@/lib/constants";
import { generateMonthlyStatements } from "@/lib/billing";
import { setUserActive, provisionMemberAccess } from "@/lib/cosec";
import { createUnifiVoucher, revokeUnifiVoucher, calcVoucherMinutes, siteConfigFromLocation, isUnifiLocation } from "@/lib/unifi";

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
    .select("*, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, pan_number, gst_number, street, city, state, zip_code, country, entity_type), proposal:proposals!contracts_proposal_id_fkey(id, proposal_number, title, location_id, payment_status, deposit_payment_status, payment_received_at, deposit_payment_received_at, security_deposit_months), location:locations!contracts_location_id_fkey(id, name, code, address, city, state), signed_document:documents!contracts_signed_document_id_fkey(id, title, file_name, file_path, mime_type, size_bytes, created_at), sent_by_user:users!contracts_sent_by_fkey(full_name), viewed_by_user:users!contracts_viewed_by_fkey(full_name), accepted_by_user:users!contracts_accepted_by_fkey(full_name), rejected_by_user:users!contracts_rejected_by_fkey(full_name), activated_by_user:users!contracts_activated_by_fkey(full_name), terminated_by_user:users!contracts_terminated_by_fkey(full_name), renewed_by_user:users!contracts_renewed_by_fkey(full_name), created_by_user:users!contracts_created_by_fkey(full_name), rate_phases:contract_rate_phases(*)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  // Flatten actor names for the lifecycle component
  const actorNames: Record<string, string | null> = {};
  for (const key of ["sent", "viewed", "accepted", "rejected", "activated", "terminated", "renewed", "created"] as const) {
    const joined = (data as Record<string, unknown>)[`${key}_by_user`] as { full_name: string } | null;
    actorNames[`${key}_by_name`] = joined?.full_name || null;
    delete (data as Record<string, unknown>)[`${key}_by_user`];
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    await logView(supabase, { entityType: "contract", entityId: id, performedBy: dbUser.id });
  }

  return NextResponse.json({ data: { ...data, ...actorNames } });
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
  if (body.lock_in_months !== undefined) allowedFields.lock_in_months = body.lock_in_months ?? null;
  if (body.renewed_at) allowedFields.renewed_at = body.renewed_at;
  if (body.signed_document_id !== undefined) allowedFields.signed_document_id = body.signed_document_id;
  if (body.billing_mode !== undefined && ["proforma_first", "gst_direct"].includes(body.billing_mode as string)) {
    allowedFields.billing_mode = body.billing_mode;
  }

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

  // Department ID rules:
  //   - A contract must have a location to receive a department ID (printers
  //     are physical, tied to a building). Setting an ID on a location-less
  //     contract is rejected with 400.
  //   - The ID is unique per location; the same ID can exist at different
  //     locations (each location has its own print server / printer cards).
  if (allowedFields.department_id != null && allowedFields.department_id !== oldContract.department_id) {
    const locId = (allowedFields.location_id as string | null) ?? oldContract.location_id;
    if (!locId) {
      return NextResponse.json({
        error: "Assign a location to the contract before mapping a Department ID",
      }, { status: 400 });
    }

    const { data: clash } = await supabase
      .from("contracts")
      .select("contract_number")
      .eq("location_id", locId)
      .eq("department_id", allowedFields.department_id)
      .neq("id", id)
      .maybeSingle();
    if (clash) {
      return NextResponse.json({
        error: `Department ID "${allowedFields.department_id}" is already used by ${clash.contract_number} at this location`,
      }, { status: 409 });
    }
  }
  // Resolve the CRM user ID early — needed for _by actor columns and audit log
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  // Only admins may bypass the proposal payment gate
  if (body.payment_override_reason && dbUser?.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can override the payment requirement" },
      { status: 403 }
    );
  }

  // Handle special status transitions
  if (body.status && body.status !== oldContract.status) {
    // Validate transition is allowed
    const allowed = CONTRACT_STATUS_TRANSITIONS[oldContract.status];
    if (!allowed || !allowed.includes(body.status)) {
      return NextResponse.json({
        error: `Cannot move contract from "${oldContract.status}" to "${body.status}". Allowed transitions: ${(allowed || []).join(", ") || "none (terminal status)"}`,
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    const actorId = dbUser?.id || null;
    if (body.status === "sent") {
      allowedFields.sent_at = body.sent_at || now;
      allowedFields.sent_by = actorId;
    } else if (body.status === "viewed") {
      allowedFields.viewed_at = body.viewed_at || now;
      allowedFields.viewed_by = actorId;
    } else if (body.status === "accepted") {
      allowedFields.accepted_at = body.accepted_at || now;
      allowedFields.accepted_by = actorId;
    } else if (body.status === "rejected") {
      allowedFields.rejected_at = body.rejected_at || now;
      allowedFields.rejected_by = actorId;
    } else if (body.status === "active") {
      // Block activation if escalation approval is pending
      if (oldContract.escalation_approval_status === "pending") {
        return NextResponse.json({
          error: "Cannot activate: escalation rate approval is pending. Ask your admin to approve the negotiated rate first.",
        }, { status: 400 });
      }
      if (oldContract.escalation_approval_status === "rejected") {
        return NextResponse.json({
          error: "Cannot activate: the proposed escalation rate was rejected. The rate has been reverted to the default. Review and retry.",
        }, { status: 400 });
      }

      // Renewal contracts carry the deposit forward — skip the proposal
      // payment gate when deposit_carried_from is set.
      const isRenewal = !!oldContract.deposit_carried_from;

      // Payment gate — skipped for renewals (deposit carried forward)
      if (!isRenewal && !body.payment_override_reason) {
        // Hard gate: proposal must be linked before any new contract can be activated.
        // This ensures deposit + pro-rata are always collected before occupancy begins.
        if (!oldContract.proposal_id) {
          return NextResponse.json({
            error: "Cannot activate: no proposal is linked to this contract. Link the corresponding proposal (which must have deposit + pro-rata collected) before activating.",
          }, { status: 400 });
        }

        const { data: proposal } = await supabase
          .from("proposals")
          .select("payment_status, deposit_payment_status, security_deposit_months, deposit_waiver_verified_at")
          .eq("id", oldContract.proposal_id)
          .single();

        if (!proposal) {
          return NextResponse.json({
            error: "Cannot activate: linked proposal could not be retrieved. Verify the proposal exists and is accessible.",
          }, { status: 400 });
        }

        const missing: string[] = [];
        if (proposal.payment_status !== "paid") missing.push("pro-rata / first invoice payment");
        const depositRequired = Number(proposal.security_deposit_months || 0) > 0;
        if (depositRequired && proposal.deposit_payment_status !== "paid") missing.push("security deposit");
        if (!depositRequired && !proposal.deposit_waiver_verified_at) missing.push("admin deposit waiver OTP approval");
        if (missing.length > 0) {
          return NextResponse.json({
            error: `Cannot activate: ${missing.join(" and ")} not yet collected on the linked proposal`,
          }, { status: 400 });
        }
      }
      // For mid-month renewals: pro-rata must be paid before activation.
      // Check the billing statement directly so all payment paths (Razorpay,
      // AR manual record, Tally inbox record) unblock activation automatically.
      if (
        oldContract.is_renewal &&
        oldContract.prorata_payment_status === "pending" &&
        !body.payment_override_reason
      ) {
        let prorataSettled = false;
        if (oldContract.prorata_billing_statement_id) {
          const { data: prorataStmt } = await supabase
            .from("billing_statements")
            .select("payment_status")
            .eq("id", oldContract.prorata_billing_statement_id)
            .single();
          if (prorataStmt?.payment_status === "paid") {
            prorataSettled = true;
            // Sync the contract column so future checks are fast
            await supabase
              .from("contracts")
              .update({ prorata_payment_status: "paid" })
              .eq("id", id);
          }
        }
        if (!prorataSettled) {
          return NextResponse.json({
            error: "Cannot activate: pro-rata payment for the partial first month has not been collected. Send the PI or GST invoice from the Pro-Rata section and collect payment first.",
          }, { status: 400 });
        }
      }

      allowedFields.activated_at = now;
      allowedFields.activated_by = actorId;
    } else if (body.status === "terminated") {
      // Only admin or manager may terminate a contract
      if (!["admin", "manager"].includes(dbUser?.role ?? "")) {
        return NextResponse.json(
          { error: "Only admins and managers can terminate a contract" },
          { status: 403 }
        );
      }
      if (!body.termination_reason && !allowedFields.termination_reason) {
        return NextResponse.json({ error: "Termination reason is required" }, { status: 400 });
      }
      allowedFields.terminated_at = now;
      allowedFields.terminated_by = actorId;
    } else if (body.status === "renewal_in_progress") {
      // No special timestamp — just a status change
    } else if (body.status === "renewed") {
      allowedFields.renewed_at = now;
      allowedFields.renewed_by = actorId;
    }
  }

  const { data, error } = await supabase
    .from("contracts")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dbUser?.id && oldContract) {
    const auditChanges = diffChanges(oldContract as Record<string, unknown>, allowedFields);
    // If admin used the payment override, record the reason explicitly in the audit trail
    if (body.payment_override_reason && body.status === "active") {
      auditChanges["payment_override_reason"] = { old: null, new: body.payment_override_reason };
    }
    logAudit(supabase, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: auditChanges,
    });
  }

  // Auto-advance lead status when contract becomes active
  if (body.status === "active" && oldContract.status !== "active") {
    await autoUpdateLeadStatus(supabase, oldContract.lead_id, "contract");

    // Generate the current month's billing statement immediately. The monthly
    // cron runs on the last day of each month at 21:00 IST — without this hook,
    // contracts activated mid-month would have no bill until then.
    // Idempotent: skips if a statement for this month already exists.
    try {
      const admin = createAdminClient();
      await generateMonthlyStatements(admin, { contractId: id });
    } catch (err) {
      console.error("[contract-activate] auto-generate statement failed:", err);
      // Non-fatal: activation still succeeds. Operator can use the
      // "Generate Missing Bills" button in /billing to retry.
    }

    // ── COSEC backfill for members added before activation ───────────
    // Members added while the contract was still draft never went through
    // the auto-provision step in POST /members (it's gated on the contract
    // being operational at add-time). Catch them up here so activation
    // always leaves every active member enrollable.
    if (oldContract.location_id) {
      (async () => {
        try {
          const admin = createAdminClient();
          const { data: members } = await admin
            .from("contract_members")
            .select("id, name, phone")
            .eq("contract_id", id)
            .eq("is_active", true);

          if (!members || members.length === 0) return;

          const { data: existingAccess } = await admin
            .from("cosec_access_users")
            .select("entity_id")
            .eq("user_type", "member")
            .in("entity_id", members.map((m) => m.id));
          const alreadyProvisioned = new Set((existingAccess ?? []).map((a) => a.entity_id));

          const unprovisioned = members.filter((m) => !alreadyProvisioned.has(m.id));
          if (unprovisioned.length === 0) return;

          await Promise.allSettled(unprovisioned.map((m) =>
            provisionMemberAccess(admin, {
              memberId: m.id,
              memberName: m.name,
              memberPhone: m.phone,
              locationId: oldContract.location_id,
              contractEndDate: data.end_date,
            })
          ));
          console.log(`[contract-activate] Backfilled COSEC access for ${unprovisioned.length} member(s) on ${data.contract_number}`);
        } catch (err) {
          console.error("[contract-activate] COSEC member backfill failed:", err);
        }
      })();
    }

    // ── UniFi API voucher issuance (Nungambakkam LGF only) ───────────
    // For UniFi-managed locations, issue a precision-duration voucher matching
    // the exact contract end date instead of the nearest fixed-period import.
    // Non-fatal: falls back to the existing import stack if anything fails.
    if (oldContract.location_id && oldContract.end_date) {
      (async () => {
        try {
          const admin = createAdminClient();
          const { data: location } = await admin
            .from("locations")
            .select("unifi_site_id, unifi_console_id, wifi_voucher_mode, name")
            .eq("id", oldContract.location_id)
            .single();

          if (location && isUnifiLocation(location)) {
            const siteConfig = siteConfigFromLocation(location);
            const durationMinutes = calcVoucherMinutes(oldContract.end_date);
            const seatedCount = oldContract.no_of_seats || 1;
            const { id: unifiVoucherId, code: unifiCode } = await createUnifiVoucher({
              durationMinutes,
              note: `contract_${data.contract_number}`,
              quota: seatedCount,
            }, siteConfig);
            // Store the UniFi voucher _id on the contract for revocation on cancellation
            await admin
              .from("contracts")
              .update({ unifi_voucher_id: unifiVoucherId })
              .eq("id", id);
            console.log(`[unifi] Issued voucher ${unifiCode} (${durationMinutes} min, ${seatedCount} seats) for ${data.contract_number}`);
          }
        } catch (err) {
          // Non-fatal — log and continue. Staff can still use import-based vouchers.
          console.error("[unifi] voucher issuance on activation failed:", err);
        }
      })();
    }

    // ── Mark parent contract as "renewed" ────────────────────────────
    // Only transitions the parent now (not at draft creation), so deleting
    // a renewal draft doesn't leave the parent stuck in "renewed".
    if (oldContract.is_renewal && oldContract.parent_contract_id) {
      try {
        const admin = createAdminClient();
        await admin
          .from("contracts")
          .update({ status: "renewed", renewed_at: new Date().toISOString() })
          .eq("id", oldContract.parent_contract_id);
      } catch (err) {
        console.error("[contract-activate] failed to mark parent as renewed:", err);
      }
    }

    // ── Renewal voucher auto-issuance ──────────────────────────────────
    // When a renewal contract is activated, revoke the parent's vouchers
    // and attempt to issue fresh ones for the new tenure. Non-fatal:
    // staff can always issue manually from the Vouchers section.
    if (oldContract.is_renewal && oldContract.parent_contract_id) {
      (async () => {
        try {
          const admin = createAdminClient();

          // 1a. Revoke parent contract's UniFi API voucher (Nungambakkam LGF)
          const { data: parentContract } = await admin
            .from("contracts")
            .select("unifi_voucher_id")
            .eq("id", oldContract.parent_contract_id)
            .single();
          if (parentContract?.unifi_voucher_id) {
            revokeUnifiVoucher(parentContract.unifi_voucher_id)
              .catch((err: unknown) => console.error("[renewal-activate] UniFi voucher revocation failed:", err));
          }

          // 1b. Revoke parent contract's active import-based vouchers
          const { data: parentIssuances } = await admin
            .from("voucher_issuances")
            .select("id, voucher_id, seat_number, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(voucher_code)")
            .eq("contract_id", oldContract.parent_contract_id)
            .eq("is_active", true);

          if (parentIssuances && parentIssuances.length > 0) {
            const revokeNow = new Date().toISOString();
            const issuanceIds = parentIssuances.map((i: { id: string }) => i.id);
            await admin
              .from("voucher_issuances")
              .update({ is_active: false, revoked_at: revokeNow, revoke_reason: "Renewal activated" })
              .in("id", issuanceIds);

            const voucherIds = parentIssuances
              .map((i: { voucher_id: string | null }) => i.voucher_id)
              .filter(Boolean);
            if (voucherIds.length > 0) {
              await admin
                .from("voucher_repository")
                .update({ status: "revoked" })
                .in("id", voucherIds);
            }

            // Notify IT about old voucher revocation
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const revokedRows = parentIssuances.map((i: any) => {
              const code = i.voucher?.voucher_code || "—";
              return `<tr>
                <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${i.seat_number}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#e53e3e;">${code}</td>
              </tr>`;
            }).join("");

            resend.emails.send({
              from: EMAIL_FROM,
              replyTo: EMAIL_REPLY_TO,
              to: ["it@theworkvilla.com", "techsupport@theworkvilla.com"],
              subject: `Voucher Transition — ${oldContract.contract_number} renewed as ${data.contract_number || id}`,
              html: `
                <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                  <div style="background:#f59e0b;padding:20px 32px;">
                    <h1 style="color:white;margin:0;font-size:20px;">WiFi Voucher Transition — Renewal</h1>
                    <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px;">Old codes revoked, new codes pending issuance</p>
                  </div>
                  <div style="padding:28px 32px;">
                    <p style="color:#333;font-size:14px;">Contract <strong>${oldContract.contract_number}</strong> has been renewed. The following old voucher codes have been <strong>revoked</strong> and must be disabled in the WiFi system.</p>
                    <h3 style="color:#dc2626;font-size:14px;margin:16px 0 8px;">Codes to Revoke (${parentIssuances.length})</h3>
                    <table style="width:100%;border-collapse:collapse;font-size:13px;">
                      <tr style="background:#fef2f2;">
                        <th style="padding:6px 12px;text-align:center;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Seat</th>
                        <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Old Code</th>
                      </tr>
                      ${revokedRows}
                    </table>
                    <p style="color:#666;font-size:13px;margin-top:16px;">New voucher codes for the renewal contract will be issued and emailed separately.</p>
                  </div>
                  <div style="background:#015E65;padding:12px 32px;text-align:center;">
                    <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
                  </div>
                </div>
              `,
            }).catch((err: unknown) => console.error("[renewal-activate] IT email failed:", err));

            console.log(`[renewal-activate] Revoked ${parentIssuances.length} voucher(s) from parent ${oldContract.parent_contract_id}`);
          }

          // 2. Auto-issue vouchers for the renewal contract
          // Requires: signed_document_id set on the renewal contract.
          // Uses an internal fetch to the voucher issuance endpoint (bulk mode).
          if (data.signed_document_id) {
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL || "localhost:3000"}`;
            const issueRes = await fetch(`${baseUrl}/api/contracts/${id}/vouchers`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                // Forward the user's auth cookie for RLS
                cookie: request.headers.get("cookie") || "",
              },
            });

            if (issueRes.ok) {
              const issueJson = await issueRes.json();
              console.log(`[renewal-activate] Auto-issued ${issueJson.data?.length || 0} voucher(s) for renewal ${id}`);
              if (issueJson.match_warning) {
                console.warn(`[renewal-activate] Voucher match warning: ${issueJson.match_warning}`);
              }
            } else {
              const errJson = await issueRes.json().catch(() => null);
              console.warn(`[renewal-activate] Auto-issue vouchers failed: ${errJson?.error || issueRes.status}. Staff can issue manually.`);
            }
          } else {
            console.info(`[renewal-activate] Signed document not uploaded yet — skipping auto-issuance for ${id}. Staff can issue after uploading.`);
          }
        } catch (err) {
          console.error("[renewal-activate] voucher auto-issuance failed:", err);
        }
      })();
    }
  }

  // ── COSEC: block all members on termination/expiry ───────────────────────
  if (
    (body.status === "terminated" || body.status === "expired") &&
    oldContract.status === "active"
  ) {
    (async () => {
      try {
        const admin = createAdminClient();
        // Find all active member access users for this contract
        const { data: accessUsers } = await admin
          .from("cosec_access_users")
          .select("id, cosec_user_id, device:cosec_devices(device_ip, device_port, device_password)")
          .eq("user_type", "member")
          .not("enrollment_status", "in", "(blocked,deleted)")
          .in("entity_id",
            // subquery: get all contract_member ids for this contract
            (await admin.from("contract_members").select("id").eq("contract_id", id)).data?.map(m => m.id) ?? []
          );

        if (!accessUsers || accessUsers.length === 0) return;

        const now = new Date().toISOString();
        await Promise.allSettled(accessUsers.map(async (au) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dev = au.device as any;
          if (!dev) return;
          try {
            await setUserActive(
              { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
              au.cosec_user_id,
              false
            );
          } catch { /* non-fatal — device may be offline */ }
          await admin.from("cosec_access_users")
            .update({ enrollment_status: "blocked", blocked_at: now, updated_at: now })
            .eq("id", au.id);
        }));
      } catch (err) {
        console.error("[contract-terminate] COSEC member block failed:", err);
      }
    })();
  }

  // On termination: release all active space allocations so units are available for re-allocation
  if (body.status === "terminated" && oldContract.status !== "terminated") {
    (async () => {
      try {
        const admin = createAdminClient();
        await admin
          .from("contract_space_allocations")
          .update({ status: "ended", updated_at: new Date().toISOString() })
          .eq("contract_id", id)
          .eq("status", "active");
      } catch (err) {
        console.error("[contract-terminate] space allocation release failed:", err);
      }
    })();
  }

  // On termination: revoke UniFi voucher instantly (Nungambakkam LGF only)
  if (body.status === "terminated" && oldContract.status !== "terminated" && oldContract.unifi_voucher_id) {
    revokeUnifiVoucher(oldContract.unifi_voucher_id)
      .catch(err => console.error("[unifi] voucher revocation on termination failed:", err));
  }

  // On termination: revoke active vouchers and notify IT
  if (body.status === "terminated" && oldContract.status !== "terminated") {
    (async () => {
      try {
        // Fetch active voucher issuances with voucher codes
        const { data: issuances } = await supabase
          .from("voucher_issuances")
          .select("id, voucher_id, unifi_voucher_id, seat_number, seat_occupant_email, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code)")
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

          // Revoke repository-based vouchers
          const voucherIds = issuances.map((i) => i.voucher_id).filter(Boolean);
          if (voucherIds.length > 0) {
            await supabase
              .from("voucher_repository")
              .update({ status: "revoked" })
              .in("id", voucherIds);
          }

          // Revoke Unifi live-API per-seat vouchers (fire-and-forget)
          for (const issuance of issuances) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const uid = (issuance as any).unifi_voucher_id as string | null;
            if (uid) {
              revokeUnifiVoucher(uid).catch((err: unknown) =>
                console.error(`[unifi] per-seat revoke ${uid} on termination failed:`, err)
              );
            }
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
                    <tr><td style="padding:6px 0;color:#666;">Terminated</td><td style="padding:6px 0;">${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}</td></tr>
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

  // If this was a renewal draft, restore the parent contract to "active"
  // so it isn't stuck in "renewal_in_progress".
  if (contract.is_renewal && contract.parent_contract_id) {
    try {
      const admin = createAdminClient();
      await admin
        .from("contracts")
        .update({ status: "active" })
        .eq("id", contract.parent_contract_id)
        .eq("status", "renewal_in_progress");
    } catch (err) {
      console.error("[contract-delete] failed to restore parent status:", err);
    }
  }

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
