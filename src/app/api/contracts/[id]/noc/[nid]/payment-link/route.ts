import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/addendum/server";
import { appOrigin, loadNocSettings } from "@/lib/noc/server";
import { canOrderNoc } from "@/lib/noc/rules";
import { loadNocBundle } from "@/lib/noc/bundle";
import { ensureGatewayLink } from "@/lib/noc/accept";

/** POST: retry creating the gateway link for an order the customer has accepted (it failed the first time, or online payment was off). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; nid: string }> }) {
  const { id, nid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  if (!canOrderNoc(who.actor.role)) return NextResponse.json({ error: "Your role cannot do this" }, { status: 403 });
  const admin = createAdminClient();
  if (!(await loadNocSettings(admin)).enabled) return NextResponse.json({ error: "The NOC service is not switched on." }, { status: 403 });
  const b = await loadNocBundle(admin, { id: nid });
  if (!b || b.noc.contract_id !== id) return NextResponse.json({ error: "NOC not found" }, { status: 404 });
  if (!b.noc.accepted_at) return NextResponse.json({ error: "The customer has not accepted the terms yet, so there is nothing to pay." }, { status: 409 });
  if (b.noc.status === "paid" || b.noc.status === "issued" || b.noc.status === "void") return NextResponse.json({ error: "No payment link is needed." }, { status: 409 });
  const r = await ensureGatewayLink(admin, b, appOrigin(req.url), who.actor);
  if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.reason === "disabled" ? 422 : 502 });
  return NextResponse.json({ data: { url: r.url } });
}
