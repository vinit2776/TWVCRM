import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";

// POST — upload payment screenshot
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify payment exists
  const { data: payment } = await supabase
    .from("contract_payments")
    .select("id, contract_id, payment_mode")
    .eq("id", id)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Validate file type
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Only image files are allowed" }, { status: 400 });
  }

  // Normalize (image → JPEG Q82 @ 2048px, 50MB hard cap).
  let normalized;
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const filePath = `payment-screenshots/contract-${id}-${Date.now()}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // Update payment record with screenshot path
  const { data: updated, error: updateError } = await supabase
    .from("contract_payments")
    .update({ screenshot_path: filePath })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ data: updated });
}
