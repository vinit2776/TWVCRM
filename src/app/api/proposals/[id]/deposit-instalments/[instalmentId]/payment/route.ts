import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { canRecordPayments } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import { instalmentErrorMessage } from "@/lib/deposit-instalments";
import { cancelRazorpayLink } from "@/lib/deposit-instalment-server";
import { sendPartEmail } from "@/lib/deposit-instalment-email-server";

/**
 * POST /api/proposals/[id]/deposit-instalments/[instalmentId]/payment
 *
 * Records a manually verified payment (bank transfer etc.) against ONE asked
 * part. multipart/form-data: amount, reference?, payment_medium?, notes (≥10
 * chars, internal), payment_proof? (file).
 *
 * The amount must equal what was asked. If the customer paid something else,
 * cancel that request and ask for the right figure — a part is never recorded
 * as short, so the totals always add up.
 *
 * The 10% "short by approval" allowance of the single-payment route does not
 * apply here; it stays on the single-deposit path.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; instalmentId: string }> },
) {
  const { id, instalmentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!actor || !canRecordPayments(actor.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can record a deposit payment. Use \"Report paid\" to tell accounts about one." },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const amount = parseFloat((form.get("amount") as string | null) || "");
  const reference = (form.get("reference") as string | null)?.trim() || null;
  const medium = (form.get("payment_medium") as string | null)?.trim() || null;
  const notes = (form.get("notes") as string | null)?.trim() || null;
  const proof = form.get("payment_proof") as File | null;

  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valid payment amount is required" }, { status: 400 });
  }
  if (!notes || notes.length < 10) {
    return NextResponse.json({ error: "Add an internal note (at least 10 characters) so accounts can book this correctly" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("proposal_deposit_instalments")
    .select("id, seq, amount, status, razorpay_link_id")
    .eq("id", instalmentId)
    .eq("proposal_id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Deposit part not found" }, { status: 404 });
  if (row.status !== "requested") {
    return NextResponse.json({ error: instalmentErrorMessage("not_open") }, { status: 409 });
  }
  if (Math.abs(Number(row.amount) - amount) > 0.001) {
    return NextResponse.json(
      { error: `The amount must match this request (₹${Number(row.amount).toLocaleString("en-IN")}). If the customer paid a different amount, cancel this request and ask for the right one.` },
      { status: 400 },
    );
  }

  let proofUrl: string | null = null;
  if (proof && proof.size > 0) {
    const ext = proof.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `proposals/${id}/deposit-part-${row.seq}-proof-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("crm-documents")
      .upload(path, Buffer.from(await proof.arrayBuffer()), { contentType: proof.type || "application/octet-stream", upsert: false });
    if (upErr) {
      console.error("[deposit-instalments] proof upload error:", upErr);
    } else {
      const { data: pub } = supabase.storage.from("crm-documents").getPublicUrl(path);
      proofUrl = pub?.publicUrl || null;
      if (!proofUrl) {
        const { data: signed } = await supabase.storage.from("crm-documents").createSignedUrl(path, 60 * 60 * 24 * 365);
        proofUrl = signed?.signedUrl || null;
      }
    }
  }

  const { data: res, error } = await admin.rpc("record_deposit_instalment_paid", {
    p_instalment_id: instalmentId,
    p_amount: amount,
    p_reference: reference,
    p_medium: medium,
    p_paid_at: new Date().toISOString(),
    p_screenshot: proofUrl,
    p_recorded_by: actor.id,
    p_notes: notes,
  });
  if (error || !res?.success) {
    console.error("[deposit-instalments] record failed:", error?.message || res?.error);
    return NextResponse.json({ error: instalmentErrorMessage(res?.error) }, { status: error ? 500 : 409 });
  }

  // Paid offline: the open link must not stay payable.
  await cancelRazorpayLink(admin, row.razorpay_link_id);

  void logAudit(admin, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      deposit_part_paid: { old: null, new: { seq: row.seq, amount, reference, medium } },
      deposit_total_paid: { old: null, new: res.paid },
      ...(res.complete ? { deposit_complete: { old: false, new: true } } : {}),
    },
  });

  // Confirm to the customer with the running breakup. Best effort: the payment is
  // already recorded, so a failed email is logged (communications_log) not surfaced as an error.
  const receipt = await sendPartEmail(admin, { instalmentId, kind: "received", sentBy: actor.id }).catch(() => null);

  return NextResponse.json({ data: { instalment_id: instalmentId, receipt_emailed: !!receipt?.ok, paid: res.paid, required: res.required, complete: !!res.complete } });
}
