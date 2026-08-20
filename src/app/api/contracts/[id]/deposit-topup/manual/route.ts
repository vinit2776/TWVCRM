import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import { canRecordPayments } from "@/lib/constants";

// Recording money already received — same gate as every other payment.
const VALID_CATEGORIES = ["seat_expansion", "risk_buffer", "customer_requested", "renewal_escalation", "other"];

/**
 * POST /api/contracts/[id]/deposit-topup/manual — records additional
 * deposit money already received offline. Mirrors
 * proposals/[id]/deposit-payment/route.ts's proof-upload pattern exactly,
 * minus the shortfall-tolerance-check logic (not relevant here — this IS
 * the shortfall collection mechanism, not a proposal accepting a short
 * payment).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, full_name, role").eq("auth_id", user.id).single();
  if (!actor || !canRecordPayments(actor.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can record an additional deposit" },
      { status: 403 },
    );
  }

  const formData = await request.formData();
  const amount = parseFloat((formData.get("amount") as string | null) || "");
  const category = (formData.get("category") as string | null) || "";
  const categoryNote = (formData.get("category_note") as string | null)?.trim() || null;
  const paymentMode = (formData.get("payment_mode") as string | null)?.trim() || null;
  const reference = (formData.get("payment_reference") as string | null)?.trim() || null;
  const appliesToShortfall = formData.get("applies_to_shortfall") === "true";
  const proofFile = formData.get("proof") as File | null;

  if (!amount || isNaN(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "A valid category is required" }, { status: 400 });
  }
  if (!categoryNote || categoryNote.length < 10) {
    return NextResponse.json({ error: "Add an internal note (at least 10 characters) so accounts can book this correctly" }, { status: 400 });
  }
  if (!paymentMode) {
    return NextResponse.json({ error: "Payment mode is required" }, { status: 400 });
  }

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email)")
    .eq("id", contractId)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  let proofPath: string | null = null;
  if (proofFile && proofFile.size > 0) {
    const ext = proofFile.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `contracts/${contractId}/deposit-topup-proof-${Date.now()}.${ext}`;
    const buffer = Buffer.from(await proofFile.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(path, buffer, { contentType: proofFile.type || "application/octet-stream", upsert: false });

    if (uploadError) {
      console.error("[deposit-topup/manual] storage upload error:", uploadError);
    } else {
      const { data: urlData } = supabase.storage.from("crm-documents").getPublicUrl(path);
      proofPath = urlData?.publicUrl || null;
      if (!proofPath) {
        const { data: signed } = await supabase.storage.from("crm-documents").createSignedUrl(path, 60 * 60 * 24 * 365);
        proofPath = signed?.signedUrl || null;
      }
    }
  }

  const admin = createAdminClient();
  const { data: rpcResult, error: rpcError } = await admin.rpc("record_deposit_topup_manual", {
    p_contract_id: contractId,
    p_amount: amount,
    p_category: category,
    p_category_note: categoryNote,
    p_payment_mode: paymentMode,
    p_payment_reference: reference,
    p_proof_path: proofPath,
    p_applies_to_shortfall: appliesToShortfall,
    p_created_by: actor.id,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not record top-up" }, { status: 422 });
  }

  await logAudit(admin, {
    entityType: "deposit_topup",
    entityId: result.topup_id,
    action: "deposit_topup_recorded",
    performedBy: actor.id,
    changes: {
      amount: { old: null, new: amount },
      category: { old: null, new: category },
      contract_id: { old: null, new: contractId },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const customerEmail = lead?.email;
  const customerName = lead ? (lead.company || `${lead.first_name || ""} ${lead.last_name || ""}`.trim()) : "Customer";

  if (customerEmail) {
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [customerEmail],
      subject: `Additional Security Deposit Received — ${contract.contract_number} — The WorkVilla`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Payment Confirmation</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">We have received your additional security deposit for contract <strong>${contract.contract_number}</strong>. Thank you!</p>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0;">
              <p style="color:#166534;font-size:13px;font-weight:700;margin:0 0 12px;">✅ PAYMENT RECEIVED</p>
              <table style="border-collapse:collapse;width:100%;">
                <tr><td style="padding:6px 0;color:#555;font-size:13px;width:45%;">Contract</td><td style="padding:6px 0;font-weight:bold;color:#015E65;font-size:13px;">${contract.contract_number}</td></tr>
                <tr><td style="padding:6px 0;color:#555;font-size:13px;">Amount Received</td><td style="padding:6px 0;font-weight:bold;color:#166534;font-size:16px;">₹${amount.toLocaleString("en-IN")}</td></tr>
                ${reference ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Reference</td><td style="padding:6px 0;font-family:monospace;color:#333;font-size:13px;">${reference}</td></tr>` : ""}
              </table>
            </div>
            <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla Team</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>`,
    }).catch(console.error);
  }

  return NextResponse.json({ data: { id: result.topup_id }, confirmation_email_sent: !!customerEmail });
}
