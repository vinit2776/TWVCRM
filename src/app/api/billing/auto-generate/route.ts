import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateRentProformas, generateUsageStatements, type GenerateResult } from "@/lib/billing";

type AdminClient = ReturnType<typeof createAdminClient>;
type GenMode = "rent" | "usage" | "both";

/**
 * Run the requested generator(s) SEQUENTIALLY (not concurrently). Each
 * generator's per-contract loop is already sequential, but running rent + usage
 * concurrently let a brand-new contract race on the MAX()+1 statement_number
 * trigger. Each generator is independently try/caught so a thrown one never
 * aborts the other.
 *
 * Mode lets the caller pick exactly one flow:
 *   - "rent"  → only generateRentProformas. Used by the Monthly Rent Proforma
 *               card (runs on the last working day, dispatches live).
 *   - "usage" → only generateUsageStatements. Used by the Monthly Usage Drafts
 *               card (runs AFTER month-end so all charges are captured).
 *   - "both"  → backward compatibility / cron path.
 */
async function runGenerators(
  client: AdminClient,
  opts: { month?: number; year?: number; contractId?: string; dryRun?: boolean; mode?: GenMode },
): Promise<{ rent: GenerateResult; usage: GenerateResult }> {
  const m = opts.month ?? 0, y = opts.year ?? 0;
  const mode: GenMode = opts.mode ?? "both";
  const empty = (err?: string): GenerateResult => ({
    month: m, year: y, generated: 0, skipped: 0, errors: err ? [err] : [],
    statementIds: [], noContact: [], notDelivered: [], cycleSkipped: [], superseded: [], alreadySent: [], preview: [],
  });

  let rent: GenerateResult = empty();
  if (mode === "rent" || mode === "both") {
    try { rent = await generateRentProformas(client, opts); }
    catch (e) { rent = empty(`rent generator: ${String(e)}`); }
  }

  let usage: GenerateResult = empty();
  if (mode === "usage" || mode === "both") {
    try { usage = await generateUsageStatements(client, opts); }
    catch (e) { usage = empty(`usage generator: ${String(e)}`); }
  }

  return { rent, usage };
}

/**
 * GET — DISABLED. Automatic month-end billing is paused. Proforma generation
 * and dispatch are now manual-only (triggered from the Billing page, which
 * calls the POST handler below). The vercel.json cron entry has been removed;
 * `/api/cron/billing-reminder` only sends a nudge, it never bills.
 *
 * This handler is intentionally inert so that if the endpoint is ever hit
 * (stale cron config, manual curl), it cannot silently auto-dispatch proformas.
 */
export async function GET() {
  return NextResponse.json({
    disabled: true,
    message:
      "Automatic billing is paused. Generate proformas manually from the Billing page " +
      "(Monthly Proforma Billing card), or POST to this endpoint with a valid session.",
  }, { status: 200 });
}

/**
 * POST — manual trigger from the Billing UI (admin/manager/accounts).
 *
 * Body:
 *   { dry_run: false, contract_id, month?, year? }  — run live for ONE contract
 *                                                       (generate + finalize + dispatch).
 *   { dry_run: false, mode: "usage", month?, year? } — run live for the whole
 *                                                       usage batch (drafts only,
 *                                                       never dispatched from here).
 *   { month?, year? }  (or anything else)             — PREVIEW only: compute
 *                                                       amounts/GST and return what
 *                                                       WOULD be generated, writing
 *                                                       nothing and sending nothing.
 *
 * `dry_run` must be the exact boolean `false` to run live — every other value
 * (missing, misspelled, `true`, `"false"`, etc.) is treated as a preview. A
 * whole-batch live RENT run is refused outright; that path is
 * /api/billing/dispatch-run, which queues one job per contract with per-job
 * visibility and retry instead of dispatching everything synchronously in one
 * request. See the inline comment below for why.
 *
 * Live runs send the internal summary email (notifyBillingRun). Dry runs do not.
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
  // Fail-safe default: only an explicit `dry_run: false` runs live. A missing,
  // misspelled (e.g. `dryRun`), or truthy-but-wrong-shaped flag falls back to
  // a preview instead of silently dispatching real proformas — see the
  // 2026-09-01 incident where a hand-typed `dryRun` (camelCase) key was
  // ignored by `=== true` and defaulted straight into a live send.
  const dryRun     = body.dry_run !== false;
  const modeIn     = String(body.mode || "both").toLowerCase();
  const mode: GenMode = (modeIn === "rent" || modeIn === "usage") ? modeIn : "both";

  // Whole-batch live rent sending is disabled on this synchronous endpoint.
  // It dispatches real invoices to every eligible customer in one request with
  // no per-job visibility, retry, or abort — that's what caused the incident
  // above. The supported live-batch path is /api/billing/dispatch-run, which
  // queues one job per contract. A live run here is only allowed when scoped
  // to a single contract_id (the "bill this contract now" action — see
  // contract-invoices-section.tsx) or when mode is usage-only (drafts only,
  // never dispatched to a client from this route).
  if (!dryRun && mode !== "usage" && !contractId) {
    return NextResponse.json({
      error: "Live batch rent generation is disabled on this endpoint — use /api/billing/dispatch-run instead, or pass dry_run: true to preview here.",
    }, { status: 400 });
  }

  const admin = createAdminClient();
  const opts  = { month, year, contractId, dryRun, mode };

  const { rent, usage } = await runGenerators(admin, opts);

  // Live runs notify staff; dry runs are silent previews.
  if (!dryRun && (rent.generated > 0 || usage.generated > 0 || rent.noContact.length > 0)) {
    await notifyBillingRun(admin, rent, usage);
  }

  return NextResponse.json({
    dry_run: dryRun,
    month: rent.month,
    year: rent.year,
    rent_proformas: { generated: rent.generated, skipped: rent.skipped, no_contact: rent.noContact, not_delivered: rent.notDelivered, cycle_skipped: rent.cycleSkipped, superseded: rent.superseded, already_sent: rent.alreadySent, preview: rent.preview },
    usage_statements: { generated: usage.generated, skipped: usage.skipped, superseded: usage.superseded, already_sent: usage.alreadySent, preview: usage.preview },
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

  const notDeliveredHtml = rent.notDelivered.length > 0 ? `
    <div style="background:#f8d7da;border:1px solid #f5c2c7;border-radius:6px;padding:12px 16px;margin:12px 0;font-size:13px;color:#842029;">
      ⚠️ ${rent.notDelivered.length} proforma${rent.notDelivered.length > 1 ? "s were" : " was"} raised but never reached the client:
      <strong>${rent.notDelivered.join(", ")}</strong>
      <br/><br/>These are finalized, so no later billing run will retry them. Resend each one from its statement.
    </div>` : "";

  const cycleSkippedHtml = rent.cycleSkipped.length > 0 ? `
    <p style="color:#666;font-size:12px;">
      ${rent.cycleSkipped.length} advance-billed contract${rent.cycleSkipped.length > 1 ? "s" : ""} not billed this run (expected — quarterly/half-yearly/yearly contracts bill only in their anchor month):
      ${rent.cycleSkipped.join(", ")}
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
        ${notDeliveredHtml}
        ${cycleSkippedHtml}
        ${usage.generated > 0 ? `
        <div style="text-align:center;margin:24px 0;">
          <a href="${appUrl}/billing?tab=usage" style="background:#015E65;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;font-size:14px;">Review Usage Statements</a>
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
