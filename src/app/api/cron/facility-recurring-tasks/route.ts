import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { generateIssueNumber, logIssueEvent } from "@/lib/facility";
import { logAudit } from "@/lib/audit";
import { notifyIssueAssignee } from "@/lib/facility-notifications";
import type { FacilityIssuePriority, TaskRecurrenceCadence } from "@/types";

/**
 * GET /api/cron/facility-recurring-tasks
 * Runs daily at 6:00 AM IST (see vercel.json). Spawns a real facility_issues
 * row (task_type = 'recurring_instance') for each active task_recurrence_rule
 * whose cadence is due today, unless skip_if_open finds the previous
 * instance still unresolved.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();

  // "Today" in IST (UTC+5:30) — same idiom as every other cron in this repo
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const dayOfWeek = istNow.getUTCDay();   // 0=Sunday..6=Saturday (IST wall-clock, via the shift above)
  const dayOfMonth = istNow.getUTCDate();

  // Due end of today, IST — spawned instances are due same-day by default.
  const endOfDayIst = new Date(Date.UTC(
    istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 23, 59, 59
  ));
  const slaTargetAt = new Date(endOfDayIst.getTime() - istOffset).toISOString();

  const { data: rules, error } = await supabase
    .from("task_recurrence_rules")
    .select(`
      id, title, description, location_id, assigned_to, priority,
      cadence_type, day_of_week, day_of_month, skip_if_open, created_by
    `)
    .eq("is_active", true);

  if (error) {
    console.error("[facility-recurring-tasks] query failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const dueRules = (rules ?? []).filter((rule) => {
    const cadence = rule.cadence_type as TaskRecurrenceCadence;
    if (cadence === "daily") return true;
    if (cadence === "weekly") return rule.day_of_week === dayOfWeek;
    if (cadence === "monthly") return rule.day_of_month === dayOfMonth;
    return false;
  });

  let spawned = 0;
  let skipped = 0;

  for (const rule of dueRules) {
    if (rule.skip_if_open) {
      const { data: openInstance } = await supabase
        .from("facility_issues")
        .select("id")
        .eq("recurrence_rule_id", rule.id)
        .not("status", "in", "(resolved,closed)")
        .limit(1)
        .maybeSingle();
      if (openInstance) {
        skipped++;
        continue;
      }
    }

    const issueNumber = await generateIssueNumber(supabase, "facility");

    const { data: issue, error: insertErr } = await supabase
      .from("facility_issues")
      .insert({
        issue_number: issueNumber,
        scope: "facility",
        category_id: null,
        location_id: rule.location_id,
        title: rule.title,
        description: rule.description,
        priority: rule.priority,
        status: "new",
        reported_by: rule.created_by,
        reported_via: "proactive",
        task_type: "recurring_instance",
        recurrence_rule_id: rule.id,
        assigned_to: rule.assigned_to,
        assigned_at: now.toISOString(),
        assigned_by: rule.created_by,
        sla_target_at: slaTargetAt,
      })
      .select("id, issue_number, title")
      .single();

    if (insertErr || !issue) {
      console.error(`[facility-recurring-tasks] spawn failed for rule ${rule.id}:`, insertErr?.message);
      continue;
    }

    await logIssueEvent(supabase, {
      issueId: issue.id,
      eventType: "created",
      actorId: rule.created_by,
      message: `Spawned from recurring rule: ${rule.title}`,
      payload: { recurrence_rule_id: rule.id },
    });

    logAudit(supabase, {
      entityType: "facility_issue",
      entityId: issue.id,
      action: "create",
      performedBy: rule.created_by,
      changes: { recurrence_rule_id: { old: null, new: rule.id } },
    });

    await notifyIssueAssignee(
      {
        id: issue.id, category_id: null, assigned_to: rule.assigned_to,
        issue_number: issue.issue_number, title: issue.title,
      },
      { type: "created", priority: rule.priority as FacilityIssuePriority, reportedBy: "Recurring task" }
    );

    await supabase
      .from("task_recurrence_rules")
      .update({ last_spawned_at: now.toISOString() })
      .eq("id", rule.id);

    spawned++;
  }

  console.log(`[facility-recurring-tasks] checked ${dueRules.length} due rule(s), spawned ${spawned}, skipped ${skipped}`);
  return NextResponse.json({ checked: dueRules.length, spawned, skipped });
}
