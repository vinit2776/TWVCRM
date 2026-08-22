import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  createRenewalBillingStatement,
  createRenewalRazorpayLink,
  sendRenewalEmail,
  sendRenewalWhatsApp,
  logRenewalReminder,
  generateRenewalPI,
  type VoCaseForRenewal,
} from "@/lib/vo-renewal";
import { generateDiscontinuationDrafts } from "@/lib/vo-discontinuation";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { withCronHealth } from "@/lib/cron-ping";

/**
 * VO Renewal cron — SCHEDULE CURRENTLY DISABLED in vercel.json.
 *
 * Removed from the cron list by 00525, which backfilled cases.end_date. Until
 * that backfill, every stage here selected nothing (they all compare end_date,
 * which was NULL on all 58 cases) so the job was inert. With expiry dates
 * populated it would start selecting cases immediately — and it notifies
 * caseData.client_email / client_phone directly, with no concept of an
 * aggregator. 51 of 58 cases are billed to a postpaid aggregator who owns the
 * client relationship, so its first live run would email 51 partners' clients
 * asking them for renewal money.
 *
 * Re-add the schedule once recipients route by billing party. Until then the
 * endpoint stays callable by hand, and ?dry_run=1 reports what it would do.
 *
 * Every stage below also filters on cases.renewal_notices_enabled, which 00526
 * set to false for every case that predates the end_date backfill. Those
 * expiry dates were derived by a migration rather than agreed with anyone, and
 * some are already in the past — so no automated notice may go out about them,
 * however this job is invoked. New cases default to true.
 *
 * Ran daily at 9:30 AM IST (4:00 AM UTC) when scheduled.
 *
 * Handles four scenarios in one pass:
 *   1. active cases 30 days from end_date → renewal_due + Reminder 1 + PI
 *   2. renewal_due cases at Day −21, −14, −7 → next reminder + fresh Razorpay link
 *   3. renewal_due cases past end_date → grace_period + final notice PI
 *   4. grace_period cases past grace_ends_at → lapsed + discontinuation drafts
 */
