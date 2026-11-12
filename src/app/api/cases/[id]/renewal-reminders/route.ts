import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * PATCH /api/cases/[id]/renewal-reminders — switch the daily renewal job on or
 * off for one Virtual Office case.
 *
 * Every case that predates the end-date backfill (00525) is off, because those
 * end dates were derived rather than agreed with anyone. Turning one on says a
 * person has confirmed the end date with the client or partner, so enabling
 * needs that date typed back and fails if it has moved since the page loaded.
 * Turning it off needs nothing.
 */

const ALLOWED_ROLES = ["admin", "manager"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), confirm_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ enabled: z.literal(false) }),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin or manager can change automatic renewal reminders" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;

  const admin = await createAdminClient();
  const { data: c } = await admin
    .from("cases")
    .select("id, status, end_date, renewal_notices_enabled")
    .eq("id", id)
    .maybeSingle();
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  if (body.enabled) {
    if (!c.end_date) return NextResponse.json({ error: "This case has no end date to confirm." }, { status: 400 });
    if (!["active", "renewal_due", "grace_period"].includes(c.status as string)) {
      return NextResponse.json({ error: "Reminders only apply to a live case." }, { status: 400 });
    }
    if (String(c.end_date).slice(0, 10) !== body.confirm_end_date) {
      return NextResponse.json({ error: "The end date changed while this was open. Reload and try again." }, { status: 409 });
    }
  }

  if (c.renewal_notices_enabled === body.enabled) {
    return NextResponse.json({ data: { enabled: body.enabled } });
  }

  const { error } = await admin.from("cases").update({ renewal_notices_enabled: body.enabled }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: body.enabled ? "renewal_reminders_enabled" : "renewal_reminders_disabled" },
      renewal_notices_enabled: { old: c.renewal_notices_enabled, new: body.enabled },
      ...(body.enabled ? { confirmed_end_date: { old: null, new: body.confirm_end_date } } : {}),
    },
  });
  return NextResponse.json({ data: { enabled: body.enabled } });
}
