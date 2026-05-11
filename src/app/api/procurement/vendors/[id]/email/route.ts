import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { recordFix } from "@/lib/finance-intelligence";
import { z } from "zod";

const schema = z.object({
  contact_email: z.string().trim().email("Invalid email format"),
});

/**
 * PATCH /api/procurement/vendors/[id]/email
 *
 * Updates ONLY the contact_email field. Used by the nag banner's inline
 * editor (and the bulk audit page) to fix vendor email gaps in one click.
 *
 * Side-effects:
 *   1. Standard audit log entry
 *   2. Closes any open 'shown' / 'dismissed' rows for this vendor in
 *      finance_suggestion_log by inserting a 'fixed' marker — so the
 *      effectiveness dashboard can credit the nag for the conversion.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data: existing } = await supabase
    .from("procurement_vendors")
    .select("id, contact_email")
    .eq("id", id)
    .single();
  if (!existing) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });

  const oldEmail = existing.contact_email ?? null;
  const newEmail = parsed.data.contact_email;

  const { error } = await supabase
    .from("procurement_vendors")
    .update({ contact_email: newEmail })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "procurement_vendor",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { contact_email: { old: oldEmail, new: newEmail } },
  });

  // Credit the nag if there was no prior email (this is the fix moment)
  if (!oldEmail) {
    await recordFix(supabase, id, dbUser.id, newEmail);
  }

  return NextResponse.json({ ok: true, contact_email: newEmail });
}
