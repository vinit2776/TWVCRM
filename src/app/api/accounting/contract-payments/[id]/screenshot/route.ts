import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

  // Validate file size (10MB max)
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File size must be under 10MB" }, { status: 400 });
  }

  // Upload to Supabase storage
  const ext = file.name.split(".").pop() || "png";
  const filePath = `payment-screenshots/contract-${id}-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, file, { contentType: file.type });

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
