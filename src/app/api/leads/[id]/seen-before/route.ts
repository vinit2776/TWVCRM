import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import type { SeenBeforeData } from "@/lib/seen-before";

// GET /api/leads/[id]/seen-before?exclude=<enquiryId>
// What the team already knows about this customer, for the check panel: the lead's status and owner,
// their other enquiries, the last few touches, proposals and contracts. Read-only, and only the few
// fields the strip shows leave here.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Bad lead id" }, { status: 400 });
  const exclude = new URL(request.url).searchParams.get("exclude");
  if (exclude && !/^[0-9a-f-]{36}$/i.test(exclude)) return NextResponse.json({ error: "Bad enquiry id" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (me.role === ENQUIRY_VIEWER_ROLE) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [lead, enquiries, activities, proposals, contracts] = await Promise.all([
    supabase.from("leads").select("status, lost_reason, junk_reason, owner:users!leads_assigned_to_fkey(full_name)").eq("id", id).single(),
    supabase.from("lead_enquiries").select("id, reference, received_at").eq("lead_id", id).order("received_at", { ascending: false }).limit(6),
    supabase
      .from("activities")
      .select("type, subject, created_at")
      .eq("lead_id", id)
      .in("type", ["call", "meeting", "note", "email", "tour"])
      .order("created_at", { ascending: false })
      .limit(3),
    supabase.from("proposals").select("proposal_number, status").eq("lead_id", id).order("created_at", { ascending: false }).limit(5),
    supabase.from("contracts").select("contract_number, status, end_date").eq("lead_id", id).order("created_at", { ascending: false }).limit(5),
  ]);
  if (lead.error || !lead.data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  for (const r of [enquiries, activities, proposals, contracts]) {
    if (r.error) {
      console.error("[seen-before] load failed", r.error.code, r.error.message);
      return NextResponse.json({ error: "Could not load the history" }, { status: 500 });
    }
  }

  const owner = (Array.isArray(lead.data.owner) ? lead.data.owner[0] : lead.data.owner) as { full_name: string } | null;
  const data: SeenBeforeData = {
    lead: {
      status: lead.data.status as string,
      lost_reason: (lead.data.lost_reason as string | null) ?? null,
      junk_reason: (lead.data.junk_reason as string | null) ?? null,
      owner_name: owner?.full_name ?? null,
    },
    earlier: (enquiries.data ?? []).filter((e) => e.id !== exclude).map((e) => ({ reference: e.reference as string, received_at: e.received_at as string })),
    activities: (activities.data ?? []).map((a) => ({ type: a.type as string, subject: (a.subject as string | null) ?? null, created_at: a.created_at as string })),
    proposals: (proposals.data ?? []).map((p) => ({ proposal_number: (p.proposal_number as string | null) ?? null, status: p.status as string })),
    contracts: (contracts.data ?? []).map((c) => ({ contract_number: (c.contract_number as string | null) ?? null, status: c.status as string, end_date: c.end_date as string })),
  };
  return NextResponse.json({ data });
}
