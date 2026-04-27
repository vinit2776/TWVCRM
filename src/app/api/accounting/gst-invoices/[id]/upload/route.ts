import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";

// POST — Upload GST invoice PDF, auto-extract invoice number from filename
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params; // contract_payment ID
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Fetch payment to get contract_id
  const { data: payment } = await supabase
    .from("contract_payments")
    .select("id, contract_id, gst_invoice_number")
    .eq("id", id)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const manualInvoiceNumber = formData.get("gst_invoice_number") as string | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Validate file type (PDF or image)
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json({ error: "Only PDF and image files are allowed" }, { status: 400 });
  }

  // Normalize upload (images → JPEG Q82 @ 2048px, PDF pass-through, hard cap 50MB).
  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Try to extract invoice number from filename
  // Patterns like: INV-2025-001.pdf, GST-INV-123.pdf, TWVINV2025001.pdf
  let extractedInvoiceNumber = manualInvoiceNumber?.trim() || payment.gst_invoice_number || null;
  if (!extractedInvoiceNumber) {
    const filenameWithoutExt = file.name.replace(/\.[^.]+$/, "");
    // Simple pattern: if filename looks like an invoice number, use it
    const invoicePatterns = [
      /^(INV[-_]?\d{4}[-_]\d{3,4})$/i,
      /^(GST[-_]?INV[-_]?\d+)$/i,
      /^([A-Z]{2,5}[-_]?\d{4,}[-_]?\d{0,4})$/i,
    ];
    for (const pattern of invoicePatterns) {
      const match = filenameWithoutExt.match(pattern);
      if (match) {
        extractedInvoiceNumber = match[1].toUpperCase();
        break;
      }
    }
    // If no pattern matched, use the filename as-is (cleaned)
    if (!extractedInvoiceNumber && filenameWithoutExt.length <= 50) {
      extractedInvoiceNumber = filenameWithoutExt;
    }
  }

  // Upload to Supabase storage (normalized buffer, not raw file)
  const timestamp = Date.now();
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const filePath = `gst-invoices/${payment.contract_id}/${timestamp}-${baseName}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // Update payment record
  const updates: Record<string, unknown> = {
    gst_invoice_path: filePath,
    gst_invoice_status: "invoiced",
  };
  if (extractedInvoiceNumber) {
    updates.gst_invoice_number = extractedInvoiceNumber;
  }

  const { data: updated, error: updateError } = await supabase
    .from("contract_payments")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Generate signed URL for immediate download
  const { data: signedUrl } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(filePath, 3600); // 1 hour validity

  logAudit(supabase, {
    entityType: "contract_payment",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      gst_invoice_path: { old: null, new: filePath },
      gst_invoice_status: { old: null, new: "invoiced" },
    },
  });

  return NextResponse.json({
    data: updated,
    download_url: signedUrl?.signedUrl || null,
    extracted_invoice_number: extractedInvoiceNumber,
  });
}
