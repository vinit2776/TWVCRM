import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit, logEmailActivity } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { withCronHealth } from "@/lib/cron-ping";
import {
  buildNudgeEmail,
  computeFollowupActions,
  effectiveExpiryDate,
  istDate,
  type FollowupProposal,
} from "@/lib/proposal-followups";

/**
 * GET /api/cron/proposal-followups
 *
 * Daily (10:30 IST) — for proposals still waiting on the customer:
 *   day 3   email nudge 1 to the customer (rep in CC)
 *   day 5   in-app prompt to the rep to call
 *   day 10  email nudge 2 ("expires in N days")
 *   lapsed  status -> expired (sent/viewed only; paid proposals are untouched)
 *
 * Customer emails only go out while app_settings.proposal_followups_enabled is
 * 'true' (ships 'false'). Each step stamps its own column first, so a repeat
 * run or an overlapping run can never send the same nudge twice.
 */

type Row = FollowupProposal & {
  id: string;
  proposal_number: string;
  title: string;
  created_by: string | null;
  lead_id: string | null;
  location: { name: string } | null;
  lead: {
    first_name: string | null;
    email: string | null;
    assigned_to: string | null;
  } | null;
};

type Person = { id: string; full_name: string | null; email: string | null; phone: string | null };

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: setting } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "proposal_followups_enabled")
    .maybeSingle();
  if (setting?.value !== "true") {
    return NextResponse.json({ skipped: "proposal_followups_enabled is off" });
  }

  const { data, error } = await admin
    .from("proposals")
    .select(
      "id, proposal_number, title, status, sent_at, valid_until, payment_status, deposit_payment_status, nudge_1_sent_at, nudge_2_sent_at, rep_followup_notified_at, created_by, lead_id, location:locations(name), lead:leads!proposals_lead_id_fkey(first_name, email, assigned_to)"
    )
    .in("status", ["sent", "viewed"]);
  if (error) {
    console.error("[proposal-followups] fetch error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Row[];
  const now = new Date();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();

  const personIds = [...new Set(rows.flatMap((r) => [r.lead?.assigned_to, r.created_by]).filter(Boolean) as string[])];
  const people = new Map<string, Person>();
  if (personIds.length > 0) {
    const { data: ppl } = await admin.from("users").select("id, full_name, email, phone").in("id", personIds);
    for (const p of (ppl ?? []) as Person[]) people.set(p.id, p);
  }

  const { data: managers } = await admin
    .from("users")
    .select("id")
    .in("role", ["admin", "manager"])
    .eq("is_active", true);
  const managerIds = (managers ?? []).map((m) => m.id as string);

  const tally = { expired: 0, nudge1: 0, nudge2: 0, repPrompts: 0, failed: 0 };

  for (const row of rows) {
    const actions = computeFollowupActions(row, now);
    const rep =
      (row.lead?.assigned_to && people.get(row.lead.assigned_to)) ||
      (row.created_by && people.get(row.created_by)) ||
      null;
    const notifyIds = rep ? [rep.id] : managerIds;
    const url = `/proposals/${row.id}`;

    try {
      if (actions.expire) {
        const { data: flipped } = await admin
          .from("proposals")
          .update({ status: "expired", expired_at: now.toISOString() })
          .eq("id", row.id)
          .in("status", ["sent", "viewed"])
          .select("id");
        if (flipped && flipped.length > 0) {
          tally.expired++;
          logAudit(admin, {
            entityType: "proposal",
            entityId: row.id,
            action: "proposal_expired",
            performedBy: "system",
            changes: { status: { old: row.status, new: "expired" } },
          });
          await createNotificationsForUsers(notifyIds, {
            type: "proposal_followup",
            title: `Proposal expired: ${row.proposal_number}`,
            body: `${row.title} lapsed with no response. Extend it from the proposal page to revive it.`,
            url,
            entityType: "proposal",
            entityId: row.id,
          });
        }
        continue;
      }

      if (actions.notifyRep) {
        const { data: claimed } = await admin
          .from("proposals")
          .update({ rep_followup_notified_at: now.toISOString() })
          .eq("id", row.id)
          .is("rep_followup_notified_at", null)
          .select("id");
        if (claimed && claimed.length > 0) {
          await createNotificationsForUsers(notifyIds, {
            type: "proposal_followup",
            title: `Call the customer: ${row.proposal_number}`,
            body: `${row.title} was sent 5+ days ago with no decision. Call and log the outcome.`,
            url,
            entityType: "proposal",
            entityId: row.id,
          });
          tally.repPrompts++;
        }
      }

      const nudge: 1 | 2 | null = actions.nudge2 ? 2 : actions.nudge1 ? 1 : null;
      if (nudge && row.lead?.email) {
        const col = nudge === 1 ? "nudge_1_sent_at" : "nudge_2_sent_at";
        const { data: claimed } = await admin
          .from("proposals")
          .update({ [col]: now.toISOString() })
          .eq("id", row.id)
          .is(col, null)
          .select("id");
        if (!claimed || claimed.length === 0) continue;

        const expiry = effectiveExpiryDate(row);
        const daysLeft = expiry
          ? Math.round((new Date(`${expiry}T00:00:00Z`).getTime() - new Date(`${istDate(now)}T00:00:00Z`).getTime()) / 86_400_000)
          : null;
        const { subject, html } = buildNudgeEmail({
          nudge,
          customerFirstName: row.lead.first_name ?? "",
          proposalNumber: row.proposal_number,
          title: row.title,
          locationName: row.location?.name ?? null,
          sentDate: istDate(new Date(row.sent_at as string)),
          validUntil: row.valid_until ? row.valid_until.slice(0, 10) : null,
          daysLeft,
          repName: rep?.full_name || "The WorkVilla team",
          repEmail: rep?.email ?? null,
          repPhone: rep?.phone ?? null,
          trackingUrl: `${appUrl}/api/proposals/${row.id}/track`,
        });

        const { error: sendError } = await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: rep?.email || EMAIL_REPLY_TO,
          to: [row.lead.email],
          ...(rep?.email ? { cc: [rep.email] } : {}),
          subject,
          html,
        });

        if (sendError) {
          // Release the claim so tomorrow's run retries.
          await admin.from("proposals").update({ [col]: null }).eq("id", row.id);
          console.error("[proposal-followups] send failed:", row.proposal_number, sendError.message);
          tally.failed++;
          continue;
        }

        if (nudge === 1) tally.nudge1++; else tally.nudge2++;
        if (row.lead_id && rep?.id) {
          logEmailActivity(admin, {
            leadId: row.lead_id,
            subject: `Proposal ${row.proposal_number} reminder ${nudge} sent`,
            description: `Automatic reminder emailed to the customer for "${row.title}" (${row.proposal_number}).`,
            createdBy: rep.id,
          });
        }
      }
    } catch (err) {
      console.error("[proposal-followups] row failed:", row.proposal_number, err);
      tally.failed++;
    }
  }

  return NextResponse.json({ checked: rows.length, ...tally });
}

export const GET = withCronHealth("cron/proposal-followups", handler);
