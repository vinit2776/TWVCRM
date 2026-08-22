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
  const sources = searchParams.get("source")?.split(",").filter(Boolean) ?? [];
  const search = searchParams.get("search");
  const assigned_to = searchParams.get("assigned_to");
  const rating = searchParams.get("rating");
  const location_id = searchParams.get("location_id");
  const sort_by = searchParams.get("sort_by") || "created_at";
  const sort_order = searchParams.get("sort_order") || "desc";
  const phone_exact = searchParams.get("phone_exact");
  const include_archived = searchParams.get("include_archived") === "true";

  // Quick phone lookup — returns just id, id_proof_path fields
  if (phone_exact) {
    const { data } = await supabase
      .from("leads")
      .select("id, first_name, last_name, id_proof_path")
      .or(`phone.eq.${phone_exact.trim()},mobile.eq.${phone_exact.trim()}`)
      .limit(1);
    return NextResponse.json({ data: data ?? [] });
  }

  const offset = (page - 1) * limit;
  const today = new Date().toISOString().slice(0, 10);

  const LEAD_SELECT =
    "*, assigned_user:users!leads_assigned_to_fkey(*), location:locations!leads_location_id_fkey(id, name, code), _pending_followups:activities!activities_lead_id_fkey(follow_up_date, is_follow_up_done)";

  type Followup = { follow_up_date: string | null; is_follow_up_done: boolean };
  type LeadRow = {
    id: string;
    _pending_followups?: Followup[];
    _followup?: { overdue: boolean; due_today: boolean; upcoming: boolean } | null;
  };

  function attachFollowupFlags(rows: LeadRow[]) {
    for (const l of rows) {
      const pending = (l._pending_followups || []).filter(
        (f) => !f.is_follow_up_done && f.follow_up_date
      );
      if (pending.length > 0) {
        const flags = { overdue: false, due_today: false, upcoming: false };
        for (const f of pending) {
          const d = (f.follow_up_date as string).slice(0, 10);
          if (d < today) flags.overdue = true;
          else if (d === today) flags.due_today = true;
          else flags.upcoming = true;
        }
        l._followup = flags;
      }
      // Remove raw embed from the response — downstream code doesn't need it
      delete l._pending_followups;
    }
  }

  // Total count for pagination — unaffected by the overdue-first reordering below, since
  // the priority leads are a subset of this same filtered set, just reordered.
  let countQuery = supabase.from("leads").select("id", { count: "exact", head: true });
  if (!include_archived) countQuery = countQuery.is("archived_at", null);
  if (status) countQuery = countQuery.eq("status", status);
  if (sources.length > 0) countQuery = countQuery.in("source", sources);
  if (assigned_to) countQuery = countQuery.eq("assigned_to", assigned_to);
  if (rating) countQuery = countQuery.eq("rating", rating);
  if (location_id) countQuery = countQuery.eq("location_id", location_id);
  if (search) {
    if (search.startsWith("#")) {
      countQuery = countQuery.eq("id", search.slice(1));
    } else {
      countQuery = countQuery.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,mobile.ilike.%${search}%,company.ilike.%${search}%`
      );
    }
  }
  const { count, error: countError } = await countQuery;
  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

  // Find every lead matching the current filters with an overdue or due-today follow-up,
  // across the WHOLE filtered set (not just this page), so they always surface on page 1
  // instead of being buried behind more recently created leads that fill up the default
  // created_at-desc page before any per-page reordering gets a chance to run.
  let priorityQuery = supabase
    .from("activities")
    .select("lead_id, follow_up_date, leads!inner(id)")
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null)
    .lte("follow_up_date", `${today}T23:59:59.999`);

  if (!include_archived) priorityQuery = priorityQuery.is("leads.archived_at", null);
  if (status) priorityQuery = priorityQuery.eq("leads.status", status);
  if (sources.length > 0) priorityQuery = priorityQuery.in("leads.source", sources);
  if (assigned_to) priorityQuery = priorityQuery.eq("leads.assigned_to", assigned_to);
  if (rating) priorityQuery = priorityQuery.eq("leads.rating", rating);
  if (location_id) priorityQuery = priorityQuery.eq("leads.location_id", location_id);
  if (search) {
    if (search.startsWith("#")) {
      priorityQuery = priorityQuery.eq("leads.id", search.slice(1));
    } else {
      priorityQuery = priorityQuery.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,mobile.ilike.%${search}%,company.ilike.%${search}%`,
        { referencedTable: "leads" }
      );
    }
  }
  priorityQuery = priorityQuery.order("follow_up_date", { ascending: true });

  const { data: priorityRows, error: priorityError } = await priorityQuery;
  if (priorityError) {
    return NextResponse.json({ error: priorityError.message }, { status: 500 });
  }

  const priorityIds: string[] = [];
  const seenPriorityIds = new Set<string>();
  for (const row of (priorityRows || []) as { lead_id: string }[]) {
    if (!seenPriorityIds.has(row.lead_id)) {
      seenPriorityIds.add(row.lead_id);
      priorityIds.push(row.lead_id);
    }
  }

  // Merge: overdue/due-today leads occupy the front of the combined ordering, then the
  // rest of the filtered leads fill in behind them in the requested sort order.
  const pageEnd = offset + limit;
  const prioritySliceIds = priorityIds.slice(
    Math.min(offset, priorityIds.length),
    Math.min(pageEnd, priorityIds.length)
  );
  const restNeeded = limit - prioritySliceIds.length;
  const restOffset = Math.max(0, offset - priorityIds.length);

  let priorityLeads: LeadRow[] = [];
  if (prioritySliceIds.length > 0) {
    const { data, error } = await supabase
      .from("leads")
      .select(LEAD_SELECT)
      .in("id", prioritySliceIds);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const byId = new Map(((data || []) as LeadRow[]).map((l) => [l.id, l]));
    priorityLeads = prioritySliceIds
      .map((id) => byId.get(id))
      .filter((l): l is LeadRow => !!l);
  }

  let restLeads: LeadRow[] = [];
  if (restNeeded > 0) {
    let restQuery = supabase.from("leads").select(LEAD_SELECT);
    if (!include_archived) restQuery = restQuery.is("archived_at", null);
    if (status) restQuery = restQuery.eq("status", status);
    if (sources.length > 0) restQuery = restQuery.in("source", sources);
    if (assigned_to) restQuery = restQuery.eq("assigned_to", assigned_to);
    if (rating) restQuery = restQuery.eq("rating", rating);
    if (location_id) restQuery = restQuery.eq("location_id", location_id);
    if (search) {
      if (search.startsWith("#")) {
        restQuery = restQuery.eq("id", search.slice(1));
      } else {
        restQuery = restQuery.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,mobile.ilike.%${search}%,company.ilike.%${search}%`
        );
      }
    }
    if (priorityIds.length > 0) {
      restQuery = restQuery.not("id", "in", `(${priorityIds.join(",")})`);
    }

    const ascending = sort_order === "asc";
    const { data, error } = await restQuery
      .order(sort_by, { ascending })
      .range(restOffset, restOffset + restNeeded - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    restLeads = (data || []) as LeadRow[];
  }

  attachFollowupFlags(priorityLeads);
  attachFollowupFlags(restLeads);

  // Within the "rest" group (no overdue/due-today items — those were already pulled out
  // above), still float upcoming-followup leads ahead of leads with no followup at all.
  restLeads.sort((a, b) => {
    const priority = (f: LeadRow["_followup"]) => (f?.upcoming ? 0 : 1);
    return priority(a._followup) - priority(b._followup);
  });

  const leads = [...priorityLeads, ...restLeads];

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

    // WhatsApp alert to the lead's owner only — skip if they created it themselves
    if (data.assigned_to && data.assigned_to !== dbUser.id) {
      (async () => {
        const { data: owner } = await supabase
          .from("users")
          .select("phone")
          .eq("id", data.assigned_to)
          .single();

        if (owner?.phone) {
          const leadName = `${data.first_name} ${data.last_name}`.trim();
          const company  = data.company ?? "—";
          const source   = data.source  ?? "direct";

          messaging.internalNewLead(owner.phone, leadName, company, source, data.id)
            .catch(console.error);
        }
      })();
    }
  }

  return NextResponse.json({ data }, { status: 201 });
}
