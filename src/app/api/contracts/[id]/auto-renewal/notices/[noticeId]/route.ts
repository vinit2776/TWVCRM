import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { AUTO_RENEW_MANAGE_ROLES } from "@/lib/auto-renewal";
import { isValidEmail } from "@/lib/auto-renewal-notice";
import { sendNotice, type NoticeRow } from "@/lib/auto-renewal-notice-server";

const edits = {
  subject: z.string().trim().min(1, "A subject is required").max(300).optional(),
  body: z.string().trim().min(1, "The message cannot be empty").max(8000).optional(),
  recipients: z.array(z.string().trim()).max(10).optional(),
};

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), ...edits }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("unapprove") }),
  z.object({ action: z.literal("cancel") }),
  /** Send now by hand, applying any edits first. */
  z.object({ action: z.literal("send"), ...edits }),
]);

async function actor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  return dbUser ?? null;
}

/**
 * PATCH /api/contracts/[id]/auto-renewal/notices/[noticeId]
 *
 * edit     change the subject, message or recipients (an approved notice goes back to draft)
 * approve  a person has read it; the daily job sends it on its day
 * unapprove  take it back to draft
 * cancel   drop it
 * send     email it now, by hand, with any edits applied first
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; noticeId: string }> },
) {
  const { id, noticeId } = await params;
  const me = await actor();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(AUTO_RENEW_MANAGE_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admins, managers and sales reps can change notices." }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("auto_renewal_notices")
    .select("*")
    .eq("id", noticeId)
    .eq("contract_id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  const notice = row as NoticeRow;

  const { data: contract } = await admin.from("contracts").select("status").eq("id", id).maybeSingle();
  if (!contract || !["active", "renewal_in_progress"].includes(contract.status)) {
    return NextResponse.json({ error: "Notices apply to live contracts." }, { status: 400 });
  }
  if (["sent", "sending", "cancelled"].includes(notice.status)) {
    return NextResponse.json({ error: `This notice is ${notice.status} and can no longer be changed.` }, { status: 409 });
  }

  const now = new Date().toISOString();

  // Applies subject / message / recipients, returning the update fields or an error.
  const applyEdits = (e: { subject?: string; body?: string; recipients?: string[] }) => {
    const fields: Record<string, unknown> = {};
    if (e.subject !== undefined) fields.subject = e.subject;
    if (e.body !== undefined) fields.body = e.body;
    if (e.recipients !== undefined) {
      const bad = e.recipients.filter((r) => !isValidEmail(r));
      if (bad.length > 0) return { error: `Not a valid email address: ${bad[0]}` };
      fields.recipients = e.recipients;
    }
    return { fields };
  };

  if (body.action === "edit" || body.action === "send") {
    const r = applyEdits(body);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    if (Object.keys(r.fields).length > 0) {
      const { error } = await admin
        .from("auto_renewal_notices")
        .update({
          ...r.fields,
          edited: true,
          // Any change to an approved notice needs a fresh approval, unless it is going out right now.
          ...(body.action === "edit" && notice.status === "approved"
            ? { status: "draft", approved_by: null, approved_at: null }
            : {}),
          updated_at: now,
        })
        .eq("id", noticeId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      logAudit(admin, {
        entityType: "contract", entityId: id, action: "auto_renewal_notice_edited", performedBy: me.id,
        changes: { notice: { old: null, new: `${notice.kind}: ${Object.keys(r.fields).join(", ")} changed` } },
      });
    }
    if (body.action === "edit") return NextResponse.json({ success: true });

    const sent = await sendNotice(admin, noticeId, { actorId: me.id, source: "manual" });
    if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 400 });
    return NextResponse.json({ success: true, sentTo: sent.sentTo, skippedOnStaging: sent.skippedOnStaging });
  }

  if (body.action === "approve") {
    if (notice.status !== "draft") {
      return NextResponse.json({ error: "Only a draft can be approved." }, { status: 409 });
    }
    if (!notice.recipients.some(isValidEmail)) {
      return NextResponse.json({ error: "Add at least one valid recipient email before approving." }, { status: 400 });
    }
    const { error } = await admin
      .from("auto_renewal_notices")
      .update({ status: "approved", approved_by: me.id, approved_at: now, updated_at: now })
      .eq("id", noticeId)
      .eq("status", "draft");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    logAudit(admin, {
      entityType: "contract", entityId: id, action: "auto_renewal_notice_approved", performedBy: me.id,
      changes: { notice: { old: "draft", new: `approved ${notice.kind}, goes out ${notice.send_on}` } },
    });
    return NextResponse.json({ success: true });
  }

  if (body.action === "unapprove") {
    if (notice.status !== "approved") return NextResponse.json({ error: "This notice is not approved." }, { status: 409 });
    const { error } = await admin
      .from("auto_renewal_notices")
      .update({ status: "draft", approved_by: null, approved_at: null, updated_at: now })
      .eq("id", noticeId)
      .eq("status", "approved");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  const { error } = await admin
    .from("auto_renewal_notices")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", noticeId)
    .in("status", ["draft", "approved", "failed"]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logAudit(admin, {
    entityType: "contract", entityId: id, action: "auto_renewal_notice_cancelled", performedBy: me.id,
    changes: { notice: { old: notice.status, new: `cancelled ${notice.kind}` } },
  });
  return NextResponse.json({ success: true });
}
