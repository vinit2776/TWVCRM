import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";
import { generateMonthlyStatements } from "@/lib/billing";

/**
 * GET — cron-triggered. Generates draft billing statements for all active
 * contracts whose tenure overlaps the target month.
 *
 * Query: ?month=4&year=2026 (defaults to current month IST)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month") ? parseInt(searchParams.get("month")!) : undefined;
  const year = searchParams.get("year") ? parseInt(searchParams.get("year")!) : undefined;

  const supabase = createAdminClient();
  const result = await generateMonthlyStatements(supabase, { month, year });

  if (result.generated > 0) {
    await notifyDraftBills(supabase, result);
  }

  await pingCronHealth("billing/auto-generate", "ok", {
    month: result.month, year: result.year,
    generated: result.generated, skipped: result.skipped,
  });

  return NextResponse.json({
    month: result.month,
    year: result.year,
    generated: result.generated,
    skipped: result.skipped,
    errors: result.errors.length > 0 ? result.errors : undefined,
  });
}

/**
 * POST — manual trigger from the Billing UI for admin/manager/accounts.
 * Use to backfill missing statements when contracts were activated mid-month
 * after the cron had already run, or to regenerate after fixing data.
 *
 * Body: { month?, year?, contract_id? }
 *   - omit all to generate for "current month, all eligible contracts"
 *   - pass `contract_id` to limit to one contract (used by activation hook)
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const month  = body.month ? parseInt(String(body.month)) : undefined;
  const year   = body.year  ? parseInt(String(body.year))  : undefined;
  const contractId = body.contract_id || undefined;

  // Use the admin client so RLS doesn't block writes when the operator's
  // role permits the action. The role check above is the gate.
  const admin = createAdminClient();
  const result = await generateMonthlyStatements(admin, { month, year, contractId });

  return NextResponse.json({
    month: result.month,
    year: result.year,
    generated: result.generated,
    skipped: result.skipped,
    errors: result.errors.length > 0 ? result.errors : undefined,
    statement_ids: result.statementIds,
  });
}

// Email accounts/managers about freshly-generated draft bills (cron flow only).
async function notifyDraftBills(
  supabase: ReturnType<typeof createAdminClient>,
  result: Awaited<ReturnType<typeof generateMonthlyStatements>>,
) {
  const { data: recipients } = await supabase
    .from("users")
    .select("email, full_name")
    .in("role", ["admin", "manager", "accounts"])
    .eq("is_active", true);

  const emails = (recipients || [])
    .map((r: { email: string }) => r.email)
    .filter(Boolean) as string[];
  if (emails.length === 0) return;

  const monthLabel = new Date(result.year, result.month - 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  for (const email of emails) {
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [email],
      subject: `${result.generated} Draft Bills Ready for Review — ${monthLabel}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:20px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Monthly Billing</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#333;font-size:14px;"><strong>${result.generated} draft billing statement${result.generated > 1 ? "s" : ""}</strong> have been auto-generated for <strong>${monthLabel}</strong>.</p>
            <p style="color:#333;font-size:14px;">Please review each draft, add any missing usage charges, then click <strong>"Confirm & Send Invoice"</strong> to finalize and email the GST invoice to the customer.</p>
            ${result.skipped > 0 ? `<p style="color:#666;font-size:13px;">${result.skipped} contract${result.skipped > 1 ? "s" : ""} already had a statement for this period and were skipped.</p>` : ""}
            ${result.errors.length > 0 ? `<p style="color:#e53e3e;font-size:13px;">Errors: ${result.errors.join(", ")}</p>` : ""}
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

export const maxDuration = 60;
