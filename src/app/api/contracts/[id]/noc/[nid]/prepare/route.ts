import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { appOrigin, loadNocSettings } from "@/lib/noc/server";
import { canOrderNoc } from "@/lib/noc/rules";
import { prepareNocInvoice } from "@/lib/noc/prepare";

/**
 * POST /api/contracts/[id]/noc/[nid]/prepare
 * Creates the proforma invoice for the fee (once) and returns the customer link, so staff can share it by hand.
 * Sends nothing to anyone.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  if (!canOrderNoc(who.actor.role)) return NextResponse.json({ error: "Your role cannot send a NOC to a customer" }, { status: 403 });
  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });
  const { data: own } = await admin.from("noc_requests").select("id").eq("id", nid).eq("contract_id", id).maybeSingle();
  if (!own) return NextResponse.json({ error: "NOC not found" }, { status: 404 });

  const r = await prepareNocInvoice(admin, nid, appOrigin(req.url), who.actor);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ data: { link: r.link, created: r.created, invoiceId: r.bundle.noc.invoice_id, statementId: r.bundle.noc.billing_statement_id } });
}
