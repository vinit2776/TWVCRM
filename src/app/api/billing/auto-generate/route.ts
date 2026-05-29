import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";
import { generateRentProformas, generateUsageStatements, type GenerateResult } from "@/lib/billing";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Run both generators SEQUENTIALLY (not concurrently). Each generator's per-contract
 * loop is already sequential, but running the two concurrently let a brand-new
 * contract's rent + usage inserts race on the MAX()+1 statement_number trigger,
 * causing a duplicate-key collision that drops one proforma. Sequential execution
 * removes that race. Each generator is independently try/caught so a thrown one
 * never aborts the other.
 */
async function runGenerators(
  client: AdminClient,
  opts: { month?: number; year?: number; contractId?: string },
): Promise<{ rent: GenerateResult; usage: GenerateResult }> {
  const m = opts.month ?? 0, y = opts.year ?? 0;
  const empty = (err: string): GenerateResult => ({
    month: m, year: y, generated: 0, skipped: 0, errors: [err],
    statementIds: [], noContact: [], quarterlySkipped: [],
  });

  let rent: GenerateResult;
  try { rent = await generateRentProformas(client, opts); }
  catch (e) { rent = empty(`rent generator: ${String(e)}`); }

  let usage: GenerateResult;
  try { usage = await generateUsageStatements(client, opts); }
  catch (e) { usage = empty(`usage generator: ${String(e)}`); }

  return { rent, usage };
}

/**
 * GET — cron-triggered. Runs two generators:
 *   1. generateRentProformas  — auto-finalizes + dispatches rent proformas to clients
 *   2. generateUsageStatements — creates draft usage statements for admin review
 *
 * Cron runs daily on 28th–31st at 15:30 UTC (21:00 IST). The handler checks
 * if today (IST) is actually the last day of the month. If not, returns early.
 *
 * Query: ?month=4&year=2026 (defaults to current month IST)
 *        ?force=1           (skip the last-day guard — for manual backfills)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month") ? parseInt(searchParams.get("month")!) : undefined;
  const year  = searchParams.get("year")  ? parseInt(searchParams.get("year")!)  : undefined;
  const force = searchParams.get("force") === "1";

  // Last-day-of-month guard
  if (!force && !month && !year) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + IST_OFFSET_MS);
    const todayDate = nowIST.getUTCDate();
    const daysInThisMonth = new Date(nowIST.getUTCFullYear(), nowIST.getUTCMonth() + 1, 0).getDate();

    if (todayDate !== daysInThisMonth) {
      return NextResponse.json({
        skipped_reason: `Not the last day of month (day ${todayDate} of ${daysInThisMonth})`,
      });
    }
  }

  const supabase = createAdminClient();
  const opts = { month, year };

  const { rent, usage } = await runGenerators(supabase, opts);

  const totalGenerated = rent.generated + usage.generated;
  const totalSkipped   = rent.skipped   + usage.skipped;
  const allErrors      = [...rent.errors, ...usage.errors];

  if (totalGenerated > 0 || rent.noContact.length > 0 || usage.generated > 0) {
    await notifyBillingRun(supabase, rent, usage);
  }

  await pingCronHealth("billing/auto-generate", "ok", {
    month: rent.month, year: rent.year,
    rent_generated: rent.generated, usage_generated: usage.generated,
    skipped: totalSkipped, no_contact: rent.noContact.length,
  });

  return NextResponse.json({
    month: rent.month,
    year: rent.year,
    rent_proformas: { generated: rent.generated, skipped: rent.skipped, no_contact: rent.noContact, quarterly_skipped: rent.quarterlySkipped },
    usage_statements: { generated: usage.generated, skipped: usage.skipped },
    errors: allErrors.length > 0 ? allErrors : undefined,
  });
}

/**
 * POST — manual trigger from the Billing UI (admin/manager/accounts).
 * Body: { month?, year?, contract_id? }
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
  const month      = body.month      ? parseInt(String(body.month)) : undefined;
  const year       = body.year       ? parseInt(String(body.year))  : undefined;
  const contractId = body.contract_id || undefined;

  const admin = createAdminClient();
  const opts  = { month, year, contractId };

  const { rent, usage } = await runGenerators(admin, opts);

  return NextResponse.json({
    month: rent.month,
    year: rent.year,
    rent_proformas: { generated: rent.generated, skipped: rent.skipped, no_contact: rent.noContact, quarterly_skipped: rent.quarterlySkipped },
    usage_statements: { generated: usage.generated, skipped: usage.skipped },
    errors: [...rent.errors, ...usage.errors].length > 0 ? [...rent.errors, ...usage.errors] : undefined,
    statement_ids: [...rent.statementIds, ...usage.statementIds],
  });
}

/** Email accounts/managers/admins after the cron run — split counts clearly. */
async function notifyBillingRun(
  supabase: ReturnType<typeof createAdminClient>,
  rent: GenerateResult,
  usage: GenerateResult,
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

  const monthLabel = new Date(rent.year, rent.month - 1)
    .toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "long", year: "numeric" });
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  const noContactHtml = rent.noContact.length > 0 ? `
    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin:12px 0;font-size:13px;color:#856404;">
      ⚠️ <strong>${rent.noContact.length} contract${rent.noContact.length > 1 ? "s" : ""} have no email or phone — proforma not sent:</strong>
      ${rent.noContact.map((c) => `<br/>• ${c}`).join("")}
      <br/><br/>Update the lead record to enable auto-send next month.
    </div>` : "";

  const quarterlyHtml = rent.quarterlySkipped.length > 0 ? `
    <p style="color:#666;font-size:12px;">
      ${rent.quarterlySkipped.length} quarterly contract${rent.quarterlySkipped.length > 1 ? "s" : ""} not billed this cycle (expected — not their billing month):
      ${rent.quarterlySkipped.join(", ")}
    </p>` : "";

  const errorHtml = [...rent.errors, ...usage.errors].length > 0 ? `
    <div style="background:#f8d7da;border:1px solid #f5c2c7;border-radius:6px;padding:12px 16px;margin:12px 0;font-size:13px;color:#842029;">
      ❌ Errors: ${[...rent.errors, ...usage.errors].join(", ")}
    </div>` : "";

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:20px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Monthly Billing Run — ${monthLabel}</p>
      </div>
      <div style="padding:32px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
          <tr style="background:#f0fdf4;">
            <td style="padding:10px 12px;border:1px solid #d1fae5;font-weight:600;">✅ Rent proformas sent to clients</td>
            <td style="padding:10px 12px;border:1px solid #d1fae5;text-align:right;font-weight:700;">${rent.generated}</td>
          </tr>
          <tr style="background:#fff7ed;">
            <td style="padding:10px 12px;border:1px solid #fed7aa;font-weight:600;">🟠 Usage statements needing your review</td>
            <td style="padding:10px 12px;border:1px solid #fed7aa;text-align:right;font-weight:700;">${usage.generated}</td>
          </tr>
        </table>
        ${noContactHtml}
        ${errorHtml}
        ${quarterlyHtml}
        ${usage.generated > 0 ? `
        <div style="text-align:center;margin:24px 0;">
          <a href="${appUrl}/billing?tab=statements&type=usage" style="background:#015E65;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;font-size:14px;">Review Usage Statements</a>
        </div>` : ""}
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
      </div>
    </div>`;

  for (const email of emails) {
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [email],
      subject: `Billing Run Complete — ${rent.generated} proformas sent, ${usage.generated} usage statements pending — ${monthLabel}`,
      html,
    }).catch(console.error);
  }
}

export const maxDuration = 300;
