import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { clientIp, loadNocSettings, recordNocEvent } from "@/lib/noc/server";
import { canOrderNoc } from "@/lib/noc/rules";

/** POST: staff copied or shared the customer link by hand. Written to the audit trail so the tracking stays complete. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  if (!canOrderNoc(who.actor.role)) return NextResponse.json({ error: "Your role cannot share a NOC link" }, { status: 403 });
  const parsed = z.object({ channel: z.enum(["copy", "whatsapp", "other"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });
  const { data: own } = await admin.from("noc_requests").select("id, invoice_id").eq("id", nid).eq("contract_id", id).maybeSingle();
  if (!own || !own.invoice_id) return NextResponse.json({ error: "Prepare the link first." }, { status: 409 });
  await recordNocEvent(admin, nid, "link_shared", { actorId: who.actor.id, actorLabel: who.actor.name, ip: clientIp(req.headers), detail: { channel: parsed.data.channel } });
  return NextResponse.json({ data: { logged: true } });
}
