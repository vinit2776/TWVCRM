import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createActivitySchema } from "@/lib/validations";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";

export async function GET(
  _request: NextRequest,
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

  const { data, error } = await supabase
    .from("activities")
    .select("*, creator:users!activities_created_by_fkey(*), follow_up_actor:users!activities_follow_up_actioned_by_fkey(*)")
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}

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

  const body = await request.json();
  const result = createActivitySchema.safeParse({ ...body, lead_id: id });

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  const { data, error } = await supabase
    .from("activities")
    .insert({
      ...result.data,
      created_by: dbUser?.id,
    })
    .select("*, creator:users!activities_created_by_fkey(*)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Auto-claim the lead to whoever logged the activity.
  // Transfers ownership even if another user had previously claimed it.
  // Skips if the user already owns the lead or the lead is resolved.
  if (dbUser?.id) {
    const { data: oldLead } = await supabase
      .from("leads")
      .select("claimed_by, claimed_at, resolved_at")
      .eq("id", id)
      .single();

    const alreadyOwner = oldLead?.claimed_by === dbUser.id;
    const isResolved = oldLead?.resolved_at != null;

    if (!alreadyOwner && !isResolved) {
      const claimedAt = new Date().toISOString();
      const { error: claimError } = await supabase
        .from("leads")
        .update({ claimed_by: dbUser.id, claimed_at: claimedAt })
        .eq("id", id);

      if (claimError) {
        console.error("auto-claim failed", claimError.code, claimError.message);
      } else {
        logAudit(supabase, {
          entityType: "lead",
          entityId: id,
          action: "update",
          performedBy: dbUser.id,
          changes: {
            claimed_by: { old: oldLead?.claimed_by ?? null, new: dbUser.id },
            claimed_at: { old: oldLead?.claimed_at ?? null, new: claimedAt },
          },
        });
      }
    }
  }

  // Auto-advance lead status based on activity type:
  // - tour activities drive tour_scheduled / tour_completed
  // - all others drive new → contacted
  if (result.data.type === "tour") {
    await autoUpdateLeadStatus(supabase, id, "tour", {
      meetingEndAt: result.data.meeting_end_at ?? null,
    });
  } else {
    await autoUpdateLeadStatus(supabase, id, "activity");
  }

  return NextResponse.json({ data }, { status: 201 });
}
