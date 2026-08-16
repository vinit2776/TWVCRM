import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { revokeUnifiVoucher } from "@/lib/unifi";
import { setUserActive } from "@/lib/cosec";
import { withCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/contract-expiry
 *
 * Daily cron — auto-transitions contracts past their end_date from
 * "active" to "expired" and notifies staff.
 *
 * A contract is expired when:
 *   1. status = "active"
 *   2. end_date < today (IST)
 *   3. No existing renewal (parent_contract_id pointing to it) in
 *      draft/active status
 *
 * The cron only marks the status; it does NOT create renewal drafts
 * or block anything. That's handled by the renewal flow.
 */
async function handler(request: NextRequest) {
  // Verify cron secret (Vercel sets this header)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Today in IST (UTC+5:30)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayIST = istNow.toISOString().slice(0, 10); // YYYY-MM-DD

  // Find active contracts whose end_date has passed
  const { data: expiring, error: fetchErr } = await admin
    .from("contracts")
    .select("id, contract_number, end_date, lead_id, location_id, unifi_voucher_id, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email), location:locations!contracts_location_id_fkey(name)")
    .eq("status", "active")
    .lt("end_date", todayIST);

  if (fetchErr) {
    console.error("[contract-expiry] fetch error:", fetchErr);
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  if (!expiring || expiring.length === 0) {
    return NextResponse.json({ message: "No contracts to expire", count: 0 });
  }

  // Filter out contracts that already have a renewal draft/active
  const contractIds = expiring.map((c) => c.id);
  const { data: renewals } = await admin
    .from("contracts")
    .select("parent_contract_id")
    .in("parent_contract_id", contractIds)
    .in("status", ["draft", "sent", "viewed", "accepted", "active"]);

  const renewedParentIds = new Set(
    (renewals || []).map((r) => r.parent_contract_id)
  );

  const toExpire = expiring.filter((c) => !renewedParentIds.has(c.id));

  if (toExpire.length === 0) {
    return NextResponse.json({
      message: "All expiring contracts have active renewals",
      count: 0,
    });
  }

  // Batch update to "expired"
  const expireIds = toExpire.map((c) => c.id);
  const { error: updateErr } = await admin
    .from("contracts")
    .update({ status: "expired" })
    .in("id", expireIds);

  if (updateErr) {
    console.error("[contract-expiry] update error:", updateErr);
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // ── Voucher revocation for expired contracts ──────────────────────────────
  // Non-fatal: runs after status update so expiry always succeeds even if
  // revocation has a transient failure.
  const revokeNow = new Date().toISOString();

  // Pre-fetch ALL active voucher_issuances for expiring contracts in one query.
  // Previously this was a per-contract query inside the loop (N+1).
  const { data: allIssuances } = await admin
    .from("voucher_issuances")
    .select("id, voucher_id, contract_id")
    .in("contract_id", expireIds)
    .eq("is_active", true);

  type IssuanceRow = { id: string; voucher_id: string | null; contract_id: string };
  const issuancesByContractId = new Map<string, IssuanceRow[]>();
  for (const issuance of (allIssuances ?? []) as IssuanceRow[]) {
    const list = issuancesByContractId.get(issuance.contract_id) ?? [];
    list.push(issuance);
    issuancesByContractId.set(issuance.contract_id, list);
  }

  for (const contract of toExpire) {
    // 1. UniFi API voucher (Nungambakkam LGF — direct device revocation)
    if (contract.unifi_voucher_id) {
      revokeUnifiVoucher(contract.unifi_voucher_id)
        .catch((err) => console.error(`[contract-expiry] UniFi revoke failed for ${contract.contract_number}:`, err));
    }

    // 2. Import-based vouchers — mark as revoked in CRM DB
    try {
      const issuances = issuancesByContractId.get(contract.id) ?? [];

      if (issuances.length > 0) {
        const issuanceIds = issuances.map((i) => i.id);
        await admin
          .from("voucher_issuances")
          .update({ is_active: false, revoked_at: revokeNow, revoke_reason: "Contract expired" })
          .in("id", issuanceIds);

        const voucherIds = issuances
          .map((i) => i.voucher_id)
          .filter(Boolean);
        if (voucherIds.length > 0) {
          await admin
            .from("voucher_repository")
            .update({ status: "revoked" })
            .in("id", voucherIds as string[]);
        }
        console.log(`[contract-expiry] Revoked ${issuances.length} import voucher(s) for ${contract.contract_number}`);
      }
    } catch (err) {
      console.error(`[contract-expiry] import voucher revoke failed for ${contract.contract_number}:`, err);
    }
  }

  // ── COSEC access revocation for expired contracts ─────────────────────────
  // Deactivate all member access users on the device. Non-fatal.
  try {
    const { data: memberIds } = await admin
      .from("contract_members")
      .select("id")
      .in("contract_id", expireIds);

    if (memberIds && memberIds.length > 0) {
      const { data: accessUsers } = await admin
        .from("cosec_access_users")
        .select("id, cosec_user_id, device_id")
        .in("entity_id", memberIds.map(m => m.id))
        .not("enrollment_status", "in", "(blocked,deleted)");

      if (accessUsers && accessUsers.length > 0) {
        const { data: deviceRows } = await admin
          .from("cosec_devices")
          .select("id, device_ip, device_port, device_password")
          .in("id", accessUsers.map(a => a.device_id));

        const devMap = new Map((deviceRows ?? []).map(d => [d.id, d]));
        const nowStr = new Date().toISOString();

        await Promise.allSettled(accessUsers.map(async (au) => {
          const dev = devMap.get(au.device_id);
          if (dev) {
            try {
              await setUserActive(
                { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
                au.cosec_user_id,
                false,
              );
            } catch { /* device may be offline — DB update still proceeds */ }
          }
          await admin.from("cosec_access_users")
            .update({ enrollment_status: "blocked", blocked_at: nowStr, updated_at: nowStr })
            .eq("id", au.id);
        }));

        console.log(`[contract-expiry] COSEC: deactivated ${accessUsers.length} member access user(s)`);
      }
    }
  } catch (err) {
    console.error("[contract-expiry] COSEC revocation failed:", err);
  }

  // Notify staff via email
  const rows = toExpire.map((c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = c.lead as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loc = c.location as any;
    const name = lead
      ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || lead.company || "—"
      : "—";
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${c.contract_number}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${loc?.name || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${c.end_date}</td>
    </tr>`;
  }).join("");

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: ["admin@theworkvilla.com", "accounts@theworkvilla.com"],
      subject: `Contract Expiry — ${toExpire.length} contract(s) expired today`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#f59e0b;padding:20px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">Contracts Expired</h1>
            <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px;">${todayIST} — ${toExpire.length} contract(s) auto-expired</p>
          </div>
          <div style="padding:28px 32px;">
            <p style="color:#333;font-size:14px;">The following contracts have passed their end date and have been moved to <strong>expired</strong> status. Please follow up for renewal or exit processing.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
              <tr style="background:#fffbeb;">
                <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fde68a;color:#92400e;font-size:11px;">Contract</th>
                <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fde68a;color:#92400e;font-size:11px;">Customer</th>
                <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fde68a;color:#92400e;font-size:11px;">Location</th>
                <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fde68a;color:#92400e;font-size:11px;">End Date</th>
              </tr>
              ${rows}
            </table>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error("[contract-expiry] email failed:", err);
  }

  return NextResponse.json({
    message: `Expired ${toExpire.length} contract(s)`,
    count: toExpire.length,
    contracts: toExpire.map((c) => c.contract_number),
  });
}

export const GET = withCronHealth("cron/contract-expiry", handler);
