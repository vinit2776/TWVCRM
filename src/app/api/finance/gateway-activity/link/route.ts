import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["admin", "manager", "accounts"];

const linkSchema = z.object({
  razorpay_payment_id: z.string().min(1),
  entity_type: z.enum(["contract", "booking", "billing_statement"]),
  entity_id: z.string().uuid(),
  notes: z.string().max(500).optional(),
});

const unlinkSchema = z.object({
  razorpay_payment_id: z.string().min(1),
});

async function getUser(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) return null;
  return dbUser as { id: string; role: string };
}

/**
 * POST /api/finance/gateway-activity/link
 * Create or update a manual link for a Razorpay payment.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const dbUser = await getUser(supabase);
  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const { razorpay_payment_id, entity_type, entity_id, notes } = parsed.data;
  const admin = createAdminClient();

  // Check for existing link to determine action (linked vs relinked)
  const { data: existing } = await admin
    .from("razorpay_manual_links")
    .select("entity_type, entity_id, notes")
    .eq("razorpay_payment_id", razorpay_payment_id)
    .maybeSingle();

  const action = existing ? "relinked" : "linked";

  // Upsert the link
  const { error: upsertErr } = await admin
    .from("razorpay_manual_links")
    .upsert({
      razorpay_payment_id,
      entity_type,
      entity_id,
      notes: notes ?? null,
      linked_by: dbUser.id,
      linked_at: new Date().toISOString(),
    }, { onConflict: "razorpay_payment_id" });

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // Log the action
  await admin.from("razorpay_manual_link_logs").insert({
    razorpay_payment_id,
    action,
    old_entity_type: existing?.entity_type ?? null,
    old_entity_id:   existing?.entity_id   ?? null,
    old_notes:       existing?.notes        ?? null,
    new_entity_type: entity_type,
    new_entity_id:   entity_id,
    new_notes:       notes ?? null,
    performed_by:    dbUser.id,
  });

  await logAudit(supabase, {
    entityType: "invoice",
    entityId:   razorpay_payment_id,
    action:     action === "linked" ? "create" : "update",
    performedBy: dbUser.id,
    changes: {
      entity_type: { old: existing?.entity_type ?? null, new: entity_type },
      entity_id:   { old: existing?.entity_id   ?? null, new: entity_id },
      notes:       { old: existing?.notes        ?? null, new: notes ?? null },
    },
  });

  return NextResponse.json({ success: true, action });
}

/**
 * DELETE /api/finance/gateway-activity/link
 * Remove a manual link (unlink), preserving the log entry.
 */
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const dbUser = await getUser(supabase);
  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = unlinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const { razorpay_payment_id } = parsed.data;
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("razorpay_manual_links")
    .select("entity_type, entity_id, notes")
    .eq("razorpay_payment_id", razorpay_payment_id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "No link found" }, { status: 404 });
  }

  const { error: delErr } = await admin
    .from("razorpay_manual_links")
    .delete()
    .eq("razorpay_payment_id", razorpay_payment_id);

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  await admin.from("razorpay_manual_link_logs").insert({
    razorpay_payment_id,
    action:          "unlinked",
    old_entity_type: existing.entity_type,
    old_entity_id:   existing.entity_id,
    old_notes:       existing.notes,
    new_entity_type: null,
    new_entity_id:   null,
    new_notes:       null,
    performed_by:    dbUser.id,
  });

  await logAudit(supabase, {
    entityType: "invoice",
    entityId:   razorpay_payment_id,
    action:     "deleted",
    performedBy: dbUser.id,
    changes: {
      entity_type: { old: existing.entity_type, new: null },
      entity_id:   { old: existing.entity_id,   new: null },
    },
  });

  return NextResponse.json({ success: true });
}

/**
 * GET /api/finance/gateway-activity/link?payment_id=pay_xxx
 * Fetch the current link + full history for a payment.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const paymentId = new URL(request.url).searchParams.get("payment_id");
  if (!paymentId) return NextResponse.json({ error: "payment_id required" }, { status: 400 });

  const admin = createAdminClient();

  const [{ data: link }, { data: logs }] = await Promise.all([
    admin
      .from("razorpay_manual_links")
      .select("*")
      .eq("razorpay_payment_id", paymentId)
      .maybeSingle(),
    admin
      .from("razorpay_manual_link_logs")
      .select("*, users:performed_by(full_name)")
      .eq("razorpay_payment_id", paymentId)
      .order("performed_at", { ascending: false }),
  ]);

  return NextResponse.json({ link, logs: logs ?? [] });
}
