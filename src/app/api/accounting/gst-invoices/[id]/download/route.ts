import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — Download GST invoice (returns signed URL)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch payment
  const { data: payment } = await supabase
    .from("contract_payments")
    .select("id, gst_invoice_path, gst_invoice_number")
    .eq("id", id)
    .single();

  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  if (!payment.gst_invoice_path) {
    return NextResponse.json({ error: "No GST invoice uploaded for this payment" }, { status: 404 });
  }

  // Create signed URL (valid for 1 hour)
  const { data: signedUrl, error: signedError } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(payment.gst_invoice_path, 3600);

  if (signedError || !signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      download_url: signedUrl.signedUrl,
      invoice_number: payment.gst_invoice_number,
      file_path: payment.gst_invoice_path,
    },
  });
}
