import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getActor } from "@/lib/addendum/server";
import { appOrigin, clientIp, customerLink, loadNocSettings, recordNocEvent } from "@/lib/noc/server";
import { reconcileNocPaid } from "@/lib/noc/payment-sync";
import { canVoidNoc, isVoidable, nocReference, type NocStatus } from "@/lib/noc/rules";

type Ctx = { params: Promise<{ id: string; nid: string }> };

/** GET: one order with its audit trail (read-only). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });

  let { data: noc } = await supabase
    .from("noc_requests")
    .select("*, location:locations!noc_requests_location_id_fkey(id, name)")
    .eq("id", nid).eq("contract_id", id).single();
  if (!noc) return NextResponse.json({ error: "NOC not found" }, { status: 404 });
  if (await reconcileNocPaid(noc)) {
    ({ data: noc } = await supabase.from("noc_requests").select("*, location:locations!noc_requests_location_id_fkey(id, name)").eq("id", nid).eq("contract_id", id).single());
    if (!noc) return NextResponse.json({ error: "NOC not found" }, { status: 404 });
  }
  const { data: contract } = await supabase.from("contracts").select("contract_number, end_date").eq("id", id).single();
  const { data: events } = await supabase
    .from("noc_audit_events")
    .select("id, event, actor_label, detail, created_at")
    .eq("noc_id", nid)
    .order("created_at", { ascending: true });
  const { data: invoice } = noc.invoice_id
    ? await supabase.from("proforma_invoices").select("invoice_number, status, total_amount, due_date").eq("id", noc.invoice_id).maybeSingle()
    : { data: null };
  // Staff can see the customer link; the raw token stays out of the order object.
  const { public_token: token, ...order } = noc;
  return NextResponse.json({
    data: {
      noc: { ...order, reference: nocReference(contract?.contract_number ?? "", noc.sequence_in_contract) },
      validUntil: contract?.end_date ?? null,
      events: events ?? [],
      invoice: invoice ?? null,
      customerLink: noc.invoice_id ? customerLink(appOrigin(req.url), token) : null,
    },
  });
}

const bodySchema = z.object({ action: z.literal("void"), reason: z.string().trim().min(5, "Say why it is being voided") });

/** PATCH: void an unpaid order. A paid or issued one cannot be voided here (a refund is a manual accounts step). */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;
  if (!canVoidNoc(actor.role)) return NextResponse.json({ error: "Your role cannot void a NOC" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });
  const { data: noc } = await admin.from("noc_requests").select("id, noc_number, status").eq("id", nid).eq("contract_id", id).single();
  if (!noc) return NextResponse.json({ error: "NOC not found" }, { status: 404 });
  if (!isVoidable(noc.status as NocStatus)) {
    return NextResponse.json({ error: noc.status === "void" ? "This NOC is already void." : "A NOC that is paid or issued cannot be voided here. Ask accounts about a refund." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("noc_requests")
    .update({ status: "void", void_reason: parsed.data.reason, voided_by: actor.id, voided_at: now, updated_at: now })
    .eq("id", nid)
    .in("status", ["draft", "sent", "accepted"])
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "This NOC was just changed by someone else. Reload and try again." }, { status: 409 });

  await recordNocEvent(admin, nid, "voided", { actorId: actor.id, actorLabel: actor.name, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent"), detail: { reason: parsed.data.reason, was: noc.status } });
  logAudit(admin, { entityType: "contract", entityId: id, action: "update", performedBy: actor.id, changes: { noc_voided: { old: noc.noc_number, new: parsed.data.reason } } });
  return NextResponse.json({ data });
}
