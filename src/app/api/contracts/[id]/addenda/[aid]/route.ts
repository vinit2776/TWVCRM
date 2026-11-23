import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getActor } from "@/lib/addendum/server";
import {
  applyChanges, canApproveAddendum, canAuthorAddendum, canSealAddendum, findPlaceholders, isEditable,
  type ChangeOfNameParams,
} from "@/lib/addendum/change-of-name";

type Ctx = { params: Promise<{ id: string; aid: string }> };

/** GET: one addendum with its revisions and, for the apply step, what would change on the customer record. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id, aid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;

  const { data: addendum } = await supabase.from("contract_addenda").select("*").eq("id", aid).eq("contract_id", id).single();
  if (!addendum) return NextResponse.json({ error: "Addendum not found" }, { status: 404 });
  const { data: revisions } = await supabase
    .from("contract_addendum_revisions")
    .select("revision, source, created_at, created_by_user:users!contract_addendum_revisions_created_by_fkey(full_name)")
    .eq("addendum_id", aid)
    .order("revision", { ascending: false });

  const { data: contract } = await supabase
    .from("contracts")
    .select("lead:leads!contracts_lead_id_fkey(company, gst_number, pan_number, entity_type)")
    .eq("id", id)
    .single();
  const lead = (Array.isArray(contract?.lead) ? contract?.lead[0] : contract?.lead) ?? {};
  const preview = applyChanges(addendum.params as ChangeOfNameParams, lead).rows;

  return NextResponse.json({ data: { addendum, revisions: revisions ?? [], applyPreview: preview } });
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), text: z.string().trim().min(50, "The wording is too short") }),
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("approve"), note: z.string().trim().optional() }),
  z.object({ action: z.literal("send_back"), note: z.string().trim().min(5, "Say what to change") }),
  z.object({ action: z.literal("withdraw") }),
  z.object({ action: z.literal("apply") }),
]);

/** PATCH: one state change per call, each guarded by role and by the current status. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id, aid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const { data: a } = await admin.from("contract_addenda").select("*").eq("id", aid).eq("contract_id", id).single();
  if (!a) return NextResponse.json({ error: "Addendum not found" }, { status: 404 });

  const now = new Date().toISOString();
  const audit = (action: string, extra?: Record<string, { old: unknown; new: unknown }>) =>
    logAudit(admin, { entityType: "contract", entityId: id, action: "update", performedBy: actor.id, changes: { addendum_action: { old: null, new: `ADD-${a.addendum_number} ${action}` }, ...extra } });

  // Moves status only if it still is what we read, so two people cannot act on the same stage.
  const move = async (from: string[], patch: Record<string, unknown>) => {
    const { data, error } = await admin
      .from("contract_addenda")
      .update({ ...patch, updated_at: now })
      .eq("id", aid)
      .in("status", from)
      .select("*")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "This addendum was just changed by someone else. Reload and try again." }, { status: 409 });
    return NextResponse.json({ data });
  };

  switch (body.action) {
    case "save": {
      if (!canAuthorAddendum(actor.role)) return NextResponse.json({ error: "Your role cannot edit an addendum" }, { status: 403 });
      if (!isEditable(a.status)) return NextResponse.json({ error: "The wording is locked once it is submitted." }, { status: 409 });
      const revision = a.revision + 1;
      const res = await move(["draft", "changes_requested"], { current_text: body.text, revision });
      if (res.status !== 200) return res;
      await admin.from("contract_addendum_revisions").insert({ addendum_id: aid, revision, text: body.text, source: "edit", created_by: actor.id });
      audit("edited");
      return res;
    }
    case "submit": {
      if (!canAuthorAddendum(actor.role)) return NextResponse.json({ error: "Your role cannot submit an addendum" }, { status: 403 });
      const open = findPlaceholders(a.current_text);
      if (open.length) return NextResponse.json({ error: `Fill in ${open.join(", ")} before submitting.`, placeholders: open }, { status: 400 });
      const res = await move(["draft", "changes_requested"], { status: "pending_approval", decision_note: null });
      if (res.status === 200) audit("submitted");
      return res;
    }
    case "approve": {
      if (!canApproveAddendum(actor.role)) return NextResponse.json({ error: "Only a manager or admin can approve" }, { status: 403 });
      if (a.created_by === actor.id && actor.role !== "admin") return NextResponse.json({ error: "You cannot approve your own draft. Ask another manager or an admin." }, { status: 403 });
      const res = await move(["pending_approval"], { status: "approved", decided_by: actor.id, decided_at: now, decision_note: body.note || null });
      if (res.status === 200) audit("approved");
      return res;
    }
    case "send_back": {
      if (!canApproveAddendum(actor.role)) return NextResponse.json({ error: "Only a manager or admin can send it back" }, { status: 403 });
      const res = await move(["pending_approval"], { status: "changes_requested", decided_by: actor.id, decided_at: now, decision_note: body.note });
      if (res.status === 200) audit("sent back");
      return res;
    }
    case "withdraw": {
      if (!canAuthorAddendum(actor.role)) return NextResponse.json({ error: "Your role cannot withdraw an addendum" }, { status: 403 });
      const res = await move(["draft", "pending_approval", "changes_requested", "approved", "signed"], { status: "withdrawn" });
      if (res.status === 200) audit("withdrawn");
      return res;
    }
    case "apply": {
      if (!canSealAddendum(actor.role)) return NextResponse.json({ error: "Only an admin can apply the name change" }, { status: 403 });
      if (a.status !== "sealed") return NextResponse.json({ error: "Apply is available once the signed copy is stamped and sealed." }, { status: 409 });
      const { data: contract } = await admin.from("contracts").select("lead_id").eq("id", id).single();
      if (!contract?.lead_id) return NextResponse.json({ error: "This contract has no customer record" }, { status: 400 });
      const { data: lead } = await admin.from("leads").select("id, company, gst_number, pan_number, entity_type").eq("id", contract.lead_id).single();
      if (!lead) return NextResponse.json({ error: "Customer record not found" }, { status: 404 });

      const { next, rows } = applyChanges(a.params as ChangeOfNameParams, lead);
      // Claim the status first so a double click cannot apply twice.
      const res = await move(["sealed"], { status: "applied", applied_by: actor.id, applied_at: now });
      if (res.status !== 200) return res;
      const { error: leadErr } = await admin.from("leads").update(next).eq("id", lead.id);
      if (leadErr) {
        await admin.from("contract_addenda").update({ status: "sealed", applied_by: null, applied_at: null }).eq("id", aid);
        return NextResponse.json({ error: `Could not update the customer record: ${leadErr.message}` }, { status: 500 });
      }
      const changes = Object.fromEntries(rows.map((r) => [`lead_${r.field}`, { old: r.before, new: r.after }]));
      logAudit(admin, { entityType: "lead", entityId: lead.id, action: "update", performedBy: actor.id, changes });
      audit("applied", changes);
      return res;
    }
  }
}