async function handler(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminSupabase = await createAdminClient();
  const todayIST = getTodayIST();

  // ?dry_run=1 — run every selection query for real, then stop before any
  // side effect and report what would have happened. Each matched case here
  // otherwise creates a billing statement AND a live Razorpay payment link
  // AND emails AND WhatsApps the customer, so there is no safe way to
  // rehearse this against production without an explicit mode.
  //
  // Added because this cron had never once selected a row in production: it
  // opens on status = 'active', and until the case pipeline became
  // event-derived no case ever reached that state. Its first real run will
  // therefore be its first run ever, against live customers.
  const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";

  const results = {
    dryRun,
    renewalOpened: [] as string[],
    remindersSent: [] as string[],
    graceStarted: [] as string[],
    lapsed: [] as string[],
    errors: [] as string[],
    /** Populated only on a dry run: why each active case is or isn't eligible. */
    diagnostics: [] as Record<string, unknown>[],
  };

  // -------------------------------------------------------------------------
  // 1. Open renewal window: active cases where end_date = today + 30 days
  // -------------------------------------------------------------------------
  const openDate = addDays(todayIST, 30);
  const { data: openCases } = await adminSupabase
    .from("cases")
    .select("*, location:locations!cases_location_id_fkey(name, address, city, state)")
    .eq("status", "active")
    .eq("renewal_notices_enabled", true)
    .eq("end_date", openDate)
    .not("end_date", "is", null);

  for (const c of openCases ?? []) {
    try {
      const caseDataDry = c as VoCaseForRenewal;
      if (dryRun) {
        results.renewalOpened.push(`${caseDataDry.case_number} (would open renewal: statement + Razorpay link + email + WhatsApp)`);
        continue;
      }
      const caseData = c as VoCaseForRenewal;
      const { statementId, piNumber, totalAmount, dueDate, periodStart, periodEnd } =
        await openRenewalStatement(adminSupabase, caseData, 1);

      const razorpayLink = await createRenewalRazorpayLink({
        adminSupabase,
        caseData,
        statementId,
        totalAmount,
        dueDate,
        piNumber,
      });

      const pdfBuffer = generateRenewalPI({
        caseData,
        piNumber,
        periodStart,
        periodEnd,
        dueDate,
        razorpayUrl: razorpayLink.url,
      });

      const [emailSent, whatsAppSent] = await Promise.all([
        sendRenewalEmail({
          caseData,
          reminderNumber: 1,
          isGraceNotice: false,
          piNumber,
          periodStart,
          periodEnd,
          totalAmount,
          razorpayUrl: razorpayLink.url,
          pdfBuffer,
        }),
        sendRenewalWhatsApp({
          caseData,
          isGraceNotice: false,
          piNumber,
          totalAmount,
          razorpayUrl: razorpayLink.url,
          pdfBuffer,
          supabase: adminSupabase,
        }),
      ]);

      await adminSupabase
        .from("cases")
        .update({
          status: "renewal_due",
          renewal_billing_statement_id: statementId,
          renewal_razorpay_link_id: razorpayLink.id,
          renewal_razorpay_link_url: razorpayLink.url,
          renewal_reminder_count: 1,
          renewal_last_reminder_at: new Date().toISOString(),
        })
        .eq("id", caseData.id);

      await logRenewalReminder({
        adminSupabase,
        caseId: caseData.id,
        reminderNumber: 1,
        statementId,
        razorpayLinkId: razorpayLink.id,
        razorpayLinkUrl: razorpayLink.url,
        emailSent,
        whatsAppSent,
        isGraceNotice: false,
      });

      results.renewalOpened.push(caseData.case_number);
    } catch (err) {
      results.errors.push(`open:${c.case_number}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Follow-up reminders: renewal_due, end_date in future, Day −21/−14/−7
  // -------------------------------------------------------------------------
  const { data: pendingCases } = await adminSupabase
    .from("cases")
    .select("*, location:locations!cases_location_id_fkey(name, address, city, state)")
    .eq("status", "renewal_due")
    .eq("renewal_notices_enabled", true)
    .gt("end_date", todayIST)
    .lt("renewal_reminder_count", 4);

  for (const c of pendingCases ?? []) {
    try {
      const caseDataDry = c as VoCaseForRenewal;
      if (dryRun) {
        results.remindersSent.push(`${caseDataDry.case_number} (would send next reminder + fresh Razorpay link)`);
        continue;
      }
      const caseData = c as VoCaseForRenewal & { renewal_reminder_count: number };
      const daysLeft = daysBetween(todayIST, c.end_date);

      if (![21, 14, 7].includes(daysLeft)) continue;

      const nextCount = caseData.renewal_reminder_count + 1;
      const piNumber = buildPiNumber(caseData.case_number, nextCount);
      const periodStart = caseData.end_date; // same period
      const periodEnd = addMonths(caseData.end_date, caseData.tenure_months ?? 12);
      const dueDate = addDays(todayIST, 7);
      const totalAmount = computeTotal(caseData.rate);

      // Fresh Razorpay link for each reminder
      const razorpayLink = await createRenewalRazorpayLink({
        adminSupabase,
        caseData,
        statementId: caseData.renewal_billing_statement_id!,
        totalAmount,
        dueDate,
        piNumber,
      });

      const pdfBuffer = generateRenewalPI({
        caseData,
        piNumber,
        periodStart,
        periodEnd,
        dueDate,
        razorpayUrl: razorpayLink.url,
      });

      const ccAccounts = nextCount >= 4;
      const [emailSent, whatsAppSent] = await Promise.all([
        sendRenewalEmail({
          caseData,
          reminderNumber: nextCount,
          isGraceNotice: false,
          piNumber,
          periodStart,
          periodEnd,
          totalAmount,
          razorpayUrl: razorpayLink.url,
          pdfBuffer,
        }).then(async (ok) => {
          // CC accounts on final reminder
          if (ok && ccAccounts) {
            await resend.emails.send({
              from: EMAIL_FROM,
              to: ["accounts@theworkvilla.com"],
              subject: `[Action Required] VO Renewal Final Reminder — ${caseData.case_number}`,
              html: `<p>Case <strong>${caseData.case_number}</strong> (${caseData.client_name}) has not renewed. This is the 4th and final reminder. End date: <strong>${caseData.end_date}</strong>.</p>`,
            });
          }
          return ok;
        }),
        sendRenewalWhatsApp({
          caseData,
          isGraceNotice: false,
          piNumber,
          totalAmount,
          razorpayUrl: razorpayLink.url,
          pdfBuffer,
          supabase: adminSupabase,
        }),
      ]);

      await adminSupabase
        .from("cases")
        .update({
          renewal_razorpay_link_id: razorpayLink.id,
          renewal_razorpay_link_url: razorpayLink.url,
          renewal_reminder_count: nextCount,
          renewal_last_reminder_at: new Date().toISOString(),
        })
        .eq("id", caseData.id);

      await logRenewalReminder({
        adminSupabase,
        caseId: caseData.id,
        reminderNumber: nextCount,
        statementId: caseData.renewal_billing_statement_id!,
        razorpayLinkId: razorpayLink.id,
        razorpayLinkUrl: razorpayLink.url,
        emailSent,
        whatsAppSent,
        isGraceNotice: false,
      });

      results.remindersSent.push(`${caseData.case_number}:R${nextCount}`);
    } catch (err) {
      results.errors.push(`reminder:${c.case_number}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Move to grace_period: renewal_due where end_date <= today
  // -------------------------------------------------------------------------
  const { data: expiredCases } = await adminSupabase
    .from("cases")
    .select("*, location:locations!cases_location_id_fkey(name, address, city, state)")
    .eq("status", "renewal_due")
    .eq("renewal_notices_enabled", true)
    .lte("end_date", todayIST);

  for (const c of expiredCases ?? []) {
    try {
      const caseDataDry = c as VoCaseForRenewal;
      if (dryRun) {
        results.graceStarted.push(`${caseDataDry.case_number} (would enter grace period + final notice)`);
        continue;
      }
      const caseData = c as VoCaseForRenewal;
      const graceEnds = addDays(todayIST, 7);
      const piNumber = buildPiNumber(caseData.case_number, 5); // final notice
      const periodStart = caseData.end_date;
      const periodEnd = addMonths(caseData.end_date, caseData.tenure_months ?? 12);
      const totalAmount = computeTotal(caseData.rate);
      const dueDate = graceEnds;

      // Reuse existing billing statement or create one
      let statementId = caseData.renewal_billing_statement_id;
      if (!statementId) {
        statementId = await createRenewalBillingStatement({
          adminSupabase,
          caseData,
          periodStart,
          periodEnd,
          dueDate,
          piNumber,
        });
      }

      const razorpayLink = await createRenewalRazorpayLink({
        adminSupabase,
        caseData,
        statementId,
        totalAmount,
        dueDate,
        piNumber,
      });

      const pdfBuffer = generateRenewalPI({
        caseData,
        piNumber,
        periodStart,
        periodEnd,
        dueDate,
        razorpayUrl: razorpayLink.url,
      });

      const [emailSent, whatsAppSent] = await Promise.all([
        sendRenewalEmail({
          caseData,
          reminderNumber: 5,
          isGraceNotice: true,
          piNumber,
          periodStart,
          periodEnd,
          totalAmount,
          razorpayUrl: razorpayLink.url,
          pdfBuffer,
        }),
        sendRenewalWhatsApp({
          caseData,
          isGraceNotice: true,
          piNumber,
          totalAmount,
          razorpayUrl: razorpayLink.url,
          pdfBuffer,
          supabase: adminSupabase,
        }),
      ]);

      await adminSupabase
        .from("cases")
        .update({
          status: "grace_period",
          renewal_billing_statement_id: statementId,
          renewal_razorpay_link_id: razorpayLink.id,
          renewal_razorpay_link_url: razorpayLink.url,
          renewal_grace_ends_at: new Date(graceEnds).toISOString(),
          renewal_last_reminder_at: new Date().toISOString(),
        })
        .eq("id", caseData.id);

      await logRenewalReminder({
        adminSupabase,
        caseId: caseData.id,
        reminderNumber: 5,
        statementId,
        razorpayLinkId: razorpayLink.id,
        razorpayLinkUrl: razorpayLink.url,
        emailSent,
        whatsAppSent,
        isGraceNotice: true,
      });

      results.graceStarted.push(caseData.case_number);
    } catch (err) {
      results.errors.push(`grace:${c.case_number}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Lapse: grace_period cases where grace_ends_at <= today
  // -------------------------------------------------------------------------
  const { data: graceExpired } = await adminSupabase
    .from("cases")
    .select("*, location:locations!cases_location_id_fkey(name, address, city, state)")
    .eq("status", "grace_period")
    .eq("renewal_notices_enabled", true)
    .lte("renewal_grace_ends_at", new Date().toISOString());

  for (const c of graceExpired ?? []) {
    try {
      const caseDataDry = c as VoCaseForRenewal;
      if (dryRun) {
        results.lapsed.push(`${caseDataDry.case_number} (would lapse + generate discontinuation drafts)`);
        continue;
      }
      const caseData = c as VoCaseForRenewal;
      const location = caseData.location as { name: string; address?: string; city?: string; state?: string } | null;
      const locationName = location?.name ?? "The WorkVilla";
      const locationAddress = [location?.address, location?.city, location?.state]
        .filter(Boolean)
        .join(", ") || "Chennai";

      // Generate all discontinuation documents as drafts
      await generateDiscontinuationDrafts({
        adminSupabase,
        caseId: caseData.id,
        caseNumber: caseData.case_number,
        clientName: caseData.client_name,
        clientCompanyName: caseData.client_company_name,
        clientGstin: caseData.client_gst_number,
        clientCin: null,
        locationName,
        locationAddress,
        effectiveDate: caseData.end_date,
        purpose: caseData.purpose,
      });

      await adminSupabase
        .from("cases")
        .update({
          status: "lapsed",
          renewal_grace_ends_at: null,
        })
        .eq("id", caseData.id);

      // Notify admin and accounts to review and approve the draft documents
      await resend.emails.send({
        from: EMAIL_FROM,
        to: ["admin@theworkvilla.com", "accounts@theworkvilla.com"],
        subject: `[Action Required] VO Case Lapsed — ${caseData.case_number} — ${caseData.client_name}`,
        html: `
          <p>The Virtual Office Agreement for <strong>${caseData.client_company_name || caseData.client_name}</strong> (Case: ${caseData.case_number}) has lapsed after the grace period with no renewal.</p>
          <p><strong>Action required:</strong></p>
          <ol>
            <li>Review and approve the draft discontinuation documents in the CRM (Cases → ${caseData.case_number} → Documents tab).</li>
            <li>Send the Discontinuation Notice and Dos & Don'ts to the client by email.</li>
            <li>Dispatch the Authority Notification letter(s) by registered post and record the postal tracking number in the CRM.</li>
          </ol>
          <p>Login to the CRM to review: <a href="${process.env.NEXT_PUBLIC_APP_URL}/cases/${caseData.id}">Open Case</a></p>
        `,
      });

      results.lapsed.push(caseData.case_number);
    } catch (err) {
      results.errors.push(`lapse:${c.case_number}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("[cron/vo-renewal] Result:", JSON.stringify(results));

  // On a dry run, also explain every case the cron could ever act on. A case
  // that reaches 'active' without an end_date is invisible to all four stages
  // — every one of them compares end_date or renewal_grace_ends_at, and SQL
  // comparisons are never true against NULL — so it renews never and lapses
  // never, silently running on indefinitely.
  if (dryRun) {
    const { data: liveCases } = await adminSupabase
      .from("cases")
      .select("case_number, status, start_date, end_date, tenure_months, renewal_reminder_count, client_email")
      .in("status", ["active", "renewal_due", "grace_period"]);

    for (const c of liveCases ?? []) {
      const endDate = c.end_date as string | null;
      if (!endDate) {
        results.diagnostics.push({
          case: c.case_number,
          status: c.status,
          eligible: false,
          reason: "end_date is NULL — no stage of this cron can ever select it",
          fix: c.start_date && c.tenure_months
            ? `derivable: ${c.start_date} + ${c.tenure_months} months`
            : "start_date or tenure_months also missing",
        });
        continue;
      }
      const daysToEnd = Math.round(
        (new Date(endDate).getTime() - new Date(todayIST).getTime()) / 86_400_000
      );
      results.diagnostics.push({
        case: c.case_number,
        status: c.status,
        eligible: true,
        end_date: endDate,
        days_to_end: daysToEnd,
        renewal_opens_on: addDays(endDate, -30),
        next_action:
          daysToEnd > 30 ? `nothing until ${addDays(endDate, -30)}`
          : daysToEnd >= 0 ? "renewal window open — reminders due"
          : "past end_date — grace/lapse handling due",
        would_notify: c.client_email ?? "(no email on file)",
      });
    }
  }

  return NextResponse.json({
    success: true,
    date: todayIST,
    ...results,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTodayIST(): string {
  // toLocaleDateString, not toLocaleString round-tripped through new Date().
  // en-CA's date-time form is "2026-08-22, 9:47:31 p.m.", which Date cannot
  // parse — it yields Invalid Date and .toISOString() throws RangeError,
  // killing this cron on its first line of work before it reads a single
  // case. cron_health recorded exactly that. The date-only form returns
  // "2026-08-22" directly, with no parsing round-trip to get wrong.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
}

function daysBetween(from: string, to: string): number {
  const msPerDay = 86400000;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / msPerDay);
}

function computeTotal(rate: number): number {
  return Math.round(rate * 1.18 * 100) / 100;
}

function buildPiNumber(caseNumber: string, sequence: number): string {
  const now = new Date();
  return `TWV/VO/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}/${caseNumber}-R${sequence}`;
}

async function openRenewalStatement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminSupabase: any,
  caseData: VoCaseForRenewal,
  reminderNumber: number
) {
  const periodStart = caseData.end_date;
  const periodEnd = addMonths(caseData.end_date, caseData.tenure_months ?? 12);
  const dueDate = addDays(getTodayIST(), 7);
  const piNumber = buildPiNumber(caseData.case_number, reminderNumber);
  const totalAmount = computeTotal(caseData.rate);

  const statementId = await createRenewalBillingStatement({
    adminSupabase,
    caseData,
    periodStart,
    periodEnd,
    dueDate,
    piNumber,
  });

  return { statementId, piNumber, totalAmount, dueDate, periodStart, periodEnd };
}

export const GET = withCronHealth("cron/vo-renewal", handler);
