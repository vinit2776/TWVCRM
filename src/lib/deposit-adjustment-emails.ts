import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

interface AdjustmentEmailContext {
  adjustmentId: string;
  amount: number;
  contractNumber: string;
  statementNumber: string;
  depositAvailableAfter: number;
  approvedByName: string;
}

const inr = (n: number) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

/**
 * Notifies every `accounts`-role user once a deposit adjustment is approved,
 * so they can record the corresponding book entry in Tally manually — this
 * feature deliberately does not auto-sync to Tally (see
 * billing-payment-settlement.ts), since a deposit-to-invoice adjustment is
 * an internal book entry, not a real bank/cash movement.
 */
export async function sendDepositAdjustmentAccountsEmail(
  supabase: SupabaseClient,
  ctx: AdjustmentEmailContext
): Promise<boolean> {
  const { data: accountsUsers } = await supabase
    .from("users")
    .select("email")
    .eq("role", "accounts")
    .not("email", "is", null);

  const to = (accountsUsers || []).map((u) => u.email).filter(Boolean);
  if (to.length === 0) return false;

  const subject = `Deposit adjustment approved — ${ctx.contractNumber} (${ctx.statementNumber})`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <p style="color:#333;font-size:14px;">A deposit adjustment has been approved and needs a matching book entry in Tally.</p>
      <table style="border-collapse:collapse;margin:16px 0;width:100%;background:#f5f5f5;border-radius:6px;">
        <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Contract</td><td style="padding:8px 16px;font-weight:bold;border-bottom:1px solid #e5e7eb;">${ctx.contractNumber}</td></tr>
        <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Invoice / Statement</td><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;">${ctx.statementNumber}</td></tr>
        <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Amount adjusted</td><td style="padding:8px 16px;font-weight:bold;border-bottom:1px solid #e5e7eb;">${inr(ctx.amount)}</td></tr>
        <tr><td style="padding:8px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Remaining deposit balance</td><td style="padding:8px 16px;border-bottom:1px solid #e5e7eb;">${inr(ctx.depositAvailableAfter)}</td></tr>
        <tr><td style="padding:8px 16px;color:#666;">Approved by</td><td style="padding:8px 16px;">${ctx.approvedByName}</td></tr>
      </table>
      <p style="color:#666;font-size:12px;">Adjustment ID: ${ctx.adjustmentId}</p>
    </div>`;

  try {
    await resend.emails.send({ from: EMAIL_FROM, to, replyTo: EMAIL_REPLY_TO, subject, html });
    return true;
  } catch (err) {
    console.error("[deposit-adjustment-emails] accounts notification failed:", err);
    return false;
  }
}

/**
 * Polished, external-facing customer confirmation — opt-in only. Must never
 * disclose who approved the adjustment or any internal reason/notes; only
 * the amount, the invoice it settled, and the resulting deposit balance.
 * Branding matches the deposit-collection email (deposit-link/route.ts) for
 * a consistent customer-facing look.
 */
export async function sendDepositAdjustmentCustomerEmail(
  ctx: AdjustmentEmailContext & { customerName: string; to: string[] }
): Promise<boolean> {
  if (ctx.to.length === 0) return false;

  const subject = `Deposit adjustment confirmation — ${ctx.contractNumber} — The WorkVilla`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Deposit Adjustment Confirmation</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${ctx.customerName},</p>
        <p style="color:#333;font-size:14px;">This is to confirm that a part of your security deposit has been adjusted towards your outstanding invoice, as below.</p>
        <table style="border-collapse:collapse;margin:20px 0;width:100%;background:#f0faf5;border-radius:6px;">
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Invoice</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${ctx.statementNumber}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Amount adjusted</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;font-size:18px;">${inr(ctx.amount)}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;">Remaining deposit balance</td><td style="padding:10px 16px;color:#333;">${inr(ctx.depositAvailableAfter)}</td></tr>
        </table>
        <p style="color:#333;font-size:14px;">If you have any questions about this adjustment, please reach out to us and we'll be happy to help.</p>
        <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>`;

  try {
    await resend.emails.send({ from: EMAIL_FROM, to: ctx.to, replyTo: EMAIL_REPLY_TO, subject, html });
    return true;
  } catch (err) {
    console.error("[deposit-adjustment-emails] customer notification failed:", err);
    return false;
  }
}
