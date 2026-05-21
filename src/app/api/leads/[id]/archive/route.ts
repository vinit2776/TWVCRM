import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// POST /api/leads/[id]/archive
// Disables (archives) or re-enables a lead. Admin/manager only.
// This is the safe alternative to DELETE — it never cascades.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || (dbUser.role !== "admin" && dbUser.role !== "manager")) {
    return NextResponse.json(
      { error: "Only admin or manager can disable a lead" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    archived?: boolean;
    reason?: string;
  };
  const archived = body.archived !== false; // default: disable

  const { data: oldLead } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .single();

  if (!oldLead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const updateData = archived
    ? {
        archived_at: new Date().toISOString(),
        archived_by: dbUser.id,
        archive_reason: body.reason?.trim() || null,
      }
    : { archived_at: null, archived_by: null, archive_reason: null };

  const { data, error } = await supabase
    .from("leads")
    .update(updateData)
    .eq("id", id)
    .select("*, assigned_user:users!leads_assigned_to_fkey(*), location:locations!leads_location_id_fkey(id, name, code)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "lead",
    entityId: id,
    action: archived ? "disable" : "enable",
    performedBy: dbUser.id,
    changes: {
      archived_at: {
        old: (oldLead as { archived_at?: string }).archived_at ?? null,
        new: updateData.archived_at,
      },
    },
  });

  return NextResponse.json({ data });
}
