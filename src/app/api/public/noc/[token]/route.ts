import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { loadNocBundle } from "@/lib/noc/bundle";
import { clientIp, recordNocEvent } from "@/lib/noc/server";
import { maskEmail } from "@/lib/noc/acceptance";
import { publicView } from "@/lib/noc/accept";
import { reconcileNocPaid } from "@/lib/noc/payment-sync";

export const dynamic = "force-dynamic";

const fmtYmd = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * GET /api/public/noc/[token]  (no sign-in: the long random token is the key)
 * What the customer's NOC page shows. Opening it is recorded in the audit trail (not when `?poll=1`, which the page
 * uses while waiting for the payment to land). A link that was never prepared answers like a link that does not exist.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,128}$/.test(token)) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  const admin = createAdminClient();
  let b = await loadNocBundle(admin, { token });
  if (!b || !b.noc.invoice_id) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  if (await reconcileNocPaid(b.noc)) b = (await loadNocBundle(admin, { token })) ?? b;
  if (b.noc.status === "void") return NextResponse.json({ error: "This link is no longer active. Please contact The WorkVilla." }, { status: 410 });

  const poll = new URL(req.url).searchParams.get("poll") === "1";
  if (!poll) {
    const { data: lastOpen } = await admin.from("noc_audit_events").select("created_at").eq("noc_id", b.noc.id).eq("event", "link_opened").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!lastOpen || Date.now() - new Date(lastOpen.created_at).getTime() > 10 * 60_000) {
      await recordNocEvent(admin, b.noc.id, "link_opened", { actorLabel: "customer", ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") });
    }
    // Opened from a link staff shared by hand: it is out with the customer now.
    if (b.noc.status === "draft") {
      await admin.from("noc_requests").update({ status: "sent", sent_at: b.noc.sent_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", b.noc.id).eq("status", "draft");
      b.noc.status = "sent";
    }
  }

  const email = b.noc.sent_to || b.lead?.email || null;
  const { data: inv } = await admin.from("proforma_invoices").select("invoice_number").eq("id", b.noc.invoice_id).maybeSingle();
  const paid = b.noc.status === "paid" || b.noc.status === "issued";
  const view = publicView(b, {
    codeDestination: email ? maskEmail(email) : null,
    payUrl: b.noc.accepted_at && !paid && b.noc.razorpay_link_url ? b.noc.razorpay_link_url : null,
    linkProblem: b.noc.accepted_at && !paid && !b.noc.razorpay_link_url ? "The payment page could not be opened just now. Please contact The WorkVilla and we will send you a payment link." : null,
    invoiceNumber: inv?.invoice_number ?? null,
    validUntilLabel: fmtYmd(b.contract.end_date),
  });
  return NextResponse.json({ data: view });
}
