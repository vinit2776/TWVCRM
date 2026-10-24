import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { listOpenJourneys } from "@/lib/journey/open-journeys";
import { ownersForRole } from "@/lib/journey/roles";
import { istDate } from "@/lib/journey/due";

export interface NextStepItem {
  leadId: string;
  customer: string;
  ref: string;
  stepKey: string;
  label: string;
  hint?: string;
  detail?: string;
  href?: string;
  ctaLabel?: string;
  /** false = waiting on someone else; shown muted. */
  actionable: boolean;
  /** YYYY-MM-DD an onboarding step is due (activation + 2 days). */
  due?: string;
  since: string;
}

/**
 * GET /api/dashboard/next-steps
 *
 * Customer-journey steps that belong to the caller's role. Read-only. Steps the
 * caller can do now come first; steps owned by them but blocked come after, so
 * (for example) IT can see a voucher is waiting on a signed agreement.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ data: [] });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ data: [] });

  const owners = ownersForRole(dbUser.role);
  if (owners.length === 0) return NextResponse.json({ data: [] });

  const open = await listOpenJourneys(createAdminClient());

  const items: NextStepItem[] = [];
  for (const o of open) {
    for (const phase of o.journey.phases) {
      for (const s of phase.steps) {
        if (!owners.includes(s.owner)) continue;
        if (!s.actionable && s.state !== "blocked") continue;
        items.push({
          leadId: o.leadId,
          customer: o.customer,
          ref: o.ref,
          stepKey: s.key,
          label: s.label,
          hint: s.hint,
          detail: s.detail,
          href: s.href,
          ctaLabel: s.ctaLabel,
          actionable: s.actionable,
          due: s.due,
          since: o.since,
        });
      }
    }
  }

  // Doable first; within those, steps past their due date first (most overdue
  // on top), then oldest first so the longest-waiting customer is on top.
  const today = istDate(new Date());
  const lateness = (i: NextStepItem) => (i.due && i.due < today ? i.due : "9999-12-31");
  items.sort(
    (a, b) =>
      Number(b.actionable) - Number(a.actionable) ||
      lateness(a).localeCompare(lateness(b)) ||
      a.since.localeCompare(b.since)
  );

  return NextResponse.json({ data: items.slice(0, 50) });
}
