import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { applyDraftWatermark, isDraftAgreement } from "@/lib/draft-watermark";
import { buildAgreementEmail, parseCcList, type AgreementEmailCase } from "@/lib/case-agreement-email";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const SEND_ROLES = ["admin", "manager", "sales_rep"];

const CASE_SELECT =
  "id, case_number, client_name, client_company_name, client_email, client_phone, " +
  "aggregator_id, bill_to, " +
  "aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone), " +
  "location:locations!cases_location_id_fkey(name)";

const AGREEMENT_SELECT =
  "id, status, signed_document_id, stamp_reference, " +
  "generated_document:documents!case_agreements_generated_document_id_fkey(file_path, file_name), " +
  "signed_document:documents!case_agreements_signed_document_id_fkey(file_path, file_name)";

type DocRef = { file_path: string; file_name: string };
type AgreementRow = {
  id: string;
  status: string | null;
  signed_document_id: string | null;
  stamp_reference: string | null;
  generated_document: DocRef | DocRef[] | null;
  signed_document: DocRef | DocRef[] | null;
};

const first = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

async function load(caseId: string) {
  const admin = await createAdminClient();
  const { data: caseRow } = await admin
    .from("cases").select(CASE_SELECT).eq("id", caseId).maybeSingle();
  const { data: agreementRow } = await admin
    .from("case_agreements").select(AGREEMENT_SELECT)
    .eq("case_id", caseId).eq("type", "leave_license")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return { admin, caseRow, agreement: agreementRow as unknown as AgreementRow | null };
}

/**
 * GET — what would be sent: recipient, subject, body and attachment name.
 *
 * The dialog renders this verbatim so the preview cannot drift from the send;
 * both call the same builder.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { caseRow, agreement } = await load(caseId);
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!agreement) {
    return NextResponse.json({ error: "No leave & license agreement found" }, { status: 404 });
  }

  const email = buildAgreementEmail(caseRow as unknown as AgreementEmailCase);
  const doc = first(agreement.signed_document) ?? first(agreement.generated_document);
  const draft = isDraftAgreement(agreement);

  return NextResponse.json({
    data: {
      ...email,
      agreementStatus: agreement.status,
      attachmentName: doc
        ? (draft ? `DRAFT-${doc.file_name}` : doc.file_name)
        : null,
      isDraft: draft,
      hasPdf: !!doc?.file_path,
    },
  });
}

/** POST — send it, then record that it went out. */
export async function POST(request: NextRequest, { params }: Params) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !SEND_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to send agreements" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { cc?: string | string[] };
  const { emails: cc, invalid } = parseCcList(body.cc);
  if (invalid.length) {
    return NextResponse.json(
      { error: `Not a valid email address: ${invalid.join(", ")}` },
      { status: 400 },
    );
  }

  const { admin, caseRow, agreement } = await load(caseId);
  if (!caseRow) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  if (!agreement) {
    return NextResponse.json({ error: "No leave & license agreement found" }, { status: 404 });
  }
  if (agreement.status === "executed") {
    return NextResponse.json(
      { error: "This agreement is already executed." },
      { status: 400 },
    );
  }

  const email = buildAgreementEmail(caseRow as unknown as AgreementEmailCase);
  if (email.blocked || !email.to) {
    return NextResponse.json({ error: email.blocked ?? "No recipient" }, { status: 400 });
  }

  const doc = first(agreement.signed_document) ?? first(agreement.generated_document);
  if (!doc?.file_path) {
    return NextResponse.json(
      { error: "No PDF has been generated for this agreement yet." },
      { status: 400 },
    );
  }

  const { data: file, error: dlError } = await admin.storage
    .from("crm-documents").download(doc.file_path);
  if (dlError || !file) {
    return NextResponse.json({ error: "Failed to read the agreement PDF" }, { status: 500 });
  }

  // Same treatment as View PDF: the stored object stays clean, the watermark
  // is composited on the way out, so an unexecuted copy is never circulated
  // without being marked as one.
  const original = new Uint8Array(await file.arrayBuffer());
  const draft = isDraftAgreement(agreement);
  const bytes = draft ? await applyDraftWatermark(original) : original;
  const filename = draft ? `DRAFT-${doc.file_name}` : doc.file_name;

  const { error: sendError } = await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: [email.to],
    ...(cc.length ? { cc } : {}),
    subject: email.subject,
    html: email.html,
    attachments: [{ filename, content: Buffer.from(bytes), contentType: "application/pdf" }],
  });

  if (sendError) {
    console.error(`[agreement-send] case ${caseId}: ${sendError.message}`);
    return NextResponse.json({ error: `Could not send: ${sendError.message}` }, { status: 502 });
  }

  // Only recorded once the send actually succeeded — a status saying it went
  // out when it did not is worse than no status at all.
  await admin
    .from("case_agreements")
    .update({
      status: agreement.status === "executed" ? agreement.status : "sent_to_client",
      sent_to_client_at: new Date().toISOString(),
      sent_to_email: email.to,
    })
    .eq("id", agreement.id);

  logAudit(supabase, {
    entityType: "case",
    entityId: caseId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      agreement_sent: {
        old: agreement.status,
        new: `sent to ${email.toKind}: ${email.to}${cc.length ? ` (cc ${cc.join(", ")})` : ""}`,
      },
    },
  });

  return NextResponse.json({
    data: { to: email.to, toName: email.toName, cc, attachmentName: filename },
  });
}
