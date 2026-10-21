import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateDiscontinuationDraftsForCase } from "@/lib/vo-discontinuation";
import { latestLapseDecision, LAPSE_DECISION_ROLES } from "@/lib/vo-lapse-decision";
import { formatDate } from "@/lib/utils";

/**
 * GET  /api/cases/[id]/discontinuation — the discontinuation drafts for a
 *      lapsed case, each with a short-lived link to preview its PDF.
 * POST /api/cases/[id]/discontinuation — act on them, one click at a time:
 *      - regenerate: redo every draft with a different effective date
 *        (only while all are still drafts)
 *      - approve: a client document is approved and emailed to the client in
 *        one step; an authority letter is approved for printing
 *      - record_post: the registered-post number of a posted authority letter
 *
 * Nothing is sent except by "approve" on a client document.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLIENT_DOCUMENTS = ["discontinuation_notice", "dos_donts"];
const DOCUMENT_LABELS: Record<string, string> = {
  discontinuation_notice: "Discontinuation notice",
  dos_donts: "Do's and don'ts",
  authority_letter: "Authority letter",
};

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("regenerate"), effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal("approve"), document_id: z.string().uuid() }),
  z.object({
    action: z.literal("record_post"),
    document_id: z.string().uuid(),
    tracking_number: z.string().trim().min(4, "Enter the registered-post number").max(60),
  }),
]);

const CASE_SELECT = "*, location:locations!cases_location_id_fkey(name, address, city, state)";

type DocRow = {
  id: string;
  document_type: string;
  authority_name: string | null;
  authority_address: string | null;
  document_path: string;
  status: "draft" | "approved" | "dispatched";
  approved_by: string | null;
  approved_at: string | null;
  dispatched_at: string | null;
  postal_tracking_number: string | null;
  created_at: string;
};

async function authorise() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { dbUser: dbUser as { id: string; role: string } };
}

function effectiveDateOf(c: Record<string, unknown>): string | null {
  const meta = c.metadata && typeof c.metadata === "object" ? (c.metadata as Record<string, unknown>) : {};
  return (meta.discontinuation_effective_date as string | undefined) ?? (c.end_date as string | null);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;

  const admin = await createAdminClient();
  const [{ data: c }, { data: docs }] = await Promise.all([
    admin.from("cases").select("id, status, end_date, client_email, metadata").eq("id", id).maybeSingle(),
    admin
      .from("vo_discontinuation_documents")
      .select("*")
      .eq("case_id", id)
      .order("created_at", { ascending: true }),
  ]);
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const docRows = (docs ?? []) as DocRow[];
  const approverIds = [...new Set(docRows.map((d) => d.approved_by).filter((v): v is string => !!v))];
  const { data: approvers } = approverIds.length
    ? await admin.from("users").select("id, full_name").in("id", approverIds)
    : { data: [] };
  const approverName = new Map(((approvers ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]));

  const rows = await Promise.all(
    docRows.map(async (d) => {
      const { data: signed } = await admin.storage.from("crm-documents").createSignedUrl(d.document_path, 3600);
      return {
        id: d.id,
        document_type: d.document_type,
        label: d.authority_name ?? DOCUMENT_LABELS[d.document_type] ?? d.document_type,
        goes_to: CLIENT_DOCUMENTS.includes(d.document_type) ? "Client" : d.authority_name,
        how: CLIENT_DOCUMENTS.includes(d.document_type) ? "email" : "post",
        status: d.status,
        approved_by: d.approved_by ? approverName.get(d.approved_by) ?? null : null,
        approved_at: d.approved_at,
        dispatched_at: d.dispatched_at,
        postal_tracking_number: d.postal_tracking_number,
        preview_url: signed?.signedUrl ?? null,
      };
    }),
  );

  return NextResponse.json({
    data: {
      status: c.status,
      client_email: c.client_email,
      effective_date: effectiveDateOf(c),
      can_act: LAPSE_DECISION_ROLES.includes(auth.dbUser.role),
      documents: rows,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const auth = await authorise();
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;
  if (!LAPSE_DECISION_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Only an admin or manager can approve discontinuation documents" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;

  const admin = await createAdminClient();
  const { data: caseData } = await admin.from("cases").select(CASE_SELECT).eq("id", id).maybeSingle();
  if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });
  const c = caseData as Record<string, unknown>;
  if (c.status !== "lapsed" || latestLapseDecision(c.metadata)?.decision !== "discontinue") {
    return NextResponse.json(
      { error: "Record the decision to discontinue on this case before acting on its documents." },
      { status: 409 },
    );
  }

  const { data: docData } = await admin.from("vo_discontinuation_documents").select("*").eq("case_id", id);
  const docs = (docData ?? []) as DocRow[];
  const now = new Date().toISOString();

  if (body.action === "regenerate") {
    if (docs.some((d) => d.status !== "draft")) {
      return NextResponse.json(
        { error: "A document has already been approved, so the effective date can't change now." },
        { status: 409 },
      );
    }
    const previous = effectiveDateOf(c);
    await generateDiscontinuationDraftsForCase(admin, c, body.effective_date);
    const { data: fresh } = await admin
      .from("vo_discontinuation_documents")
      .select("id")
      .eq("case_id", id)
      .not("id", "in", `(${docs.map((d) => d.id).join(",") || "00000000-0000-0000-0000-000000000000"})`);
    if (!fresh || fresh.length === 0) {
      return NextResponse.json({ error: "The documents could not be prepared again. Nothing was changed." }, { status: 500 });
    }
    if (docs.length > 0) {
      await admin.from("vo_discontinuation_documents").delete().in("id", docs.map((d) => d.id));
      await admin.storage.from("crm-documents").remove(docs.map((d) => d.document_path));
    }
    const meta = c.metadata && typeof c.metadata === "object" ? (c.metadata as Record<string, unknown>) : {};
    await admin
      .from("cases")
      .update({ metadata: { ...meta, discontinuation_effective_date: body.effective_date } })
      .eq("id", id);

    logAudit(admin, {
      entityType: "case",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        action: { old: null, new: "discontinuation_drafts_regenerated" },
        effective_date: { old: previous, new: body.effective_date },
      },
    });
    return NextResponse.json({ data: { regenerated: fresh.length } });
  }

  const doc = docs.find((d) => d.id === body.document_id);
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  const label = doc.authority_name ?? DOCUMENT_LABELS[doc.document_type] ?? doc.document_type;
  const isClientDoc = CLIENT_DOCUMENTS.includes(doc.document_type);

  if (body.action === "approve") {
    if (doc.status !== "draft") return NextResponse.json({ error: `${label} is already approved.` }, { status: 409 });
    const clientEmail = (c.client_email as string | null)?.trim() || null;
    if (isClientDoc && !clientEmail) {
      return NextResponse.json({ error: "This case has no client email on file. Add one before sending." }, { status: 400 });
    }

    // Claim the draft first so a double click can't email the client twice.
    const { data: claimed } = await admin
      .from("vo_discontinuation_documents")
      .update({ status: "approved", approved_by: dbUser.id, approved_at: now })
      .eq("id", doc.id)
      .eq("status", "draft")
      .select("id");
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({ error: `${label} is already approved.` }, { status: 409 });
    }

    if (isClientDoc) {
      const sent = await emailToClient(admin, c, doc, label, clientEmail!);
      if (!sent.ok) {
        await admin
          .from("vo_discontinuation_documents")
          .update({ status: "draft", approved_by: null, approved_at: null })
          .eq("id", doc.id);
        return NextResponse.json({ error: `The email could not be sent: ${sent.error}. The document is still a draft.` }, { status: 502 });
      }
      await admin
        .from("vo_discontinuation_documents")
        .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
        .eq("id", doc.id);
    }

    logAudit(admin, {
      entityType: "case",
      entityId: id,
      action: isClientDoc ? "email_sent" : "update",
      performedBy: dbUser.id,
      changes: {
        action: { old: null, new: isClientDoc ? "discontinuation_document_emailed" : "discontinuation_document_approved" },
        document: { old: null, new: label },
        ...(isClientDoc ? { sent_to: { old: null, new: "client email on file" } } : {}),
      },
    });
    return NextResponse.json({ data: { status: isClientDoc ? "dispatched" : "approved" } });
  }

  // record_post
  if (isClientDoc) return NextResponse.json({ error: "Client documents go by email, not post." }, { status: 400 });
  if (doc.status !== "approved") {
    return NextResponse.json(
      { error: doc.status === "draft" ? `Approve ${label} before recording its post number.` : `${label} is already recorded as posted.` },
      { status: 409 },
    );
  }
  const { data: posted } = await admin
    .from("vo_discontinuation_documents")
    .update({ status: "dispatched", dispatched_at: now, postal_tracking_number: body.tracking_number })
    .eq("id", doc.id)
    .eq("status", "approved")
    .select("id");
  if (!posted || posted.length === 0) {
    return NextResponse.json({ error: `${label} is already recorded as posted.` }, { status: 409 });
  }
  logAudit(admin, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "discontinuation_letter_posted" },
      document: { old: null, new: label },
      postal_tracking_number: { old: null, new: body.tracking_number },
    },
  });
  return NextResponse.json({ data: { status: "dispatched" } });
}

async function emailToClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  c: Record<string, unknown>,
  doc: DocRow,
  label: string,
  to: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: file, error: downloadError } = await admin.storage.from("crm-documents").download(doc.document_path);
  if (downloadError || !file) return { ok: false, error: "the PDF could not be read" };
  const content = Buffer.from(await (file as Blob).arrayBuffer()).toString("base64");

  const client = (c.client_company_name as string | null) || (c.client_name as string);
  const location = c.location as { name?: string } | null;
  const effective = effectiveDateOf(c);
  const subject = `${label}: Virtual Office at ${location?.name ?? "The WorkVilla"} (${c.case_number as string})`;
  const html = `
    <p>Dear ${client},</p>
    <p>Your Virtual Office agreement with The WorkVilla (case ${c.case_number as string}) was not renewed, and the services under it are discontinued${effective ? ` effective ${formatDate(effective)}` : ""}.</p>
    <p>Please find the ${label.toLowerCase()} attached.</p>
    <p>If you would like to renew, reply to this email and our team will help.</p>
    <p>Regards,<br/>The WorkVilla</p>
  `;
  const fileName = `${(c.case_number as string) || "case"}-${doc.document_type.replace(/_/g, "-")}.pdf`;
  try {
    const result = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [to],
      subject,
      html,
      attachments: [{ filename: fileName, content }],
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "send failed" };
  }
}
