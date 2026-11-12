import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { loadJourney } from "@/lib/journey/load";

const MARK_ROLES = ["admin", "manager", "sales_rep", "floor_manager", "office_admin", "coordinator"];
const UNDO_ROLES = ["admin", "manager"];

async function authorise(roles: string[]) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !roles.includes(dbUser.role)) {
    return { error: NextResponse.json({ error: "You don't have permission to do this." }, { status: 403 }) } as const;
  }
  return { supabase, dbUser } as const;
}

/**
 * POST /api/contracts/[id]/welcome-done
 *
 * Staff confirm the customer has been welcomed (last customer-journey step).
 * Records who/when only — it sends nothing to the customer. Refused until the
 * journey says the step is ready (contract active, WiFi and door access done).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorise(MARK_ROLES);
  if ("error" in auth) return auth.error;
  const { supabase, dbUser } = auth;

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead_id, welcome_done_at")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (contract.welcome_done_at) return NextResponse.json({ data: { welcome_done_at: contract.welcome_done_at } });

  const journey = await loadJourney(createAdminClient(), contract.lead_id, { contractId: id });
  const step = journey?.phases.flatMap((p) => p.steps).find((s) => s.key === "welcome_done");
  if (!step || step.state === "blocked") {
    return NextResponse.json({ error: step?.hint ?? "This step isn't ready yet." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("contracts")
    .update({ welcome_done_at: now, welcome_done_by: dbUser.id })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { action: { old: null, new: "welcome_marked_done" }, welcome_done_at: { old: null, new: now } },
  });

  return NextResponse.json({ data: { welcome_done_at: now } });
}

/** DELETE — undo a mistaken mark. Admin/manager only. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorise(UNDO_ROLES);
  if ("error" in auth) return auth.error;
  const { supabase, dbUser } = auth;

  const { error } = await supabase
    .from("contracts")
    .update({ welcome_done_at: null, welcome_done_by: null })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { action: { old: "welcome_marked_done", new: null } },
  });

  return NextResponse.json({ data: { welcome_done_at: null } });
}
