import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

/**
 * GET /api/billing/auto-generate
 * Cron-triggered: generates draft billing statements for all active contracts
 * whose billing period falls in the target month.
 * Query params: ?month=4&year=2026 (defaults to current month IST)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Default to current month in IST
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const targetMonth = parseInt(searchParams.get("month") || String(istNow.getMonth() + 1));
  const targetYear = parseInt(searchParams.get("year") || String(istNow.getFullYear()));

  const firstOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-01`;
  const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
  const lastOfMonth = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${daysInMonth}`;

  const supabase = await createAdminClient();

  // 1. Ensure accounting period exists
  const { data: existingPeriod } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("year", targetYear)
    .eq("month", targetMonth)
    .single();

  let periodId = existingPeriod?.id;
  if (!periodId) {
    const { data: newPeriod } = await supabase
      .from("accounting_periods")
      .insert({ year: targetYear, month: targetMonth, status: "open" })
      .select("id")
      .single();
    periodId = newPeriod?.id;
  }

  // 2. Fetch active contracts whose tenure overlaps this month
  const { data: contracts } = await supabase
    .from("contracts")
    .select(`
      id, contract_number, title, total_amount, subtotal, tax_percentage, tax_amount,
      billing_cycle, start_date, end_date, next_billing_date, seats,
      location_id, lead_id,
      lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number)
    `)
    .eq("status", "active")
    .lte("start_date", lastOfMonth)
    .gte("end_date", firstOfMonth);

  if (!contracts || contracts.length === 0) {
    return NextResponse.json({ generated: 0, skipped: 0, message: "No active contracts for this period" });
  }

  // 3. Check which contracts already have a billing statement for this period
  const contractIds = contracts.map((c) => c.id);
  const { data: existingStatements } = await supabase
    .from("billing_statements")
    .select("contract_id")
    .in("contract_id", contractIds)
    .gte("period_start", firstOfMonth)
    .lte("period_start", lastOfMonth);

  const alreadyBilled = new Set((existingStatements || []).map((s) => s.contract_id));

  // 4. Generate drafts
  let generated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const contract of contracts) {
    if (alreadyBilled.has(contract.id)) {
      skipped++;
      continue;
    }

    try {
      // Calculate proration
      const contractStart = new Date(contract.start_date + "T00:00:00Z");
      const contractEnd = new Date(contract.end_date + "T00:00:00Z");
      const monthStart = new Date(firstOfMonth + "T00:00:00Z");
      const monthEnd = new Date(lastOfMonth + "T00:00:00Z");

      const billableStart = contractStart > monthStart ? contractStart : monthStart;
      const billableEnd = contractEnd < monthEnd ? contractEnd : monthEnd;
      const billableDays = Math.floor((billableEnd.getTime() - billableStart.getTime()) / 86400000) + 1;

      let fixedAmount: number;
      if (billableDays >= daysInMonth) {
        fixedAmount = Number(contract.subtotal || contract.total_amount);
      } else {
        fixedAmount = Math.round(Number(contract.subtotal || contract.total_amount) / daysInMonth * billableDays * 100) / 100;
      }

      // Fetch pending usage charges for this contract in the period
      const { data: usageCharges } = await supabase
        .from("usage_charges")
        .select("id, total")
        .eq("contract_id", contract.id)
        .eq("status", "pending")
        .gte("charge_date", firstOfMonth)
        .lte("charge_date", lastOfMonth);

      const usageAmount = (usageCharges || []).reduce((s, c) => s + Number(c.total || 0), 0);

      // Fetch facility usage records for this period
      let facilityAmount = 0;
      if (periodId) {
        const { data: facilityRecords } = await supabase
          .from("facility_usage_records")
          .select("total_charge")
          .eq("contract_id", contract.id)
          .eq("accounting_period_id", periodId);

        facilityAmount = (facilityRecords || []).reduce((s, r) => s + Number(r.total_charge || 0), 0);
      }

      // Calculate totals
      const subtotal = fixedAmount + usageAmount + facilityAmount;
      const taxPercentage = Number(contract.tax_percentage || 18);

      // GST split: intra-state (TN) vs inter-state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = contract.lead as any;
      const buyerState = (lead?.state || "").toLowerCase().trim();
      const isInterstate = buyerState !== "" && buyerState !== "tamil nadu" && buyerState !== "tn";

      let cgst = 0, sgst = 0, igst = 0;
      if (isInterstate) {
        igst = Math.round(subtotal * (taxPercentage / 100) * 100) / 100;
      } else {
        cgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
        sgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
      }
      const taxAmount = cgst + sgst + igst;
      const totalAmount = subtotal + taxAmount;

      // Insert draft billing statement
      const { data: statement, error: insertErr } = await supabase
        .from("billing_statements")
        .insert({
          contract_id: contract.id,
          lead_id: contract.lead_id,
          period_start: billableStart.toISOString().slice(0, 10),
          period_end: billableEnd.toISOString().slice(0, 10),
          fixed_amount: fixedAmount,
          usage_amount: usageAmount + facilityAmount,
          subtotal,
          tax_percentage: taxPercentage,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          status: "draft",
          accounting_period_id: periodId,
          cgst_amount: cgst,
          sgst_amount: sgst,
          igst_amount: igst,
          is_interstate: isInterstate,
          buyer_gstin: lead?.gst_number || null,
          place_of_supply: isInterstate ? (lead?.state || "Other") : "Tamil Nadu",
        })
        .select("id")
        .single();

      if (insertErr) {
        errors.push(`${contract.contract_number}: ${insertErr.message}`);
        continue;
      }

      // Link usage charges to this statement
      if (usageCharges && usageCharges.length > 0 && statement) {
        const chargeIds = usageCharges.map((c) => c.id);
        await supabase
          .from("usage_charges")
          .update({ billing_statement_id: statement.id, status: "billed" })
          .in("id", chargeIds);
      }

      generated++;
    } catch (err) {
      errors.push(`${contract.contract_number}: ${String(err)}`);
    }
  }

  // 5. Notify accounts/managers about draft bills
  if (generated > 0) {
    const { data: recipients } = await supabase
      .from("users")
      .select("email, full_name")
      .in("role", ["admin", "manager", "accounts"])
      .eq("is_active", true);

    const emails = (recipients || []).map((r) => r.email).filter(Boolean);
    const monthLabel = new Date(targetYear, targetMonth - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

    if (emails.length > 0) {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

      for (const email of emails) {
        resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: [email],
          subject: `${generated} Draft Bills Ready for Review — ${monthLabel}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
              <div style="background:#015E65;padding:20px 32px;">
                <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
                <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Monthly Billing</p>
              </div>
              <div style="padding:32px;">
                <p style="color:#333;font-size:14px;"><strong>${generated} draft billing statement${generated > 1 ? "s" : ""}</strong> have been auto-generated for <strong>${monthLabel}</strong>.</p>
                <p style="color:#333;font-size:14px;">Please review each draft, add any missing usage charges, then click <strong>"Confirm & Send Invoice"</strong> to finalize and email the GST invoice to the customer.</p>
                ${skipped > 0 ? `<p style="color:#666;font-size:13px;">${skipped} contract${skipped > 1 ? "s" : ""} already had a statement for this period and were skipped.</p>` : ""}
                ${errors.length > 0 ? `<p style="color:#e53e3e;font-size:13px;">Errors: ${errors.join(", ")}</p>` : ""}
                <div style="text-align:center;margin:24px 0;">
                  <a href="${appUrl}/billing" style="background:#015E65;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;font-size:14px;">Review Draft Bills</a>
                </div>
              </div>
              <div style="background:#015E65;padding:12px 32px;text-align:center;">
                <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
              </div>
            </div>`,
        }).catch(console.error);
      }
    }
  }

  return NextResponse.json({
    month: targetMonth,
    year: targetYear,
    generated,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export const maxDuration = 60;
