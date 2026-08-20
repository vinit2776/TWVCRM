import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CASE_STATUS_GROUPS } from "@/lib/constants";

const GROUP_ORDER = ["intake", "review_approval", "execution", "active", "closed"];

const STATUS_TO_GROUP: Record<string, string> = {};
for (const [groupKey, group] of Object.entries(CASE_STATUS_GROUPS)) {
  for (const status of group.statuses) STATUS_TO_GROUP[status] = groupKey;
}

/**
 * GET /api/aggregators/[id]/case-summary
 *
 * Case list + pipeline-stage breakdown for an aggregator's Cases tab — gives
 * visibility into referrals still stuck before "Active", which never show up
 * on the Billing tab (that only lists BILLABLE_CASE_STATUSES).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: cases, error } = await supabase
    .from("cases")
    .select("id, case_number, client_name, client_company_name, purpose, status, rate, created_at")
    .eq("aggregator_id", id)
    .order("case_number", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type CaseRow = {
    id: string;
    case_number: string;
    client_name: string;
    client_company_name: string | null;
    purpose: string;
    status: string;
    rate: number | null;
    created_at: string;
  };

  const byGroup = new Map<string, CaseRow[]>();
  for (const key of GROUP_ORDER) byGroup.set(key, []);

  for (const c of cases || []) {
    const groupKey = STATUS_TO_GROUP[c.status] ?? "closed";
    byGroup.get(groupKey)?.push(c);
  }

  const groups = GROUP_ORDER.map((key) => ({
    key,
    label: CASE_STATUS_GROUPS[key].label,
    count: byGroup.get(key)?.length ?? 0,
    cases: byGroup.get(key) ?? [],
  }));

  return NextResponse.json({ data: { total: cases?.length ?? 0, groups } });
}
