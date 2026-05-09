import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { sendWhatsApp } from "@/lib/whatsapp";
import { dltSms } from "@/lib/whatsapp";

export const maxDuration = 60;

/**
 * GET /api/cron/renewal-reminders
 *
 * Daily cron — sends renewal reminders to customers whose contracts are
 * approaching their end_date at 60, 30, 15, and 7 day milestones.
 *
 * Communication channels (all fire in parallel, best-effort):
 *   1. Email   — rich HTML to customer + CC to staff
 *   2. WhatsApp — MSG91 template "contract_renewal"
 *   3. SMS     — DLT template "contract_renewal" (if enabled)
 *
 * Idempotency: each milestone fires only once. The cron uses
 * renewal_reminder_count to track the number of reminders sent and
 * only sends if the contract hasn't received a reminder at this tier yet.
 *
 * Tier mapping:
 *   Count 0 → 60-day reminder (first)
 *   Count 1 → 30-day reminder (second)
 *   Count 2 → 15-day reminder (third)
 *   Count 3 → 7-day  reminder (urgent)
 *
 * Contracts are skipped if:
 *   - Already renewed (status = "renewed")
 *   - Renewal declined
 *   - Not active
 *   - A renewal draft already exists (parent_contract_id → this contract)
 */

const REMINDER_TIERS = [
  { daysOut: 60, tier: 0, label: "60-day" },
  { daysOut: 30, tier: 1, label: "30-day" },
  { daysOut: 15, tier: 2, label: "15-day" },
  { daysOut: 7,  tier: 3, label: "7-day" },
];

function isAuthorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Today in IST
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayIST = istNow.toISOString().slice(0, 10);

  // For each tier, compute the target end_date
  // e.g. 60-day tier: contracts ending on todayIST + 60 days
  const tierTargets = REMINDER_TIERS.map((t) => {
    const target = new Date(istNow);
    target.setDate(target.getDate() + t.daysOut);
    return { ...t, targetDate: target.toISOString().slice(0, 10) };
  });

  // Fetch all active contracts ending within the next 60 days that haven't
  // been declined or fully reminded (count < 4)
  const sixtyDaysOut = tierTargets[0].targetDate;

  const { data: contracts, error: fetchErr } = await admin
    .from("contracts")
    .select(`
      id, contract_number, end_date, lead_id, location_id,
      renewal_reminder_count, renewal_declined, escalation_percentage,
      lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, phone, mobile),
      location:locations!contracts_location_id_fkey(name)
    `)
    .eq("status", "active")
    .eq("renewal_declined", false)
    .gte("end_date", todayIST)
    .lte("end_date", sixtyDaysOut)
    .lt("renewal_reminder_count", 4);

  if (fetchErr) {
    console.error("[renewal-reminders] fetch error:", fetchErr);
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  if (!contracts || contracts.length === 0) {
    return NextResponse.json({ message: "No reminders to send", sent: 0 });
  }

  // Check which of these already have a renewal draft in progress
  const contractIds = contracts.map((c) => c.id);
  const { data: existingRenewals } = await admin
    .from("contracts")
    .select("parent_contract_id")
    .in("parent_contract_id", contractIds)
    .in("status", ["draft", "sent", "viewed", "accepted", "active"]);

  const hasRenewalDraft = new Set(
    (existingRenewals || []).map((r) => r.parent_contract_id)
  );

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app";
  let sentCount = 0;
  const results: { contract: string; tier: string; channels: string[] }[] = [];

  for (const contract of contracts) {
    // Skip if a renewal draft already exists
    if (hasRenewalDraft.has(contract.id)) continue;

    const currentCount = contract.renewal_reminder_count || 0;
    const endDate = contract.end_date;

    // Find the highest tier this contract qualifies for
    // e.g. if end_date is 12 days away, they qualify for 15-day tier (tier 2)
    // but only send if currentCount <= that tier
    let matchedTier: (typeof tierTargets)[number] | null = null;
    for (const tier of tierTargets) {
      if (endDate <= tier.targetDate && currentCount <= tier.tier) {
        matchedTier = tier;
      }
    }

    if (!matchedTier) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = contract.lead as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loc = contract.location as any;
    if (!lead) continue;

    const customerName = `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || lead.company || "Customer";
    const customerEmail = lead.email;
    const customerPhone = lead.mobile || lead.phone;
    const endDateFormatted = new Date(endDate + "T00:00:00+05:30").toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    });
    const daysRemaining = Math.ceil(
      (new Date(endDate + "T00:00:00+05:30").getTime() - istNow.getTime()) / (24 * 60 * 60 * 1000)
    );
    const escalation = contract.escalation_percentage || 0;
    const locationName = loc?.name || "The Work Villa";
    const contractUrl = `${appUrl}/contracts/${contract.id}`;

    const channels: string[] = [];

    // ── 1. Email to customer ──────────────────────────────────────────────
    if (customerEmail) {
      const isUrgent = daysRemaining <= 7;
      const headerBg = isUrgent ? "#dc2626" : "#f59e0b";
      const headerLabel = isUrgent ? "Urgent: Contract Expiring Soon" : "Contract Renewal Reminder";

      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: [customerEmail],
          cc: ["admin@theworkvilla.com"],
          subject: `${isUrgent ? "⚠️ " : ""}Renewal Reminder — ${contract.contract_number} expires ${endDateFormatted}`,
          html: `
            <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
              <div style="background:${headerBg};padding:20px 32px;">
                <h1 style="color:white;margin:0;font-size:20px;">${headerLabel}</h1>
                <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px;">${contract.contract_number} — ${locationName}</p>
              </div>
              <div style="padding:28px 32px;">
                <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
                <p style="color:#333;font-size:14px;">
                  Your workspace contract <strong>${contract.contract_number}</strong> at
                  <strong>${locationName}</strong> is ending on
                  <strong>${endDateFormatted}</strong> — that's
                  <strong>${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</strong> from now.
                </p>
                ${escalation > 0 ? `
                <p style="color:#666;font-size:13px;">
                  As per the agreement, the renewal rental includes a ${escalation}% annual escalation.
                </p>` : ""}
                <p style="color:#333;font-size:14px;">
                  To continue uninterrupted workspace access, please reach out to discuss your renewal.
                  We'd love to continue having you at The Work Villa!
                </p>
                <p style="color:#666;font-size:13px;margin-top:20px;">
                  If you've already spoken with us about renewal, you can disregard this message.
                </p>
              </div>
              <div style="background:#015E65;padding:12px 32px;text-align:center;">
                <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The Work Villa</p>
              </div>
            </div>
          `,
        });
        channels.push("email");
      } catch (err) {
        console.error(`[renewal-reminders] email failed for ${contract.contract_number}:`, err);
      }
    }

    // ── 2. WhatsApp ───────────────────────────────────────────────────────
    if (customerPhone) {
      try {
        const waResult = await sendWhatsApp({
          to: customerPhone,
          template: "contract_renewal",
          params: [customerName, endDateFormatted],
          entityType: "contract",
          entityId: contract.id,
        });
        if (waResult.success) channels.push("whatsapp");
      } catch (err) {
        console.error(`[renewal-reminders] WhatsApp failed for ${contract.contract_number}:`, err);
      }
    }

    // ── 3. DLT SMS ────────────────────────────────────────────────────────
    if (customerPhone) {
      try {
        const smsResult = await dltSms.contractRenewal(
          customerPhone,
          customerName,
          endDateFormatted,
          contract.id
        );
        if (smsResult.success) channels.push("sms");
      } catch (err) {
        console.error(`[renewal-reminders] SMS failed for ${contract.contract_number}:`, err);
      }
    }

    // ── 4. Update reminder tracking on contract ───────────────────────────
    const newCount = matchedTier.tier + 1; // tier 0 → count 1, tier 3 → count 4
    await admin
      .from("contracts")
      .update({
        renewal_reminder_count: newCount,
        renewal_reminder_sent_at: new Date().toISOString(),
      })
      .eq("id", contract.id);

    sentCount++;
    results.push({
      contract: contract.contract_number,
      tier: matchedTier.label,
      channels,
    });
  }

  // ── 5. Staff summary email ────────────────────────────────────────────
  if (sentCount > 0) {
    const summaryRows = results.map((r) => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${r.contract}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${r.tier}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${r.channels.join(", ") || "none"}</td>
      </tr>
    `).join("");

    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: ["admin@theworkvilla.com"],
        subject: `Renewal Reminders Sent — ${sentCount} contract(s) on ${todayIST}`,
        html: `
          <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <div style="background:#015E65;padding:20px 32px;">
              <h1 style="color:white;margin:0;font-size:20px;">Renewal Reminders Summary</h1>
              <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px;">${todayIST} — ${sentCount} reminder(s) sent</p>
            </div>
            <div style="padding:28px 32px;">
              <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <tr style="background:#f0fdfa;">
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#065f46;font-size:11px;">Contract</th>
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#065f46;font-size:11px;">Tier</th>
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#065f46;font-size:11px;">Channels</th>
                </tr>
                ${summaryRows}
              </table>
            </div>
            <div style="background:#015E65;padding:12px 32px;text-align:center;">
              <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The Work Villa</p>
            </div>
          </div>
        `,
      });
    } catch (err) {
      console.error("[renewal-reminders] summary email failed:", err);
    }
  }

  return NextResponse.json({
    message: `Sent ${sentCount} renewal reminder(s)`,
    sent: sentCount,
    details: results,
  });
}
