import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { getActor, reference } from "@/lib/addendum/server";
import { canAuthorAddendum, canSealAddendum } from "@/lib/addendum/change-of-name";

const MAX_BYTES = 12 * 1024 * 1024;

const signedSchema = z.object({ pdfBase64: z.string().min(1) });
const sealSchema = z.object({ pdfBase64: z.string().min(1), stampRef: z.string().min(1) });

function pdfBuffer(b64: string): Buffer | null {
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
  return buf.subarray(0, 5).toString("latin1") === "%PDF-" ? buf : null;
}

async function store(admin: ReturnType<typeof createAdminClient>, contractId: string, ref: string, kind: "signed" | "sealed", buf: Buffer, userId: string, parentId: string | null) {
  const path = `contract-addenda/${contractId}/${ref.replace("/", "-")}-${kind}-${Date.now()}.pdf`;
  const up = await admin.storage.from("crm-documents").upload(path, buf, { contentType: "application/pdf", upsert: false });
  if (up.error) return { error: `Storage upload failed: ${up.error.message}` };
  const { data: doc, error } = await admin
    .from("documents")
    .insert({
      title: `Addendum ${ref} (${kind === "signed" ? "customer signed" : "stamped & sealed"})`,
      file_name: `${ref.replace("/", "-")}-${kind}.pdf`,
      file_path: path,
      mime_type: "application/pdf",
      size_bytes: buf.length,
      category: "signed_contract",
      tags: ["addendum"],
      parent_document_id: parentId,
      uploaded_by: userId,
    })
    .select("id")
    .single();
  if (error || !doc) return { error: error?.message ?? "Could not record the document" };
  return { id: doc.id as string };
}

/** POST: the customer's signed copy (a PDF scan). Moves approved -> signed. Stamps nothing. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;
  if (!canAuthorAddendum(actor.role)) return NextResponse.json({ error: "Your role cannot upload the signed copy" }, { status: 403 });

  const parsed = signedSchema.safeParse(await req.json().catch(() => null));
  const buf = parsed.success ? pdfBuffer(parsed.data.pdfBase64) : null;
  if (!buf) return NextResponse.json({ error: "Upload a PDF of the signed addendum (up to 12 MB)." }, { status: 400 });

  const admin = createAdminClient();
  const { data: a } = await admin.from("contract_addenda").select("id, addendum_number, status").eq("id", aid).eq("contract_id", id).single();
  if (!a) return NextResponse.json({ error: "Addendum not found" }, { status: 404 });
  if (a.status !== "approved") return NextResponse.json({ error: "The signed copy can be uploaded once the addendum is approved." }, { status: 409 });
  const { data: contract } = await admin.from("contracts").select("contract_number").eq("id", id).single();
  const ref = reference(contract?.contract_number ?? "", a.addendum_number);

  const saved = await store(admin, id, ref, "signed", buf, actor.id, null);
  if ("error" in saved) return NextResponse.json({ error: saved.error }, { status: 500 });

  const { data, error } = await admin
    .from("contract_addenda")
    .update({ status: "signed", signed_document_id: saved.id, updated_at: new Date().toISOString() })
    .eq("id", aid).eq("status", "approved").select("*").maybeSingle();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "This addendum was just changed by someone else. Reload and try again." }, { status: 409 });
  logAudit(admin, { entityType: "contract", entityId: id, action: "update", performedBy: actor.id, changes: { addendum_action: { old: null, new: `${ref} customer signed copy uploaded` } } });
  return NextResponse.json({ data });
}

/** PUT: the same signed copy after TWV's signature and seal were placed on it (client-side, pdf-lib). Admin only. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await params;
  const supabase = await createClient();
  const who = await getActor(supabase);
  if ("error" in who) return who.error;
  const { actor } = who;
  if (!canSealAddendum(actor.role)) return NextResponse.json({ error: "Only an admin can stamp and seal" }, { status: 403 });

  const parsed = sealSchema.safeParse(await req.json().catch(() => null));
  const buf = parsed.success ? pdfBuffer(parsed.data.pdfBase64) : null;
  if (!parsed.success || !buf) return NextResponse.json({ error: "The stamped PDF is missing or invalid." }, { status: 400 });

  const admin = createAdminClient();
  const { data: a } = await admin.from("contract_addenda").select("id, addendum_number, status, signed_document_id").eq("id", aid).eq("contract_id", id).single();
  if (!a) return NextResponse.json({ error: "Addendum not found" }, { status: 404 });
  if (a.status !== "signed") return NextResponse.json({ error: "Stamp the addendum after the customer's signed copy is uploaded." }, { status: 409 });
  const { data: contract } = await admin.from("contracts").select("contract_number").eq("id", id).single();
  const ref = reference(contract?.contract_number ?? "", a.addendum_number);

  const saved = await store(admin, id, ref, "sealed", buf, actor.id, a.signed_document_id);
  if ("error" in saved) return NextResponse.json({ error: saved.error }, { status: 500 });

  const { data, error } = await admin
    .from("contract_addenda")
    .update({ status: "sealed", sealed_document_id: saved.id, stamp_reference: parsed.data.stampRef, updated_at: new Date().toISOString() })
    .eq("id", aid).eq("status", "signed").select("*").maybeSingle();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "This addendum was just changed by someone else. Reload and try again." }, { status: 409 });
  logAudit(admin, { entityType: "contract", entityId: id, action: "update", performedBy: actor.id, changes: { addendum_action: { old: null, new: `${ref} stamped and sealed (${parsed.data.stampRef})` } } });
  return NextResponse.json({ data });
}
