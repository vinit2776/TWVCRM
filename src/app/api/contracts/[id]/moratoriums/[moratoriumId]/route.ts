import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const ActionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  authorization_note: z.string().optional(),
});

// PATCH /api/contracts/[id]/moratoriums/[moratoriumId] — approve or reject
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; moratoriumId: string }> }
) {
  const { id: contractId, moratoriumId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Resolve auth user → internal users.id and check role
  const { data: profile } = await admin
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!profile || !["admin", "manager"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Only admin or manager can approve or reject moratoriums" },
      { status: 403 }
    );
  }

  const body = await req.json();
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { action, authorization_note } = parsed.data;

  // Load the moratorium
  const { data: moratorium } = await admin
    .from("contract_billing_moratoriums")
    .select("*")
    .eq("id", moratoriumId)
    .eq("contract_id", contractId)
    .single();

  if (!moratorium) {
    return NextResponse.json({ error: "Moratorium not found" }, { status: 404 });
  }
  if (moratorium.status !== "pending") {
    return NextResponse.json(
      { error: `Moratorium is already ${moratorium.status}` },
      { status: 422 }
    );
  }

  // On approval: re-validate the month hasn't been billed since the request was made
  if (action === "approve") {
    const { data: statement } = await admin
      .from("billing_statements")
      .select("id")
      .eq("contract_id", contractId)
      .eq("period_start", moratorium.moratorium_month)
      .in("status", ["finalized", "exported"])
      .maybeSingle();

    if (statement) {
      return NextResponse.json(
        { error: "A billing statement was finalized for this month since the request was made. Cannot approve." },
        { status: 422 }
      );
    }
  }

  const newStatus = action === "approve" ? "approved" : "rejected";

  const { data: updated, error } = await admin
    .from("contract_billing_moratoriums")
    .update({
      status: newStatus,
      authorized_by: profile.id,
      authorized_at: new Date().toISOString(),
      authorization_note: authorization_note ?? null,
    })
    .eq("id", moratoriumId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const auditAction = action === "approve" ? "moratorium_approved" : "moratorium_rejected";
  await logAudit(admin, {
    entityType: "contract_billing_moratorium",
    entityId: moratoriumId,
    action: auditAction,
    performedBy: profile.id,
    changes: {
      status: { old: "pending", new: newStatus },
      ...(authorization_note ? { note: { old: null, new: authorization_note } } : {}),
    },
  });

  return NextResponse.json(updated);
}
