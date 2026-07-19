import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isInboxRole } from "@/lib/tally-handoff";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/accounting/inbox/deposits/[kind]/[id]/account
 *
 * Uploads the Tally receipt PDF for a deposit (kind=deposit → proposals,
 * kind=topup → deposit_topups) and marks it accounted in the same action —
 * there's no way to mark a deposit accounted without attaching proof
 * (enforced server-side here and by a DB CHECK constraint).
 *
 * DELETE reopens a mistakenly-accounted row — admin only, requires a reason.
 */

type Kind = "deposit" | "topup";

function isKind(v: string): v is Kind {
  return v === "deposit" || v === "topup";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params;
  if (!isKind(kind)) return NextResponse.json({ error: "Unknown kind" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !isInboxRole(actor.role)) {
    return NextResponse.json({ error: "Not authorised to account for deposits" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return NextResponse.json({ error: "The Tally receipt PDF is required" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
  const path = `deposits/${kind}/${id}/tally-receipt-${Date.now()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(path, buffer, { contentType: file.type || "application/pdf", upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  const { data: urlData } = supabase.storage.from("crm-documents").getPublicUrl(path);
  let proofPath: string | null = urlData?.publicUrl || null;
  if (!proofPath) {
    const { data: signed } = await supabase.storage.from("crm-documents").createSignedUrl(path, 60 * 60 * 24 * 365);
    proofPath = signed?.signedUrl || null;
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  if (kind === "deposit") {
    const { data: proposal, error } = await admin
      .from("proposals")
      .update({
        deposit_accounted: true,
        deposit_accounted_at: now,
        deposit_accounted_by: actor.id,
        deposit_accounted_proof_path: proofPath,
      })
      .eq("id", id)
      .eq("deposit_payment_status", "paid")
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!proposal) return NextResponse.json({ error: "Deposit not found or not paid" }, { status: 404 });

    await logAudit(admin, {
      entityType: "proposal",
      entityId: id,
      action: "deposit_accounted",
      performedBy: actor.id,
      changes: { deposit_accounted: { old: false, new: true }, proof_path: { old: null, new: proofPath } },
    });
  } else {
    const { data: topup, error } = await admin
      .from("deposit_topups")
      .update({
        accounted: true,
        accounted_at: now,
        accounted_by: actor.id,
        accounted_proof_path: proofPath,
      })
      .eq("id", id)
      .eq("status", "paid")
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!topup) return NextResponse.json({ error: "Top-up not found or not paid" }, { status: 404 });

    await logAudit(admin, {
      entityType: "deposit_topup",
      entityId: id,
      action: "deposit_accounted",
      performedBy: actor.id,
      changes: { accounted: { old: false, new: true }, proof_path: { old: null, new: proofPath } },
    });
  }

  return NextResponse.json({ data: { id, kind, proof_path: proofPath } });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params;
  if (!isKind(kind)) return NextResponse.json({ error: "Unknown kind" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Only admin can reopen an accounted deposit" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "A reason is required" }, { status: 400 });

  const admin = createAdminClient();
  const table = kind === "deposit" ? "proposals" : "deposit_topups";
  const accountedField = kind === "deposit" ? "deposit_accounted" : "accounted";
  const accountedAtField = kind === "deposit" ? "deposit_accounted_at" : "accounted_at";
  const accountedByField = kind === "deposit" ? "deposit_accounted_by" : "accounted_by";
  const proofField = kind === "deposit" ? "deposit_accounted_proof_path" : "accounted_proof_path";

  const { error } = await admin
    .from(table)
    .update({
      [accountedField]: false,
      [accountedAtField]: null,
      [accountedByField]: null,
      [proofField]: null,
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(admin, {
    entityType: kind === "deposit" ? "proposal" : "deposit_topup",
    entityId: id,
    action: "deposit_accounting_reopened",
    performedBy: actor.id,
    changes: { [accountedField]: { old: true, new: false }, reason: { old: null, new: reason } },
  });

  return NextResponse.json({ data: { id, kind, accounted: false } });
}
