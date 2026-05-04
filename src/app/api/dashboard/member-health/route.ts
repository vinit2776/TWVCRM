import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/member-health
 * Aggregates booking_feedbacks (last 90 days) per lead to surface members
 * with poor renewal_likelihood or low overall scores. Returns top at-risk
 * members + overall trend.
 *
 * Access: admin, manager.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const since = new Date();
  since.setDate(since.getDate() - 90);

  const { data, error } = await adminSupabase
    .from("booking_feedbacks")
    .select(
      "id, lead_id, overall_rating, renewal_likelihood, space_etiquette, payment_discipline, community_behavior, created_at, lead:leads(first_name, last_name, company)"
    )
    .gte("created_at", since.toISOString());

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string;
    lead_id: string | null;
    overall_rating: number | null;
    renewal_likelihood: number | null;
    space_etiquette: number | null;
    payment_discipline: number | null;
    community_behavior: number | null;
    created_at: string;
    lead: { first_name: string; last_name: string; company: string | null } | null;
  };

  const rows = (data ?? []) as unknown as Row[];

  // Aggregate per lead
  const byLead = new Map<
    string,
    {
      lead_id: string;
      name: string;
      avg_overall: number;
      avg_renewal: number;
      ratings: number;
      lowest: number;
    }
  >();

  for (const r of rows) {
    if (!r.lead_id || !r.lead) continue;
    const key = r.lead_id;
    const existing = byLead.get(key);
    const overall = Number(r.overall_rating ?? 0);
    const renewal = Number(r.renewal_likelihood ?? 0);
    if (!existing) {
      byLead.set(key, {
        lead_id: r.lead_id,
        name: `${r.lead.first_name} ${r.lead.last_name}${r.lead.company ? ` · ${r.lead.company}` : ""}`,
        avg_overall: overall,
        avg_renewal: renewal,
        ratings: 1,
        lowest: overall,
      });
    } else {
      existing.avg_overall =
        (existing.avg_overall * existing.ratings + overall) / (existing.ratings + 1);
      existing.avg_renewal =
        (existing.avg_renewal * existing.ratings + renewal) / (existing.ratings + 1);
      existing.ratings += 1;
      existing.lowest = Math.min(existing.lowest, overall);
    }
  }

  const all = Array.from(byLead.values());

  // At-risk: avg_renewal <= 2.5 OR avg_overall <= 2.5
  const atRisk = all.filter((m) => m.avg_renewal <= 2.5 || m.avg_overall <= 2.5);
  atRisk.sort((a, b) => a.avg_renewal - b.avg_renewal);

  const totalMembers = all.length;
  const avgRenewal =
    all.length > 0 ? all.reduce((s, m) => s + m.avg_renewal, 0) / all.length : 0;
  const avgOverall =
    all.length > 0 ? all.reduce((s, m) => s + m.avg_overall, 0) / all.length : 0;
  const promoters = all.filter((m) => m.avg_renewal >= 4).length;
  const detractors = all.filter((m) => m.avg_renewal <= 2).length;

  return NextResponse.json({
    data: {
      total_members_rated: totalMembers,
      total_ratings: rows.length,
      avg_renewal_likelihood: Math.round(avgRenewal * 10) / 10,
      avg_overall_rating: Math.round(avgOverall * 10) / 10,
      promoters,
      detractors,
      at_risk: atRisk.slice(0, 5).map((m) => ({
        lead_id: m.lead_id,
        name: m.name,
        avg_overall: Math.round(m.avg_overall * 10) / 10,
        avg_renewal: Math.round(m.avg_renewal * 10) / 10,
        ratings: m.ratings,
      })),
    },
  });
}
