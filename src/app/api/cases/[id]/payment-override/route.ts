import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { isMissingColumn } from "@/lib/vo-draft-gate";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), reason: z.string().trim().min(10, "Give a reason of at least 10 characters") }),
  z.object({ action: z.literal("clear") }),
]);

/**
 * POST /api/cases/[id]/payment-override  (admin only)
 *
 * Sets or clears an override of the VO execution payment gate. The gate itself
 * lives in checkVoExecutionPaymentGate, so every execution path honours it.
 * The override does not release a clean (un-watermarked) copy.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can override the payment gate" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const admin = await createAdminClient();
  const update =
    parsed.data.action === "set"
      ? {
          payment_override_reason: parsed.data.reason,
          payment_override_by: dbUser.id,
          payment_override_at: new Date().toISOString(),
        }
      : { payment_override_reason: null, payment_override_by: null, payment_override_at: null };

  const { data: before } = await admin
    .from("cases").select("payment_override_reason").eq("id", caseId).maybeSingle();
  const { data: updated, error } = await admin
    .from("cases").update(update).eq("id", caseId).select("id").maybeSingle();

  if (error) {
    if (isMissingColumn(error)) {
      return NextResponse.json({ error: "The payment override is not available yet (migration pending)" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  logAudit(supabase, {
    entityType: "case",
    entityId: caseId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_override: {
        old: (before as { payment_override_reason?: string | null } | null)?.payment_override_reason ?? null,
        new: parsed.data.action === "set" ? parsed.data.reason : null,
      },
    },
  });

  return NextResponse.json({ data: { active: parsed.data.action === "set" } });
}
