import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — Customer segmentation
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");

  // Fetch all non-cancelled bookings with lead info
  let query = supabase
    .from("bookings")
    .select("id, lead_id, booking_date, total_amount, status, customer_type, lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, phone)")
    .not("status", "eq", "cancelled")
    .not("lead_id", "is", null);

  if (locationId) query = query.eq("location_id", locationId);
  const { data: bookings } = await query;

  // Fetch feedback
  const { data: feedbacks } = await supabase
    .from("booking_feedbacks")
    .select("lead_id, overall_rating")
    .not("overall_rating", "is", null);

  // Aggregate per lead
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadMap: Record<string, any> = {};
  (bookings || []).forEach(b => {
    if (!b.lead_id) return;
    if (!leadMap[b.lead_id]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = b.lead as any;
      leadMap[b.lead_id] = {
        lead_id: b.lead_id,
        name: lead ? `${lead.first_name} ${lead.last_name}` : "Unknown",
        company: lead?.company || null,
        phone: lead?.phone || null,
        total_bookings: 0,
        total_spent: 0,
        last_visit: null,
        feedback_sum: 0,
        feedback_count: 0,
      };
    }
    leadMap[b.lead_id].total_bookings++;
    leadMap[b.lead_id].total_spent += Number(b.total_amount);
    if (!leadMap[b.lead_id].last_visit || b.booking_date > leadMap[b.lead_id].last_visit) {
      leadMap[b.lead_id].last_visit = b.booking_date;
    }
  });

  // Add feedback data
  (feedbacks || []).forEach(f => {
    if (f.lead_id && leadMap[f.lead_id]) {
      leadMap[f.lead_id].feedback_sum += f.overall_rating || 0;
      leadMap[f.lead_id].feedback_count++;
    }
  });

  const leads = Object.values(leadMap);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split("T")[0];

  // Frequent: 5+ bookings in last 90 days
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frequent = leads.filter((l: any) => {
    const recentCount = (bookings || []).filter(
      b => b.lead_id === l.lead_id && b.booking_date >= ninetyDaysAgo
    ).length;
    return recentCount >= 5;
  });

  // Lapsed: no bookings in 60+ days
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lapsed = leads.filter((l: any) => l.last_visit && l.last_visit < sixtyDaysAgo);

  // High spenders: top 20%
  const sortedBySpend = [...leads].sort((a, b) => b.total_spent - a.total_spent);
  const top20Pct = Math.max(1, Math.ceil(leads.length * 0.2));
  const highSpenders = sortedBySpend.slice(0, top20Pct);

  // Low feedback: avg rating < 2.5
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lowFeedback = leads.filter((l: any) => {
    if (l.feedback_count === 0) return false;
    return (l.feedback_sum / l.feedback_count) < 2.5;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapCustomer = (l: any) => ({
    lead_id: l.lead_id,
    name: l.name,
    company: l.company,
    phone: l.phone,
    total_bookings: l.total_bookings,
    total_spent: Math.round(l.total_spent),
    last_visit: l.last_visit,
    avg_feedback: l.feedback_count > 0 ? Math.round((l.feedback_sum / l.feedback_count) * 10) / 10 : null,
  });

  return NextResponse.json({
    data: [
      {
        segment: "frequent",
        label: "Frequent Visitors",
        description: "5+ bookings in last 90 days",
        count: frequent.length,
        customers: frequent.map(mapCustomer),
      },
      {
        segment: "lapsed",
        label: "Lapsed Customers",
        description: "No bookings in 60+ days",
        count: lapsed.length,
        customers: lapsed.map(mapCustomer),
      },
      {
        segment: "high_spender",
        label: "High Spenders",
        description: "Top 20% by total spend",
        count: highSpenders.length,
        customers: highSpenders.map(mapCustomer),
      },
      {
        segment: "low_feedback",
        label: "Low Feedback",
        description: "Average rating below 2.5",
        count: lowFeedback.length,
        customers: lowFeedback.map(mapCustomer),
      },
    ],
  });
}
