import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createLeadSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { messaging } from "@/lib/whatsapp";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const source = searchParams.get("source");
  const search = searchParams.get("search");
  const assigned_to = searchParams.get("assigned_to");
  const rating = searchParams.get("rating");
  const location_id = searchParams.get("location_id");
  const sort_by = searchParams.get("sort_by") || "created_at";
  const sort_order = searchParams.get("sort_order") || "desc";

  const offset = (page - 1) * limit;

  let query = supabase
    .from("leads")
    .select("*, assigned_user:users!leads_assigned_to_fkey(*), location:locations!leads_location_id_fkey(id, name, code)", {
      count: "exact",
    });

  if (status) query = query.eq("status", status);
  if (source) query = query.eq("source", source);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (rating) query = query.eq("rating", rating);
  if (location_id) query = query.eq("location_id", location_id);
  if (search) {
    if (search.startsWith("#")) {
      query = query.eq("id", search.slice(1));
    } else {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,company.ilike.%${search}%`
      );
    }
  }

  const ascending = sort_order === "asc";
  query = query
    .order(sort_by, { ascending })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Attach followup status flags for each lead
  const leads = data || [];
  if (leads.length > 0) {
    const leadIds = leads.map((l: { id: string }) => l.id);
    const { data: followups } = await supabase
      .from("activities")
      .select("lead_id, follow_up_date")
      .in("lead_id", leadIds)
      .eq("is_follow_up_done", false)
      .not("follow_up_date", "is", null);

    if (followups && followups.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const fMap: Record<string, { overdue: boolean; due_today: boolean; upcoming: boolean }> = {};
      for (const f of followups) {
        const d = (f.follow_up_date as string).slice(0, 10);
        if (!fMap[f.lead_id]) fMap[f.lead_id] = { overdue: false, due_today: false, upcoming: false };
        if (d < today) fMap[f.lead_id].overdue = true;
        else if (d === today) fMap[f.lead_id].due_today = true;
        else fMap[f.lead_id].upcoming = true;
      }
      leads.forEach((l: { id: string; _followup?: unknown }) => {
        l._followup = fMap[l.id] || null;
      });
    }

    // Sort: overdue first → due today → upcoming → rest (preserves DB order within each group)
    leads.sort((a: { _followup?: { overdue: boolean; due_today: boolean; upcoming: boolean } | null }, b: { _followup?: { overdue: boolean; due_today: boolean; upcoming: boolean } | null }) => {
      const priority = (f: typeof a._followup) => {
        if (!f) return 3;
        if (f.overdue) return 0;
        if (f.due_today) return 1;
        if (f.upcoming) return 2;
        return 3;
      };
      return priority(a._followup) - priority(b._followup);
    });
  }

  return NextResponse.json({
    data: leads,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = createLeadSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  // Get the user's internal ID
  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const { data, error } = await supabase
    .from("leads")
    .insert({
      ...result.data,
      created_by: dbUser?.id,
      assigned_to: result.data.assigned_to || dbUser?.id,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "lead",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });

    // WhatsApp alert to all staff with a phone number — fire-and-forget
    (async () => {
      const { data: staffList } = await supabase
        .from("users")
        .select("phone")
        .not("phone", "is", null)
        .neq("phone", "");

      const leadName = `${data.first_name} ${data.last_name}`.trim();
      const company  = data.company ?? "—";
      const source   = data.source  ?? "direct";

      staffList?.forEach((staff) => {
        if (staff.phone) {
          messaging.internalNewLead(staff.phone, leadName, company, source, data.id)
            .catch(console.error);
        }
      });
    })();
  }

  return NextResponse.json({ data }, { status: 201 });
}
