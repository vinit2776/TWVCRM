import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { loadNocBundle } from "@/lib/noc/bundle";
import { appOrigin, clientIp, hashOtp, recordNocEvent, sha256 } from "@/lib/noc/server";
import { acceptedWordsCanonical, maskEmail, matchSignatory, otpVerifyDecision, validateAcceptance } from "@/lib/noc/acceptance";
import { buildAcceptanceCertificatePdf } from "@/lib/noc/certificate-pdf";
import { ensureGatewayLink } from "@/lib/noc/accept";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ code: z.string(), name: z.string(), designation: z.string(), ticks: z.array(z.boolean()) });
const fmtYmd = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * POST /api/public/noc/[token]/accept
 * The customer ticks every paragraph, gives their name and designation and the emailed code. If all is in order the
 * acceptance is recorded (words hash, person, time, IP, device), the acceptance certificate is made, and the gateway
 * link is created so the page can send them on to pay. Accepting twice is refused.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32,128}$/.test(token)) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Please fill in every field." }, { status: 400 });
  const input = parsed.data;
  const problems = validateAcceptance(input);
  if (problems.length) return NextResponse.json({ error: problems[0], errors: problems }, { status: 400 });

  const admin = createAdminClient();
  const b = await loadNocBundle(admin, { token });
  if (!b || !b.noc.invoice_id) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  const { noc } = b;
  if (noc.status === "void") return NextResponse.json({ error: "This link is no longer active." }, { status: 410 });
  if (noc.accepted_at || !["draft", "sent"].includes(noc.status)) return NextResponse.json({ error: "The terms are already accepted." }, { status: 409 });

  // ── the one-time code ──
  const { data: otp } = await admin.from("noc_otp_codes").select("id, code_hash, attempts, expires_at, verified_at, sent_to, created_at")
    .eq("noc_id", noc.id).is("verified_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const decision = otpVerifyDecision(otp, hashOtp(input.code, noc.id), Date.now());
  if (!decision.ok) {
    if (otp && decision.reason === "wrong") await admin.from("noc_otp_codes").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    await recordNocEvent(admin, noc.id, "code_rejected", { actorLabel: "customer", ip: clientIp(req.headers), userAgent: req.headers.get("user-agent"), detail: { reason: decision.reason } });
    return NextResponse.json({ error: decision.error }, { status: 400 });
  }
  const verifiedAt = new Date().toISOString();
  await admin.from("noc_otp_codes").update({ verified_at: verifiedAt }).eq("id", otp!.id);

  // ── record the acceptance, once ──
  const validUntilLabel = fmtYmd(b.contract.end_date);
  const textHash = sha256(acceptedWordsCanonical({ purpose: noc.purpose, company: noc.company_name, centre: b.centreName, address: noc.noc_address, feeTotal: b.total, validUntil: b.contract.end_date, agreementDate: (b.contract.agreement_date ?? b.contract.created_at ?? "").toString().slice(0, 10) || null }));
  const ip = clientIp(req.headers);
  const ua = req.headers.get("user-agent");
  const match = matchSignatory(input.name, b.contract.member_signatory_name);
  const acceptedAt = new Date().toISOString();
  const { data: claimed } = await admin.from("noc_requests").update({
    status: "accepted", accepted_at: acceptedAt, accepted_by_name: input.name.trim(), accepted_by_designation: input.designation.trim(),
    accepted_text_hash: textHash, accepted_ip: ip, accepted_user_agent: ua, sent_at: noc.sent_at ?? acceptedAt, updated_at: acceptedAt,
  }).eq("id", noc.id).in("status", ["draft", "sent"]).is("accepted_at", null).select("id").maybeSingle();
  if (!claimed) return NextResponse.json({ error: "The terms are already accepted." }, { status: 409 });

  await recordNocEvent(admin, noc.id, "code_verified", { actorLabel: "customer", ip, userAgent: ua, detail: { sent_to: maskEmail(otp!.sent_to) } });
  await recordNocEvent(admin, noc.id, "clauses_accepted", {
    actorLabel: `${input.name.trim()}, ${input.designation.trim()}`, ip, userAgent: ua,
    detail: { ticks: input.ticks, text_hash: textHash, text_version: "NOC-T1", signatory_match: match, recorded_signatory: b.contract.member_signatory_name },
  });

  // ── the acceptance certificate (evidence, made now and not changed afterwards) ──
  const { data: events } = await admin.from("noc_audit_events").select("event, created_at, actor_label").eq("noc_id", noc.id).order("created_at", { ascending: true });
  const firstOf = (name: string) => events?.find((e) => e.event === name)?.created_at ?? null;
  const emailed = events?.find((e) => e.event === "emailed");
  const pdf = buildAcceptanceCertificatePdf({
    certificateNo: `ACC-${noc.noc_number}`, reference: b.reference, nocNumber: noc.noc_number, purpose: noc.purpose, company: noc.company_name, centre: b.centreName,
    contractNumber: b.contract.contract_number, agreementDate: (b.contract.agreement_date ?? b.contract.created_at ?? "").toString().slice(0, 10) || null,
    validUntilLabel, typedName: input.name.trim(), typedDesignation: input.designation.trim(), signatory: { recorded: b.contract.member_signatory_name, match },
    codeSentTo: maskEmail(otp!.sent_to), codeSentAt: otp!.created_at, codeEnteredAt: verifiedAt,
    linkSentTo: noc.sent_to ? maskEmail(noc.sent_to) : null, linkSentBy: emailed?.actor_label ?? null, linkSentAt: emailed?.created_at ?? null,
    firstOpenedAt: firstOf("link_opened"), acceptedAt, ip, device: ua, textHash, feeTotal: b.total,
  });
  const path = `noc/${noc.id}/acceptance-${Date.now()}.pdf`;
  const up = await admin.storage.from("crm-documents").upload(path, pdf, { contentType: "application/pdf", upsert: false });
  if (!up.error) {
    const { data: doc } = await admin.from("documents").insert({
      title: `NOC acceptance certificate ${noc.noc_number}`, file_name: `ACC-${noc.noc_number}.pdf`, file_path: path, mime_type: "application/pdf",
      size_bytes: pdf.length, category: "noc_acceptance", tags: ["noc"], uploaded_by: null,
    }).select("id").single();
    if (doc) {
      await admin.from("noc_requests").update({ acceptance_document_id: doc.id }).eq("id", noc.id);
      await recordNocEvent(admin, noc.id, "acceptance_certificate_made", { actorLabel: "system", detail: { document_id: doc.id, bytes: pdf.length } });
    }
  } else {
    await recordNocEvent(admin, noc.id, "acceptance_certificate_failed", { actorLabel: "system", detail: { error: up.error.message } });
  }

  // ── the gateway link, so the page can send them on to pay ──
  const fresh = await loadNocBundle(admin, { id: noc.id });
  const link = fresh ? await ensureGatewayLink(admin, fresh, appOrigin(req.url)) : null;
  return NextResponse.json({ data: { accepted: true, payUrl: link && link.ok ? link.url : null, linkProblem: link && !link.ok ? "The payment page could not be opened just now. Please contact The WorkVilla and we will send you a payment link." : null } });
}
